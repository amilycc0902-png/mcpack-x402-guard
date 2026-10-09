/**
 * Append-only audit trail for agent payments.
 *
 * Records who tried to pay whom, how much, for what, and why it was allowed or
 * blocked. Signatures and raw payment payloads are never logged: they authorize
 * fund transfers and could be replayed if a log leaked.
 */
import { appendFileSync } from "node:fs";

export type AuditEvent =
  | "payment.decision"
  | "payment.approval"
  | "payment.settled"
  | "payment.failed";

export interface AuditRecord {
  ts: string;
  event: AuditEvent;
  agentId: string;
  role: string;
  resource?: string;
  network?: string;
  payTo?: string;
  amount?: string; // human units, e.g. "0.01 USDC"
  effect?: string;
  code?: string;
  reason?: string;
  txHash?: string;
}

export interface AuditSink {
  write(record: AuditRecord): void;
}

const SECRET_KEYS = /signature|payload|authorization|privateKey|secret/i;

/** Defensive scrub in case a caller passes extra fields through. */
export function redact<T extends object>(record: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : v;
  return out as T;
}

export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  write(r: AuditRecord) {
    this.records.push(redact(r));
  }
}

export class JsonlAuditSink implements AuditSink {
  constructor(private readonly path: string) {}
  write(r: AuditRecord) {
    appendFileSync(this.path, JSON.stringify(redact(r)) + "\n");
  }
}

export class ConsoleAuditSink implements AuditSink {
  write(r: AuditRecord) {
    const icon = { allow: "✅", deny: "⛔", require_approval: "⏸️" }[r.effect ?? ""] ?? "•";
    const onchain = r.txHash && !r.txHash.startsWith("0xlocal") && r.network === "eip155:84532";
    const tail = r.txHash
      ? onchain
        ? ` https://sepolia.basescan.org/tx/${r.txHash}`
        : ` tx=${r.txHash}`
      : r.reason
        ? ` — ${r.reason}`
        : "";
    console.log(`  [audit] ${icon} ${r.event} ${r.agentId}(${r.role}) ${r.amount ?? ""} → ${r.payTo ?? ""}${tail}`);
  }
}

export class MultiAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}
  write(r: AuditRecord) {
    for (const s of this.sinks) s.write(r);
  }
}
