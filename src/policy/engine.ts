/**
 * Deterministic payment policy evaluator.
 *
 * Pure function of (request, policy, spend so far): same inputs, same decision.
 * Checks run cheapest-and-most-fundamental first and the first failure wins,
 * so every denial carries exactly one clear reason.
 */
import type { Decision, PaymentPolicyConfig, PaymentRequest, AssetConfig } from "./types.js";

/** "0.05" with 6 decimals -> 50000n. Rejects malformed or over-precise amounts. */
export function toAtomic(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`Invalid amount "${amount}"`);
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) throw new Error(`"${amount}" has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatAtomic(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${amount / base}.${frac}` : `${amount / base}`;
}

/** Glob match where "*" matches any run of characters. */
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
  return re.test(value);
}
const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function findAsset(policy: PaymentPolicyConfig, network: string, address: string): AssetConfig | undefined {
  return policy.assets.find(a => a.network === network && sameAddr(a.address, address));
}

const deny = (code: string, reason: string): Decision => ({ effect: "deny", code, reason });

export function evaluatePayment(req: PaymentRequest, policy: PaymentPolicyConfig, spentInWindow: bigint): Decision {
  const role = policy.roles[req.role];
  if (!role) return deny("UNKNOWN_ROLE", `Agent role "${req.role}" has no payment policy (default deny).`);

  if (!policy.allowedSchemes.includes(req.scheme))
    return deny("SCHEME_NOT_ALLOWED", `Payment scheme "${req.scheme}" is not allowed.`);

  const asset = findAsset(policy, req.network, req.asset);
  if (!asset) return deny("ASSET_NOT_ALLOWED", `Token ${req.asset} on ${req.network} is not an approved payment asset.`);

  if (!role.allowedResources.some(p => matchPattern(p, req.resource)))
    return deny("RESOURCE_NOT_ALLOWED", `Role "${req.role}" may not pay for ${req.resource}.`);

  if (!role.allowedPayTo.some(p => p === "*" || sameAddr(p, req.payTo)))
    return deny("PAYTO_NOT_ALLOWED", `Recipient ${req.payTo} is not on the allowlist for "${req.role}".`);

  const fmt = (n: bigint) => `${formatAtomic(n, asset.decimals)} ${asset.symbol}`;
  const maxPer = toAtomic(role.maxPerPayment, asset.decimals);
  if (req.amount > maxPer)
    return deny("OVER_PER_PAYMENT_LIMIT", `${fmt(req.amount)} exceeds the per-payment limit of ${fmt(maxPer)}.`);

  const budget = toAtomic(role.dailyBudget, asset.decimals);
  if (spentInWindow + req.amount > budget)
    return deny(
      "OVER_DAILY_BUDGET",
      `${fmt(req.amount)} would bring 24h spend to ${fmt(spentInWindow + req.amount)}, over the ${fmt(budget)} budget.`,
    );

  if (role.approvalAbove !== undefined && req.amount > toAtomic(role.approvalAbove, asset.decimals))
    return {
      effect: "require_approval",
      code: "APPROVAL_REQUIRED",
      reason: `${fmt(req.amount)} to ${req.payTo} is above the ${role.approvalAbove} ${asset.symbol} approval threshold.`,
    };

  return { effect: "allow", code: "ALLOWED", reason: `${fmt(req.amount)} within limits (24h spend ${fmt(spentInWindow + req.amount)} / ${fmt(budget)}).` };
}

/** Fail fast on a bad policy file instead of at the first payment. */
export function validatePolicy(policy: PaymentPolicyConfig): void {
  if (policy.version !== 1) throw new Error("Unsupported policy version");
  if (!policy.assets.length) throw new Error("Policy lists no payment assets");
  for (const [name, r] of Object.entries(policy.roles)) {
    for (const a of policy.assets) {
      const per = toAtomic(r.maxPerPayment, a.decimals);
      const day = toAtomic(r.dailyBudget, a.decimals);
      if (per > day) throw new Error(`Role "${name}": maxPerPayment is larger than dailyBudget`);
      if (r.approvalAbove !== undefined && toAtomic(r.approvalAbove, a.decimals) > per)
        throw new Error(`Role "${name}": approvalAbove is larger than maxPerPayment, so approval can never trigger`);
    }
    if (!r.allowedPayTo.length) throw new Error(`Role "${name}": allowedPayTo is empty`);
  }
}
