/**
 * Guarded x402 fetch for AI agents.
 *
 * Wraps @x402/fetch so every payment an agent attempts is checked against the
 * MCPack payment policy *before* anything is signed:
 *
 *   402 response → policy decision → (approval?) → reserve budget → sign → settle
 *                                                                  ↳ commit or release
 *
 * Built-in x402 spend controls only cap a single payment. This layer adds what an
 * agent operator actually needs: per-role limits, a rolling daily budget, a
 * recipient allowlist, resource scoping, human approval above a threshold, and
 * an audit trail.
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { PaymentRequirements } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { evaluatePayment, findAsset, formatAtomic, validatePolicy } from "./policy/engine.js";
import type { Decision, PaymentPolicyConfig, PaymentRequest } from "./policy/types.js";
import type { SpendLedger } from "./policy/ledger.js";
import type { AuditSink } from "./audit.js";

/** Asks a human (or a test stub) whether to allow a payment that needs approval. */
export type ApprovalHandler = (req: PaymentRequest, decision: Decision) => Promise<boolean>;

/** Thrown to the agent when the guard blocks a payment. */
export class PaymentBlockedError extends Error {
  constructor(public readonly decision: Decision) {
    super(`Payment blocked by policy [${decision.code}]: ${decision.reason}`);
    this.name = "PaymentBlockedError";
  }
}

export interface GuardOptions {
  agent: { id: string; role: string };
  /** viem account (or any signer ExactEvmScheme accepts) holding the agent's funds. */
  signer: ConstructorParameters<typeof ExactEvmScheme>[0];
  /** CAIP-2 network the agent signs on, e.g. "eip155:84532" for Base Sepolia. */
  network: string;
  policy: PaymentPolicyConfig;
  ledger: SpendLedger;
  audit: AuditSink;
  /** Called for require_approval decisions. Default: deny (fail closed). */
  approve?: ApprovalHandler;
  fetch?: typeof globalThis.fetch;
}

const key = (r: PaymentRequirements) => `${r.network}|${r.asset}|${r.payTo}|${r.amount}`.toLowerCase();

export function createGuardedFetch(opts: GuardOptions) {
  validatePolicy(opts.policy);
  const { agent, policy, ledger, audit } = opts;
  const approve = opts.approve ?? (async () => false);

  // Reservations waiting for a settlement result, matched by payment terms.
  const pending = new Map<string, string[]>();
  // When we block, remember why so the agent gets a clear error instead of a generic one.
  let lastBlock: Decision | undefined;

  const client = new x402Client().register(opts.network as `${string}:${string}`, new ExactEvmScheme(opts.signer));

  const describe = (r: PaymentRequirements) => {
    const asset = findAsset(policy, r.network, r.asset);
    return asset ? `${formatAtomic(BigInt(r.amount), asset.decimals)} ${asset.symbol}` : `${r.amount} (atomic) of ${r.asset}`;
  };

  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements: r }) => {
    const req: PaymentRequest = {
      agentId: agent.id,
      role: agent.role,
      resource: paymentRequired.resource?.url ?? "unknown",
      scheme: r.scheme,
      network: r.network,
      asset: r.asset,
      amount: BigInt(r.amount),
      payTo: r.payTo,
    };
    const base = { agentId: agent.id, role: agent.role, resource: req.resource, network: r.network, payTo: r.payTo, amount: describe(r) };

    const decision = evaluatePayment(req, policy, ledger.used(agent.role));
    audit.write({ ts: new Date().toISOString(), event: "payment.decision", ...base, ...decision });

    let allowed = decision.effect === "allow";
    if (decision.effect === "require_approval") {
      allowed = await approve(req, decision);
      audit.write({
        ts: new Date().toISOString(),
        event: "payment.approval",
        ...base,
        effect: allowed ? "allow" : "deny",
        code: allowed ? "APPROVED" : "APPROVAL_DENIED",
        reason: allowed ? "Approved by reviewer" : "Reviewer declined or no reviewer configured",
      });
      // Re-check the budget: other payments may have landed while a human was deciding.
      if (allowed) {
        const recheck = evaluatePayment(req, policy, ledger.used(agent.role));
        if (recheck.effect === "deny") {
          audit.write({ ts: new Date().toISOString(), event: "payment.decision", ...base, ...recheck });
          lastBlock = recheck;
          return { abort: true, reason: recheck.reason };
        }
      }
    }

    if (!allowed) {
      lastBlock = decision.effect === "deny" ? decision : { effect: "deny", code: "APPROVAL_DENIED", reason: decision.reason };
      return { abort: true, reason: lastBlock.reason };
    }

    const k = key(r);
    pending.set(k, [...(pending.get(k) ?? []), ledger.reserve(agent.role, req.amount)]);
  });

  const take = (r: PaymentRequirements) => {
    const q = pending.get(key(r));
    return q?.shift();
  };

  client.onPaymentCreationFailure(async ({ selectedRequirements: r, error }) => {
    const id = take(r);
    if (id) ledger.release(id);
    audit.write({
      ts: new Date().toISOString(), event: "payment.failed", agentId: agent.id, role: agent.role,
      network: r.network, payTo: r.payTo, amount: describe(r), code: "SIGNING_FAILED", reason: error.message,
    });
  });

  client.onPaymentResponse(async ({ requirements: r, settleResponse, error }) => {
    const id = take(r);
    const base = { agentId: agent.id, role: agent.role, network: r.network, payTo: r.payTo, amount: describe(r) };
    if (settleResponse?.success) {
      if (id) ledger.commit(id);
      audit.write({ ts: new Date().toISOString(), event: "payment.settled", ...base, txHash: settleResponse.transaction });
    } else {
      if (id) ledger.release(id);
      audit.write({
        ts: new Date().toISOString(), event: "payment.failed", ...base, code: "SETTLEMENT_FAILED",
        reason: settleResponse?.errorReason ?? error?.message ?? "Server did not accept the payment",
      });
    }
  });

  const paidFetch = wrapFetchWithPayment(opts.fetch ?? globalThis.fetch, client);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    lastBlock = undefined;
    try {
      return await paidFetch(input, init);
    } catch (err) {
      if (lastBlock) throw new PaymentBlockedError(lastBlock);
      throw err;
    }
  };
}
