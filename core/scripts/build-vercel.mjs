// Bundles GAIA Core for the Vercel demo host into one self-contained function,
// api/core.js (all dependencies and the canon/library JSON inlined).
import { build } from "esbuild";

await build({
  entryPoints: ["src/vercel/entry.ts"],
  outfile: "api/core.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
