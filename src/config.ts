import { readFileSync } from "node:fs";
import type { PaymentPolicyConfig } from "./policy/types.js";

export const BASE_SEPOLIA = "eip155:84532";
export const PORT = Number(process.env.PORT ?? 4021);

/**
 * Recipient addresses used ONLY in local mode with the fake facilitator.
 * (Local mode signs with a throwaway key generated on each run.)
 */
export const LOCAL = {
  merchant: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  unlistedRecipient: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
} as const;

export function isTestnet(): boolean {
  return process.env.MODE === "testnet";
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

export function merchantAddress(): string {
  return isTestnet() ? requireEnv("MERCHANT_ADDRESS") : LOCAL.merchant;
}

/** Loads a policy file and fills ${VAR} placeholders from the environment. */
export function loadPolicy(path = process.env.POLICY_FILE ?? "policy.example.json"): PaymentPolicyConfig {
  const raw = readFileSync(path, "utf8").replace(/\$\{(\w+)\}/g, (_, name) =>
    name === "MERCHANT_ADDRESS" ? merchantAddress() : requireEnv(name),
  );
  return JSON.parse(raw);
}
