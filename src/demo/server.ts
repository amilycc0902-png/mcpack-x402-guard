/**
 * Demo paid API ("merchant") protected by x402 on Base Sepolia.
 *
 *   GET /weather         $0.01  → normal small purchase
 *   GET /premium-report  $0.03  → above the approval threshold
 *   GET /bulk-data       $0.25  → over the per-payment limit
 *   GET /partner-feed    $0.01  → pays a wallet that is NOT on the allowlist
 *
 * Run standalone:  npm run server            (local fake facilitator)
 *                  MODE=testnet npm run server (real x402.org facilitator, Base Sepolia)
 */
import express from "express";
import { pathToFileURL } from "node:url";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { BASE_SEPOLIA, LOCAL, PORT, isTestnet, merchantAddress, requireEnv } from "../config.js";
import { LocalFacilitator } from "./local-facilitator.js";

export function createApp(facilitator: FacilitatorClient, payTo: string, unlistedPayTo: string) {
  const resourceServer = new x402ResourceServer(facilitator).register(BASE_SEPOLIA, new ExactEvmScheme());
  const route = (price: string, to: string, description: string) => ({
    accepts: [{ scheme: "exact", price, network: BASE_SEPOLIA, payTo: to }],
    description,
  });

  const app = express();
  app.use(
    paymentMiddleware(
      {
        "GET /weather": route("$0.01", payTo, "Current weather"),
        "GET /premium-report": route("$0.03", payTo, "Premium market report"),
        "GET /bulk-data": route("$0.25", payTo, "Bulk dataset export"),
        "GET /partner-feed": route("$0.01", unlistedPayTo, "Third-party feed (unvetted recipient)"),
      } as any,
      resourceServer,
    ),
  );
  app.get("/weather", (_q, r) => r.json({ city: "New York", tempF: 61, sky: "clear" }));
  app.get("/premium-report", (_q, r) => r.json({ report: "Stablecoin volume up 12% WoW (demo data)" }));
  app.get("/bulk-data", (_q, r) => r.json({ rows: 1_000_000 }));
  app.get("/partner-feed", (_q, r) => r.json({ feed: "demo" }));
  return app;
}

export function startServer(port = PORT) {
  const facilitator = isTestnet()
    ? new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL ?? "https://x402.org/facilitator" })
    : new LocalFacilitator();
  const unlisted = isTestnet() ? (process.env.UNLISTED_ADDRESS ?? requireEnv("UNLISTED_ADDRESS")) : LOCAL.unlistedRecipient;
  const app = createApp(facilitator, merchantAddress(), unlisted);
  return new Promise<import("node:http").Server>(resolve => {
    const s = app.listen(port, () => resolve(s));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(() =>
    console.log(`Paid API on http://localhost:${PORT} (${isTestnet() ? "Base Sepolia via facilitator" : "local facilitator"})`),
  );
}
