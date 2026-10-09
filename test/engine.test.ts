import { describe, expect, it } from "vitest";
import { evaluatePayment, toAtomic, formatAtomic, matchPattern, validatePolicy } from "../src/policy/engine.js";
import { InMemorySpendLedger } from "../src/policy/ledger.js";
import type { PaymentPolicyConfig, PaymentRequest } from "../src/policy/types.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const policy: PaymentPolicyConfig = {
  version: 1,
  allowedSchemes: ["exact"],
  assets: [{ network: "eip155:84532", address: USDC, symbol: "USDC", decimals: 6 }],
  roles: {
    researcher: {
      maxPerPayment: "0.05",
      dailyBudget: "0.10",
      approvalAbove: "0.02",
      allowedPayTo: [MERCHANT],
      allowedResources: ["https://api.example.com/*"],
    },
  },
};

const req = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  agentId: "a1",
  role: "researcher",
  resource: "https://api.example.com/weather",
  scheme: "exact",
  network: "eip155:84532",
  asset: USDC,
  amount: 10_000n, // 0.01 USDC
  payTo: MERCHANT,
  ...over,
});

describe("evaluatePayment", () => {
  it("allows a payment inside every limit", () => {
    expect(evaluatePayment(req(), policy, 0n).effect).toBe("allow");
  });

  it.each([
    ["UNKNOWN_ROLE", { role: "intern" }],
    ["SCHEME_NOT_ALLOWED", { scheme: "upto" }],
    ["ASSET_NOT_ALLOWED", { asset: "0x0000000000000000000000000000000000000001" }],
    ["ASSET_NOT_ALLOWED", { network: "eip155:8453" }], // right token address, wrong chain (mainnet)
    ["RESOURCE_NOT_ALLOWED", { resource: "https://evil.example.org/weather" }],
    ["PAYTO_NOT_ALLOWED", { payTo: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }],
    ["OVER_PER_PAYMENT_LIMIT", { amount: 50_001n }],
  ] as const)("denies with %s", (code, over) => {
    const d = evaluatePayment(req(over), policy, 0n);
    expect(d.effect).toBe("deny");
    expect(d.code).toBe(code);
  });

  it("matches recipient addresses case-insensitively", () => {
    expect(evaluatePayment(req({ payTo: MERCHANT.toLowerCase() }), policy, 0n).effect).toBe("allow");
  });

  it("allows exactly hitting the per-payment limit and the daily budget", () => {
    // 0.05 is above the approval threshold, so it asks rather than denies
    expect(evaluatePayment(req({ amount: 50_000n }), policy, 0n).effect).toBe("require_approval");
    expect(evaluatePayment(req({ amount: 10_000n }), policy, 90_000n).effect).toBe("allow");
  });

  it("denies once the rolling daily budget would be exceeded", () => {
    const d = evaluatePayment(req(), policy, 95_000n);
    expect(d.code).toBe("OVER_DAILY_BUDGET");
  });

  it("checks hard limits before asking a human", () => {
    // Over budget AND above approval threshold → deny, never bother a reviewer
    expect(evaluatePayment(req({ amount: 30_000n }), policy, 90_000n).code).toBe("OVER_DAILY_BUDGET");
  });
});

describe("amount helpers", () => {
  it("converts human and atomic units", () => {
    expect(toAtomic("0.05", 6)).toBe(50_000n);
    expect(toAtomic("1", 6)).toBe(1_000_000n);
    expect(formatAtomic(123_450n, 6)).toBe("0.12345");
    expect(() => toAtomic("0.0000001", 6)).toThrow();
    expect(() => toAtomic("-1", 6)).toThrow();
  });

  it("glob-matches resource patterns without regex injection", () => {
    expect(matchPattern("https://api.example.com/*", "https://api.example.com/a/b")).toBe(true);
    expect(matchPattern("https://api.example.com/*", "https://api-example.com/a")).toBe(false);
  });
});

describe("validatePolicy", () => {
  it("rejects a policy where approval could never trigger", () => {
    const bad = structuredClone(policy);
    bad.roles.researcher.approvalAbove = "1.00";
    expect(() => validatePolicy(bad)).toThrow(/approval can never trigger/);
  });
  it("rejects per-payment limit above daily budget", () => {
    const bad = structuredClone(policy);
    bad.roles.researcher.maxPerPayment = "5";
    expect(() => validatePolicy(bad)).toThrow(/larger than dailyBudget/);
  });
});

describe("InMemorySpendLedger", () => {
  it("counts reservations, keeps commits, drops releases, and forgets after the window", () => {
    const l = new InMemorySpendLedger(1000);
    const a = l.reserve("r", 10n, 0);
    const b = l.reserve("r", 20n, 0);
    expect(l.used("r", 0)).toBe(30n);
    l.commit(a, 100);
    l.release(b);
    expect(l.used("r", 100)).toBe(10n);
    expect(l.used("r", 1200)).toBe(0n);
  });
});
