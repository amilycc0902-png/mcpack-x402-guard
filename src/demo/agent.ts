/**
 * Agent demo: one research agent and one support agent try to buy data.
 *
 *   npm run demo                         local, no wallet or network needed
 *   MODE=testnet npm run demo            real USDC on Base Sepolia (start `MODE=testnet npm run server` first)
 *
 * Approvals: prompts in the terminal; set APPROVE=yes or APPROVE=no to skip the prompt.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createGuardedFetch, PaymentBlockedError, type ApprovalHandler } from "../guard.js";
import { InMemorySpendLedger } from "../policy/ledger.js";
import { ConsoleAuditSink, JsonlAuditSink, MultiAuditSink } from "../audit.js";
import { BASE_SEPOLIA, PORT, isTestnet, loadPolicy, requireEnv } from "../config.js";
import { formatAtomic } from "../policy/engine.js";

const BASE = `http://localhost:${PORT}`;

const approve: ApprovalHandler = async (req, decision) => {
  const preset = process.env.APPROVE?.toLowerCase();
  if (preset) {
    console.log(`  ⏸️  Approval needed: ${decision.reason} → auto-${preset === "yes" ? "approved" : "declined"} (APPROVE=${preset})`);
    return preset === "yes";
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `  ⏸️  ${req.agentId} wants to pay ${formatAtomic(req.amount, 6)} USDC for ${req.resource}. Approve? [y/N] `,
  );
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
};

async function main() {
  let server: import("node:http").Server | undefined;
  if (!isTestnet()) {
    const { startServer } = await import("./server.js");
    server = await startServer();
  }

  const signer = privateKeyToAccount(
    isTestnet() ? (requireEnv("AGENT_PRIVATE_KEY") as `0x${string}`) : generatePrivateKey(),
  );
  const policy = loadPolicy();
  const ledger = new InMemorySpendLedger();
  const audit = new MultiAuditSink([new ConsoleAuditSink(), new JsonlAuditSink("audit.jsonl")]);

  console.log(`\nMode: ${isTestnet() ? "Base Sepolia testnet (real USDC)" : "local (signed payments, simulated settlement)"}`);
  console.log(`Agent wallet: ${signer.address}\n`);

  const agentFetch = (id: string, role: string) =>
    createGuardedFetch({ agent: { id, role }, signer, network: BASE_SEPOLIA, policy, ledger, audit, approve });

  const researcher = agentFetch("researcher-01", "research-agent");
  const support = agentFetch("support-01", "support-agent");
  const rogue = agentFetch("rogue-01", "intern-agent");

  const steps: [string, (u: string) => Promise<Response>, string][] = [
    ["1. Small purchase within limits", researcher, "/weather"],
    ["2. Above approval threshold", researcher, "/premium-report"],
    ["3. Over per-payment limit", researcher, "/bulk-data"],
    ["4. Recipient not on allowlist", researcher, "/partner-feed"],
    ["5. Keep buying until the daily budget runs out", researcher, "/weather"],
    ["6. Support agent outside its resource scope", support, "/premium-report"],
    ["7. Agent with no payment policy", rogue, "/weather"],
  ];

  for (const [title, f, path] of steps) {
    console.log(`\n${title}  (GET ${path})`);
    const repeat = title.startsWith("5.") ? 10 : 1;
    for (let i = 0; i < repeat; i++) {
      try {
        const res = await f(BASE + path);
        console.log(`  → HTTP ${res.status}: ${JSON.stringify(await res.json())}`);
      } catch (e) {
        if (e instanceof PaymentBlockedError) {
          console.log(`  → blocked: ${e.decision.code}`);
          break;
        }
        console.log(`  → error: ${(e as Error).message}`);
        break;
      }
    }
  }

  const used = ledger.used("research-agent");
  console.log(`\nresearch-agent 24h spend: ${formatAtomic(used, 6)} USDC. Full trail in audit.jsonl\n`);
  server?.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
