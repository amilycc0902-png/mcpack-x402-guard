// Prints a fresh throwaway wallet. Paste the key into .env (never commit it).
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const key = generatePrivateKey();
console.log(`AGENT_PRIVATE_KEY=${key}`);
console.log(`# address: ${privateKeyToAccount(key).address}  ← fund this with Base Sepolia USDC`);
