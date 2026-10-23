// Local dev launcher: a JSON-RPC relay + `wrangler dev`.
// Public Solana RPC rejects requests carrying the `CF-Worker` header that the
// Workers runtime adds to every subrequest (even in wrangler dev), so in dev
// Core reaches RPC through this Node relay. Production needs a paid RPC
// endpoint instead (set SOLANA_RPC_URL as a secret).
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const UPSTREAM = process.env.DEV_RPC_UPSTREAM ?? "https://api.mainnet-beta.solana.com";
const PORT = 8799;
const ALLOW = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenSupply",
  "getEpochInfo",
  "getSlot",
  "getSignaturesForAddress",
  "getTransaction",
  "getTokenAccountsByOwner",
  "getTokenAccountBalance",
  "getBalance",
]);

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const calls = [].concat(JSON.parse(body));
    if (req.method !== "POST" || !calls.every((c) => ALLOW.has(c.method))) {
      res.writeHead(403).end("method not allowed");
      return;
    }
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    res
      .writeHead(upstream.status, { "Content-Type": "application/json" })
      .end(await upstream.text());
  } catch {
    res.writeHead(502).end("relay error");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`dev RPC relay on http://127.0.0.1:${PORT}`));

const wrangler = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--config",
    "wrangler.toml",
    "--port",
    "8788",
    "--var",
    `SOLANA_RPC_URL:http://127.0.0.1:${PORT}`,
    "--var",
    "SOLANA_RPC_GENTLE:1",
    // Extra wrangler flags pass through, e.g. `--var GAIA_MODEL:claude-sonnet-5-5`.
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
wrangler.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => wrangler.kill(signal));
