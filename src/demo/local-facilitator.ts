/**
 * Offline stand-in for an x402 facilitator, for local runs and tests.
 *
 * It really checks the agent's EIP-3009 signature (so the guard is exercised
 * against genuine signed payments) but "settles" by returning a fake tx hash
 * instead of submitting to Base. Use MODE=testnet for real onchain settlement.
 */
import type { FacilitatorClient } from "@x402/core/server";
import { verifyTypedData } from "viem";

type Req = Parameters<FacilitatorClient["verify"]>[1];
type Payload = Parameters<FacilitatorClient["verify"]>[0];

interface Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export class LocalFacilitator implements FacilitatorClient {
  settled: { payer: string; payTo: string; amount: string; tx: string }[] = [];
  private seen = new Set<string>();

  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" as const }], extensions: [], signers: {} };
  }

  async verify(payload: Payload, req: Req) {
    const p = payload.payload as { authorization?: Authorization; signature?: `0x${string}` };
    const a = p.authorization;
    if (!a || !p.signature) return { isValid: false, invalidReason: "missing_authorization" };
    if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { isValid: false, invalidReason: "wrong_recipient" };
    if (BigInt(a.value) < BigInt(req.amount)) return { isValid: false, invalidReason: "insufficient_amount" };
    if (this.seen.has(a.nonce)) return { isValid: false, invalidReason: "nonce_reused" };

    const ok = await verifyTypedData({
      address: a.from,
      domain: {
        name: String(req.extra?.name ?? "USDC"),
        version: String(req.extra?.version ?? "2"),
        chainId: 84532,
        verifyingContract: req.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: a.from,
        to: a.to,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      },
      signature: p.signature,
    });
    return ok ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: "invalid_signature" };
  }

  async settle(payload: Payload, req: Req) {
    const v = await this.verify(payload, req);
    const a = (payload.payload as { authorization: Authorization }).authorization;
    if (!v.isValid) return { success: false, errorReason: v.invalidReason, transaction: "", network: req.network };
    this.seen.add(a.nonce);
    const tx = `0xlocal${(this.settled.length + 1).toString().padStart(4, "0")}`;
    this.settled.push({ payer: a.from, payTo: a.to, amount: a.value, tx });
    return { success: true, payer: a.from, transaction: tx, network: req.network };
  }
}
