# Runbook

## Setup

- Node 24, npm 11 (`.nvmrc`). `ffmpeg` on PATH (only for re-recording idle
  lines).
- `npm run setup` (installs `core/` and `stage/`).
- `cp .env.example .env.local` and fill in `ANTHROPIC_API_KEY` and
  `ELEVENLABS_API_KEY` (optional: `AI_GATEWAY_API_KEY` for Jev). Never print
  or commit this file. Locally Core always reads Solana through the Node relay
  on :8799 (`scripts/dev.mjs` passes `--var SOLANA_RPC_URL:http://127.0.0.1:8799`);
  to point the relay at a paid RPC set `DEV_RPC_UPSTREAM=<url>` in your shell.
  `core/scripts/dev-vars.mjs` writes `core/.dev.vars` from it on `npm run dev`
  (plus a stable dev `GAIA_CANARY`, an `EVAL_TOKEN` and higher local limits;
  `--rotate-canary` makes a new canary).

## Running locally

| What | Command | Port |
|---|---|---|
| Core (wrangler dev + Solana relay) | `npm run dev:core` | 8788 (relay 8799) |
| Stage | `npm run dev:stage` | 3110 |
| Stage against a remote Core | `GAIA_CORE_URL=<host>` in `.env.local`, then `npm run dev:stage` (needs `http://localhost:3110` in that host's `ALLOWED_ORIGINS`) | 3110 |

Open http://localhost:3110. Core `ALLOWED_ORIGINS` (wrangler.toml) includes
localhost:3106 (the old site) and :3110 (the stage).

## Checks

```bash
npm test                         # Core: 222 tests, fixtures, no spend
npm run typecheck                # Core + stage
npm run build:stage
npm run canon:check --prefix core
cd core && LIVE=1 npx vitest run test/live   # 7 live chain reads (network)
```

## Evals (cost money)

Evals run against a **local Core** (`npm run dev:core`; or `GAIA_CORE_URL=`
another host). The runner reads `EVAL_TOKEN` from `core/.dev.vars` (rewritten
on every `npm run dev`; start the eval after Core is up): with a matching
token Core returns real per-turn cost and debug data and runs the Jev shadow;
without it spend is estimated.

```bash
npm run eval --prefix core -- --sample 20 --max-usd 2
npm run eval --prefix core -- --category trust --lang en
npm run eval --prefix core -- --ids E069,N059 --dry-run
```

Flags: `--sample N`, `--ids`, `--category`, `--lang`, `--full`, `--limit N`,
`--concurrency N` (default 3), `--max-usd X`, `--dry-run`. Without a scope it
prints an estimate and exits. The runner budgets $0.05 per item (≈ $10 for all
204; measured ≈ $0.04). Results go to `core/evals/results/` (gitignored).

## Editing knowledge

- Facts, pinned answers, links, bridges: edit `core/canon/*.yaml`, then
  `npm run canon --prefix core` (validates, writes `src/canon/canon.json`).
- Docs library: `npm run library --prefix core`. Sources: the public GitBook
  export `core/canon/sources/gitbook-llms-full.txt` (from
  https://seasons.gitbook.io/seasons-docs/llms-full.txt, fetched 2026-09-28;
  refresh it there) and the site's Terms/Privacy/Company pages, extracted from a
  checkout of the site (`SEASONS_SITE_DIR=<path>`).

## Voice assets

- Fixed lines (the greeting per locale, the scripted demo answers, the
  fallback line): `npm run demo-voice` (all) or `npm run demo-voice -- turn-2`
  in `stage/` after changing a line in `src/content/gaia-stage.ts`. They are
  stored as the same NDJSON the live voice streams, in
  `public/assets/gaia/lines/<key>.ndjson`, and played as static files.
  A line can carry a performance in `src/content/voice-direction.ts`
  (ElevenLabs v4 tags such as `[breathes in]`, `[light laugh]`, `[playfully]`;
  the words must equal the on-screen line). Directed lines are recorded with
  `eleven_v4` and the tags are stripped from the timestamps. Check each take
  with speech-to-text (`tag_audio_events=true` shows `[inhales]`,
  `[chuckles]`): takes vary, re-record until the performance is right.

- Idle lines: edit `stage/src/content/idle-lines.ts`, then
  `npm run idle-voice` (all) or `npm run idle-voice -- hum-2` (one) in
  `stage/`. Check each take with ElevenLabs speech-to-text
  (no spoken tags, right words) and a voicing ratio (whispers should be
  mostly unvoiced). Costs ElevenLabs credits.

## Deploys

Nothing deploys on push.

### Vercel (demo host)

- Core: `cd core && npm run build:vercel` (rebuilds the canon, bundles
  `api/core.js` with esbuild), `npx vercel link`, then `npx vercel deploy
  --prod`. Env: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `GAIA_CANARY`,
  `ALLOWED_ORIGINS`, `GAIA_LANGUAGES=en`, `SOLANA_RPC_GENTLE=1`, `GAIA_MODEL`,
  `JUDGE_MODEL`; optional `LIMIT_GLOBAL_PER_HOUR` (default 300). Add a stable
  `GAIA_MEMORY_KEY`, or every canary rotation invalidates browsers' signed
  memory. In-memory state resets on cold starts (the signed memory restores
  threads).
- Stage: from `stage/`, set the Core host in `stage/vercel.json` (the
  `/api/gaia/v2/*` rewrite), then `npx vercel build --prod` and `npx vercel
  deploy --prebuilt --prod`. The stage is fully static: the fixed lines are
  recorded files (`public/assets/gaia/lines/`), so it needs no keys.
- Map: `node docs/map/build.mjs`, then deploy `docs/map/dist/index.html` as a
  static page.

### Production (Cloudflare)

1. Paid Solana RPC (Helius). **Remove `SOLANA_RPC_URL` from `[vars]` in
   `core/wrangler.toml`** first (a var and a secret cannot share a name).
2. `cd core && npx wrangler login` and
   `npx wrangler secret put` for `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`,
   `GAIA_CANARY` (new per deploy), `GAIA_MEMORY_KEY` (stable),
   `SOLANA_RPC_URL`. `wrangler deploy` does not rebuild the canon: run
   `npm run canon && npm run canon:check` and `npm test`, then `npx wrangler deploy`.
3. Zone route `seasons.wtf/api/gaia/v2/*` → the Worker (add a `routes` entry to
   `wrangler.toml` or set it in the dashboard; none exists yet); add the
   production origins to `ALLOWED_ORIGINS`.
4. Host the stage (static). The build uses root paths (`/assets/…`,
   `/favicon.png`) and Vite has no `base`: serving it at `seasons.wtf/gaia`
   needs either a subdomain (e.g. gaia.seasons.wtf) or a `base: "/gaia/"`
   change plus moving the assets so they don't collide with the site's
   `/assets/`.
5. Nobody reads the team queue yet: `queue_for_team` / handoff write to the
   Durable Object storage (Cloudflare) or only to the log (Vercel). Wire
   Supabase + a Telegram alert before promising human follow-up.

## Troubleshooting

- **Stage shows the scripted demo / `502` on `/api/gaia/v2/*`**: Core is not
  running (e.g. after a restart only the stage came back). Start `npm run dev:core`.
- **Port 8788 in use by `workerd`**: an old wrangler from another checkout;
  stop it (`lsof -i :8788`).
- **30 fps everywhere**: the laptop is on battery (Chrome Energy Saver).
- **Sphere stuck as a flying point**: a `?state=speaking` URL is pinned.
- **"Cannot resume a closed AudioContext" in dev**: React StrictMode double
  mount; fixed by dropping the graph in cleanup — if it returns, check the
  unmount effect in `GaiaStage.tsx`.
- **Public Solana RPC 403 from Workers**: expected; use the dev relay locally
  and a paid RPC in production.
