# GAIA 2.0

G.A.I.A. (Growth Automation & Intelligence Agent) is Seasons' official AI
agent. This repository holds two parts:

| Folder | What | Stack |
|---|---|---|
| `core/` | **GAIA Core**: the service that answers. Guards, judges, brain, on-chain tools, verifier, voice. | TypeScript, Cloudflare Worker + Durable Objects (production target); a Vercel adapter for a demo host |
| `stage/` | **The stage**: the one-screen presentation. GAIA's living core over the night wheat field, the chat, the voice. | Vite, React 19, three.js |

| Doc | What it holds |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Core pipeline, tools, verifier, canon; the stage's structure |
| [`docs/STAGE-VISUALS-AND-SOUND.md`](docs/STAGE-VISUALS-AND-SOUND.md) | Effects, transitions, symbols, field, sound, review flags |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Setup, checks, evals, deploys, troubleshooting |
| [`docs/map/`](docs/map/) | Source of the interactive architecture map |

## Quick start

Needs Node 24 and npm 11.

```bash
npm run setup                  # installs core/ and stage/
cp .env.example .env.local     # then fill ANTHROPIC_API_KEY and ELEVENLABS_API_KEY
npm run dev:core               # Core on http://127.0.0.1:8788
npm run dev:stage              # stage on http://localhost:3110 (second terminal)
```

Open http://localhost:3110. The stage asks `/api/gaia/v2/config`; when Core
answers `brain: true` it talks to Core, otherwise it plays the reviewed demo
turns. To work on the stage against a remote Core instead, set
`GAIA_CORE_URL=<that host>` in `.env.local` — this only works once that
host's `ALLOWED_ORIGINS` includes `http://localhost:3110`; otherwise turns
get 403 and the stage shows its offline line.

Useful URL flags on the stage (full list in `docs/STAGE-VISUALS-AND-SOUND.md`): `?shape=<symbol>` pins a symbol, `?idle=<seconds>` shortens the wait for an idle line, `?state=idle|listening|thinking|speaking|verified`
pins a state, `?ask=<question>` starts mid-conversation.

## How a turn works

```
stage ──POST /api/gaia/v2/turn──▶ Core
  L0 guards (secrets, injection, links; greetings/thanks without a model)
  → pre-flight judge (Haiku 4.5: topic, money, legitimacy, injection, follows_up)
  → router (mode, tools, effort, word budget; off-topic → template, no Opus)
  → brain (Claude Opus 5.5, 18 read-only tools: chain, prices, canon, library, kernel maths)
  → verifier (every number ↔ receipt or approved fact, no promises, decision gates,
    Haiku post-check) → one repair → template
◀── SSE v2 stream: status, text, receipts, memory, turn.end
stage ──POST /api/gaia/v2/voice──▶ Core → ElevenLabs (only stored verified answers)
```

Knowledge lives in `core/canon/*.yaml` (facts, hard answers, registry,
bridges, errata), compiled by `npm run canon --prefix core`. Change facts
there, never in prompts.

## Checks

```bash
npm test                       # Core: 222 tests (fixtures, no network, no spend)
npm run typecheck              # Core + stage
npm run build:stage
npm run canon:check --prefix core
```

Evals call the real models and **cost money** (the runner estimates $0.05 per
item, ≈ $10 for all 204; measured ≈ $0.04). They need a running local Core.
The runner refuses to start without a scope and supports a hard cap:

```bash
npm run eval --prefix core -- --sample 20 --max-usd 2
```

Results go to `core/evals/results/` (gitignored).

## Deploy

Nothing deploys on push. The Vercel adapter and the Cloudflare production
steps are in [`docs/RUNBOOK.md`](docs/RUNBOOK.md#deploys).

## Rules that matter

- GAIA is direct, short and exact. She never promises returns, never states
  anything false and never denies what the chain shows. Details: the
  ANSWERING ABOUT SEASONS section of `core/src/brain/prompt.ts`.
- On-screen copy always writes the token as `$SEAS`; the voice reads it "Seas".
- English only for now: `GAIA_LANGUAGES = "en"` in `core/wrangler.toml` and
  `GAIA_ENGLISH_ONLY` in `stage/src/content/gaia-stage.ts`. The ru/de/es/ja
  templates stay in the code.
- Keys only in `.env.local` / `.dev.vars` / host secrets. Never commit or print them.
- Brand buttons are fully rounded pills.
- The Alcyone brand font is not included (licensed). Put your licensed
  `.woff2` files in `stage/public/assets/fonts/` (names in
  `stage/src/styles/base.css`); without them the stage falls back to the system font.
