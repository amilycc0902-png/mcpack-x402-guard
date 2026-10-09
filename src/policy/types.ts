/**
 * Payment policy types.
 *
 * Mirrors MCPack's tool-policy model (allow / deny / require-approval, scoped by
 * agent role) and applies it to money movement: what an agent may pay, to whom,
 * for which resource, and how much in total.
 */

export type Effect = "allow" | "deny" | "require_approval";

/** A token the policy is willing to pay with, e.g. USDC on Base Sepolia. */
export interface AssetConfig {
  network: string; // CAIP-2, e.g. "eip155:84532"
  address: string; // token contract address
  symbol: string; // display only, e.g. "USDC"
  decimals: number; // 6 for USDC
}

/** Limits for one agent role. Amounts are human units of the asset ("0.05" = 5 cents of USDC). */
export interface RolePolicy {
  /** Largest single payment allowed. */
  maxPerPayment: string;
  /** Rolling 24h budget across all payments by agents in this role. */
  dailyBudget: string;
  /** Payments above this amount pause for human approval. Omit to never ask. */
  approvalAbove?: string;
  /** Recipient wallets this role may pay. Use ["*"] to allow any (not recommended). */
  allowedPayTo: string[];
  /** Resource URL patterns this role may pay for; "*" is a wildcard. */
  allowedResources: string[];
}

export interface PaymentPolicyConfig {
  version: 1;
  /** Payment schemes the agent may sign. "exact" = fixed price per request. */
  allowedSchemes: string[];
  assets: AssetConfig[];
  roles: Record<string, RolePolicy>;
}

/** Everything the engine needs to judge one payment, extracted from an x402 402 response. */
export interface PaymentRequest {
  agentId: string;
  role: string;
  resource: string; // URL being paid for
  scheme: string;
  network: string;
  asset: string; // token contract address
  amount: bigint; // atomic units
  payTo: string;
}

export interface Decision {
  effect: Effect;
  /** Stable machine-readable code, e.g. "PAYTO_NOT_ALLOWED". */
  code: string;
  /** Human-readable explanation, safe to show to the agent or a reviewer. */
  reason: string;
}
