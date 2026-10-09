/**
 * End-to-end: real x402 client + real x402 Express middleware + genuine EIP-3009
 * signatures, with a local facilitator standing in for Base Sepolia settlement.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/demo/server.js";
import { LocalFacilitator } from "../src/demo/local-facilitator.js";
import { createGuardedFetch, PaymentBlockedError } from "../src/guard.js";
import { InMemorySpendLedger } from "../src/policy/ledger.js";
import { MemoryAuditSink } from "../src/audit.js";
import type { PaymentPolicyConfig } from "../src/policy/types.js";

const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

let server: Server;
let base: string;
const facilitator = new LocalFacilitator();

const policy = (): PaymentPolicyConfig => ({
  version: 1,
  allowedSchemes: ["exact"],
  assets: [{ network: "eip155:84532", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6 }],
  roles: {
    researcher: {
      maxPerPayment: "0.03",
      dailyBudget: "0.03",
      approvalAbove: "0.02",
      allowedPayTo: [MERCHANT],
      allowedResources: [`${base}/*`],
    },
  },
});

beforeAll(async () => {
  server = createApp(facilitator, MERCHANT, OTHER).listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function setup(approve?: () => Promise<boolean>) {
  const ledger = new InMemorySpendLedger();
  const audit = new MemoryAuditSink();
  const f = createGuardedFetch({
    agent: { id: "t1", role: "researcher" },
    signer: privateKeyToAccount(generatePrivateKey()),
    network: "eip155:84532",
    policy: policy(),
    ledger,
    audit,
    approve,
  });
  return { f, ledger, audit };
}

describe("guarded x402 fetch", () => {
  it("pays, settles, and commits spend for an allowed request", async () => {
    const { f, ledger, audit } = setup();
    const before = facilitator.settled.length;
    const res = await f(`${base}/weather`);
    expect(res.status).toBe(200);
    expect(facilitator.settled.length).toBe(before + 1);
    expect(ledger.used("researcher")).toBe(10_000n);
    expect(audit.records.map(r => r.event)).toEqual(["payment.decision", "payment.settled"]);
  });

  it("blocks before signing: no payment reaches the facilitator", async () => {
    const { f } = setup();
    const before = facilitator.settled.length;
    await expect(f(`${base}/partner-feed`)).rejects.toMatchObject({ decision: { code: "PAYTO_NOT_ALLOWED" } });
    await expect(f(`${base}/bulk-data`)).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(facilitator.settled.length).toBe(before);
  });

  it("fails closed when approval is needed and nobody approves", async () => {
    const { f, ledger } = setup();
    await expect(f(`${base}/premium-report`)).rejects.toMatchObject({ decision: { code: "APPROVAL_DENIED" } });
    expect(ledger.used("researcher")).toBe(0n);
  });

  it("pays above the threshold once a reviewer approves", async () => {
    const { f, audit } = setup(async () => true);
    expect((await f(`${base}/premium-report`)).status).toBe(200);
    expect(audit.records.some(r => r.event === "payment.approval" && r.code === "APPROVED")).toBe(true);
  });

  it("enforces the rolling budget across requests", async () => {
    const { f } = setup();
    for (let i = 0; i < 3; i++) expect((await f(`${base}/weather`)).status).toBe(200);
    await expect(f(`${base}/weather`)).rejects.toMatchObject({ decision: { code: "OVER_DAILY_BUDGET" } });
  });

  it("refunds the budget reservation when settlement fails", async () => {
    const { f, ledger, audit } = setup();
    const orig = facilitator.settle.bind(facilitator);
    facilitator.settle = async (_p, r) => ({ success: false, errorReason: "insufficient_funds", transaction: "", network: r.network });
    try {
      await f(`${base}/weather`).catch(() => undefined);
    } finally {
      facilitator.settle = orig;
    }
    expect(ledger.used("researcher")).toBe(0n);
    expect(audit.records.some(r => r.event === "payment.failed")).toBe(true);
  });

  it("never writes signatures or payment payloads to the audit log", async () => {
    const { f, audit } = setup();
    await f(`${base}/weather`);
    const dump = JSON.stringify(audit.records);
    expect(dump).not.toMatch(/signature|0x[0-9a-f]{130}/i);
  });
});
