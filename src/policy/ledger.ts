/**
 * Spend ledger: tracks how much each role has spent in a rolling window.
 *
 * Budget is reserved before signing and only committed once the facilitator
 * confirms settlement. A failed or rejected payment releases its reservation,
 * so a flaky API can't silently burn an agent's budget.
 */

export interface SpendLedger {
  /** Committed + reserved spend for this role within the window, in atomic units. */
  used(role: string, now?: number): bigint;
  reserve(role: string, amount: bigint, now?: number): string;
  commit(reservationId: string, now?: number): void;
  release(reservationId: string): void;
}

interface Entry {
  role: string;
  amount: bigint;
  at: number;
  state: "reserved" | "committed";
}

export class InMemorySpendLedger implements SpendLedger {
  private entries = new Map<string, Entry>();
  private seq = 0;

  constructor(private readonly windowMs = 24 * 60 * 60 * 1000) {}

  used(role: string, now = Date.now()): bigint {
    let total = 0n;
    for (const e of this.entries.values()) {
      if (e.role === role && now - e.at < this.windowMs) total += e.amount;
    }
    return total;
  }

  reserve(role: string, amount: bigint, now = Date.now()): string {
    const id = `r${++this.seq}`;
    this.entries.set(id, { role, amount, at: now, state: "reserved" });
    return id;
  }

  commit(reservationId: string, now = Date.now()): void {
    const e = this.entries.get(reservationId);
    if (e) {
      e.state = "committed";
      e.at = now;
    }
  }

  release(reservationId: string): void {
    const e = this.entries.get(reservationId);
    if (e && e.state === "reserved") this.entries.delete(reservationId);
  }
}
