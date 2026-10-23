// Writes core/.dev.vars from the project's root .env.local, so keys live in
// one gitignored place. Values are never printed.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KEYS = ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "AI_GATEWAY_API_KEY", "SOLANA_RPC_URL"];
const source = new URL("../../.env.local", import.meta.url);
const lines = readFileSync(source, "utf8").split("\n");
const out = [];
for (const key of KEYS) {
  const line = lines.find((l) => l.startsWith(`${key}=`));
  if (line) out.push(line.trim());
}
// Local eval runs need a higher per-IP budget than the public default.
out.push("LIMIT_PER_MINUTE=40", "LIMIT_PER_HOUR=2000");
// The canary sits in the cached system prompt, so it stays stable across dev
// restarts (a new one would force a fresh 1-hour prefix write); rotate it with
// --rotate-canary. Production rotates it per deploy. It must never appear in any answer.
const devVarsFile = new URL("../.dev.vars", import.meta.url);
const previous = existsSync(devVarsFile)
  ? readFileSync(devVarsFile, "utf8")
      .split("\n")
      .find((l) => l.startsWith("GAIA_CANARY="))
  : undefined;
out.push(
  previous && !process.argv.includes("--rotate-canary")
    ? previous
    : `GAIA_CANARY=cnry-${randomBytes(6).toString("hex")}`,
);
out.push(`EVAL_TOKEN=eval-${randomBytes(12).toString("hex")}`);
writeFileSync(new URL("../.dev.vars", import.meta.url), out.join("\n") + "\n", { mode: 0o600 });
console.log(`.dev.vars: ${out.map((l) => l.split("=")[0]).join(", ")}`);
