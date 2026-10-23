# Architecture

Two deployable parts:

```
gaia/
├─ core/     GAIA Core — answers (TypeScript; Cloudflare Worker + Durable Objects; Vercel adapter)
├─ stage/    The stage — the one-screen presentation (Vite + React 19 + three.js)
└─ docs/     These documents and the architecture map (docs/map)
```

The stage talks to Core only through `/api/gaia/v2/*` (same origin: a Vite
proxy in dev, a Vercel rewrite in the demo, a Cloudflare zone route in
production).

## 1. GAIA Core (`core/`)

### Edge and hosts

- `src/index.ts` — the Cloudflare Worker: origin allowlist (`ALLOWED_ORIGINS`),
  per-IP limits in `LimiterDO` (8/min, 60/h by default), zod-validated bodies.
  Routes under `/api/gaia/v2/`:
  - `GET config` → `{ ok, ui: "v2", brain, voice, langs }` (the stage uses
    `brain: true` to choose live Core over its scripted demo);
  - `POST turn` → an SSE v2 stream (below);
  - `GET|POST voice` → ElevenLabs audio for a **stored verified answer** only
    (by conversation id + message id; POST also carries the signed memory).
- `src/do/conversation.ts` — `ConversationDO`: one per conversation; runs a
  turn to completion, stores redacted user text and verified answers.
- `src/do/chaincache.ts` — `ChainCacheDO`: a chain cache shared by all
  conversations, warmed by an alarm every 20 minutes.
- `src/vercel/app.ts` + `entry.ts` — the same pipeline on Vercel with
  in-memory stores (history, voice messages, cache, limits incl. 300/h global).
  Bundled by `npm run build:vercel` into `core/api/core.js` (gitignored).
- `src/http.ts` — the shared edge contract (bodies, CORS, ids) for both hosts.
- `src/memory.ts` — signed conversation memory for stateless hosts: the last 6
  turns HMAC-SHA256-signed (`GAIA_MEMORY_KEY`, else `GAIA_CANARY`), 12 h
  expiry; sent to the browser as a `memory` event and sent back with each turn.

### The turn (`src/pipeline/turn.ts`)

```
user text
 → L0 guards (src/guards): NFKC, invisible characters, secrets (BIP39 seeds, also split;
   Solana keypairs) → authored template with no model call; links/addresses
   (registry allowlist, defanging); multilingual injection signals; floors
   (money / pinned answer / safety); greetings and thanks answered in code
 → the answer cache (src/pipeline/answer-cache.ts): a fresh question with no
   numbers, links, addresses, secrets or injection, asked again within 10
   minutes, gets the stored verified answer with its receipts and symbol — no
   model call. Only verified answers in normal / trust / money / brief modes
   that used no personal tool are stored. Evals bypass it.
 → pre-flight judge (src/judge/preflight.ts, Haiku 4.5, forced tool, ordinal labels,
   4 s, fails open on scope and closed on money): topic, asks returns, challenges
   legitimacy, injection, wants a human, gratitude, follows_up (sees the head and
   tail of GAIA's previous answer)
   ∥ prefetch of chain data for pinned questions
 → router (src/pipeline/router.ts): a deterministic floor; judges can only raise it.
   Modes: off_topic · normal · brief_plus_bridge · sensitive_financial ·
   trust_question · safety_alert · guarded · handoff. Picks tools and effort (the
   word budget per layer/mode is computed in brain/prompt.ts, `wordBudget`). A
   follow-up never goes off-topic; when the previous mode was normal,
   sensitive_financial or trust_question it inherits it (modes only ever rise).
   off_topic → a humorous template, no Opus.
 → brain (src/brain/loop.ts + prompt.ts): Claude Opus 5.5; a byte-stable cached
   system prompt (1 h) with the Almanac digest and the bridge graph; the turn's
   policy as a separate system message; ≤3 tool rounds; effort low/medium
 → tools (src/brain/tools.ts, 18, read-only, argument provenance enforced:
   numbers/addresses only from the user's words, receipts or the registry):
   get_token_trust_facts, get_distribution_receipts, get_price, get_supply,
   get_payout_schedule, get_wallet_tier, get_fact, search_docs, open_pages,
   calc_tax_lens, calc_gross_up, calc_round_trip, calc_time_to_earn_back,
   preflight_transfer, calc_expr, verify_link, verify_address, queue_for_team.
   Every result is a receipt (src/brain/receipts.ts) with source and read time.
 → verifier (src/verify + pipeline/founder-gates.ts + judge/post.ts): every number
   ↔ a receipt or an approved Almanac fact; never-say lexicon; pinned must_not;
   link/address allowlist; secret echo; canary leak; founder gates; Haiku
   post-check (blocks only when two passes agree) → one repair → template
 → answerShape(): the symbol the stage draws at the end (shield / heart / check)
 → SSE events, history, voice message stored
```

Fallbacks: no model key → degraded template; model outage → `degradedTemplate`
(offers topics) or the pinned short form; refusals → template.

### SSE v2 events (`src/types.ts`, `StreamEvent`)

`turn.start`, `state` (`SemanticState`: thinking / tool / verifying / guard /
handoff / degraded, with a label such as "Reading the $SEAS mint account…"),
`policy` (mode, delivery,
pinned), `tool.call`, `tool.result`, `receipt`, `text.commit` (the verified
answer, with `message_id`), `shape` (`check | heart | shield | …` or null),
`followup`, `memory`, `error`, `debug` (eval only), `turn.end`. Both hosts
also send an untyped `{ "type": "keepalive" }` every 15 s: clients must ignore
unknown types.

Symbols (`answerShape` in turn.ts, plus templates): shield for guarded /
safety_alert (including the seed-phrase template); heart for thanks (the
small-talk template; in `answerShape` only when gratitude is clear in
brief_plus_bridge); check for a non-template answer read from the chain in
trust_question, sensitive_financial or normal; otherwise none.

### Knowledge

- `canon/*.yaml` → `npm run canon` → `src/canon/canon.json` (validated,
  cross-checked). facts (60: 49 approved, 5 team_reported, 6 needs_founder;
  22 `on_request`), hard-answers (11 pinned answers, ≤6 examples per language,
  short_form ≤35 words), registry (94 official links, wallets, contracts),
  bridges (33), errata (22). Open decisions (D3, D4, D9, D12, D-VOL) gate
  some facts; until decided GAIA uses approved interim wording.
- Library: the public GitBook export (`canon/sources/gitbook-llms-full.txt`) +
  the site's Terms, Privacy and Company pages (`canon/site-pages.json`, via
  `scripts/extract-site-pages.mts`) → `npm run library` →
  `src/library/chunks.json` (111 chunks, BM25).
- Chain truth (`src/chain/`): mint trust facts, supply, latest payout round,
  prices (Raydium, Meteora, Jupiter; gap; exit liquidity), wallet tier, payout
  schedule, builder week. **Public Solana RPC refuses Cloudflare Workers**
  (CF-Worker header): local dev uses a Node relay (`scripts/dev.mjs`);
  production needs a paid RPC (Helius) as `SOLANA_RPC_URL`.
- Kernel (`src/kernel/`): exact maths in the user's numbers (fee lens,
  gross-up, round trip, earn-back, compounding, transfer pre-flight, a safe
  expression evaluator).

### Voice (`src/voice/elevenlabs.ts`)

Matilda (`XrExE9yKIg1WjnnlVkGX`), `eleven_v4_turbo`, streamed with character
timestamps (newline-delimited JSON). `spokenText()` turns `$SEAS` into "Seas".
`speakCached()` keeps each finished take keyed by a hash of the words spoken
(a day): a repeated answer is replayed without calling ElevenLabs (response
header `X-Gaia-Voice: cache`). Cloudflare stores takes in the edge cache
(`caches.default`; inactive on `*.workers.dev`), the Vercel demo in memory
(40 MB, least recently used first).

### Configuration (`src/env.ts`, `wrangler.toml`)

`ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `AI_GATEWAY_API_KEY` (Jev, eval
only), `SOLANA_RPC_URL`, `SOLANA_RPC_GENTLE`, `ALLOWED_ORIGINS`, `GAIA_MODEL`
(`claude-opus-5-5`), `JUDGE_MODEL` (`claude-haiku-4-5`), `GAIA_LANGUAGES`
(`en`), `GAIA_CANARY` (rotated per deploy, must never appear in output),
`GAIA_MEMORY_KEY`, `LIMIT_PER_MINUTE`, `LIMIT_PER_HOUR`, `EVAL_TOKEN`; on Vercel
also `LIMIT_GLOBAL_PER_HOUR` (default 300). Local dev only: `DEV_RPC_UPSTREAM`
(the relay's upstream RPC).

### Tests and evals

- `core/test/` — 222 tests with recorded fixtures (no network, no spend):
  guards, verify, kernel, chain, canon, library, founder gates, i18n vouching,
  off-topic, fallbacks, memory, voice, symbols, the answer cache. `LIVE=1 npx vitest run
  test/live` runs 7 live chain checks.
- `core/evals/seed.yaml` (204 items) + `evals/run.mjs` (Haiku grader, Jev
  shadow, `--sample/--ids/--category/--lang/--full`, `--max-usd` ceiling,
  results in `core/evals/results/`). Costs money: the runner budgets $0.05 per item
  (≈ $10 for all 204), measured ≈ $0.04.

Measured costs: ≈ $0.04 per turn on average (money ≈ $0.047, trust ≈ $0.065,
off-topic ≈ $0.003, greetings/thanks $0). Voice is billed separately.

## 2. The stage (`stage/`)

| File | Role |
|---|---|
| `src/main.tsx` | Mounts `<GaiaStage locale>` (locale from the path; English copy for now) |
| `src/gaia/GaiaStage.tsx` | The React stage: layout, chat, input, states, Core client, voice, idle lines, symbols at the end of answers, the greeting after the entrance |
| `src/gaia/createGaiaCore.ts` | The three.js world: GAIA's particle core, orbit lines, nucleus, dust, the wisp (flying point), the entrance, burst, symbol slots, bloom; drives the field |
| `src/gaia/core/shaders.ts` | GLSL: the core vertex shader (states, glyph slots, entrance, burst, collapse into the point), rings, nucleus, sweep laser, sheen, dust |
| `src/gaia/core/shapes.ts` | Symbol library: stroke glyphs sampled by arc length; logo outline tracing (Seasons mark, GAIA leaf) |
| `src/field/scenes/harvest.ts` | The night wheat field (from the site's hero-lab "01 Harvest"): grass, ranges, sky, star stream, fireflies, GAIA-mode effects |
| `src/field/types.ts`, `common.ts` | Scene contract (`setLightSource`, `setGaia`, `gaiaWave`, `gaiaFeed`), shared GLSL and palette |
| `src/gaia/gaiaCoreClient.ts` | `/config` probe, SSE turn stream, signed memory in `sessionStorage` (`gaia.memory`) |
| `src/gaia/gaiaVoice.ts` | Streams a voice take (MediaSource / ManagedMediaSource), word start times from character timestamps |
| `src/gaia/gaiaSpace.ts` | Web Audio: open-air voice path with pan; field ambience (wind, crickets, furin), ducking, rustle |
| `src/content/gaia-stage.ts` | Copy (en + other locales), scripted demo turns, `CoreState`, `CoreShape`, `GAIA_ENGLISH_ONLY` |
| `src/content/idle-lines.ts` | The eight idle lines (whisper / hum / muse) |
| `public/assets/gaia/lines/` | The fixed lines (greetings, demo answers, fallback) recorded once by `scripts/demo-voice.mjs`, as static NDJSON (audio + timestamps) |
| `scripts/idle-voice.mjs` | Records the idle lines with ElevenLabs |
| `vite.config.ts` | Dev server on :3110, proxy `/api/gaia/v2` → Core (`GAIA_CORE_URL` or 127.0.0.1:8788) |
| `vercel.json` | Static build + rewrite of `/api/gaia/v2/*` to the Core demo host, noindex |

### Stage flow

1. Mount: build the audio graph (sound on by default, resumes on the first
   gesture), probe `/config`, create the core (dynamic import).
2. **Entrance** (hidden warm-up, then 6 s): see STAGE-VISUALS-AND-SOUND.
3. Greeting (spoken), then the first suggestion.
4. A turn: `thinking` / `tool` states from Core events; each `receipt` sends
   fireflies into her (`core.feed`); on `text.commit` the voice take starts
   generating; `await core.burst()`; `speaking` (the point flies, words follow
   the voice clock); then `sign(shape)`: the symbol draws and stands, then
   folds away (3.4 s from the start, then a 2.1 s exit); `idle`.
5. Quiet for a while: an idle line (whisper / hum / muse).

Without Core (`brain: false` or unreachable) the stage plays reviewed demo
turns from `content/gaia-stage.ts`.
