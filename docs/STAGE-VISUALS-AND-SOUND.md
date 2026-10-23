# Stage visuals and sound

How the stage looks and sounds, where each effect lives, and the knobs to
tune it. The rules behind these choices: **light only from GAIA, never blown out; motion smooth and
cinematic; nothing abrupt.**

Rendering: one WebGL canvas, an `EffectComposer` in `createGaiaCore.ts`:
`FieldPass` (the harvest field scene) → `RenderPass` (GAIA, `clear = false`)
→ UnrealBloom → a final pass (grain, chromatic fringe, glitch). MSAA must stay
off (`samples: 0`): a multisampled half-float target overflowed to white when
the sphere collapsed into the point. Adaptive resolution steps the pixel ratio
down if the GPU cannot hold ~55 fps (not during the entrance).

## 1. GAIA's core (`createGaiaCore.ts`, `core/shaders.ts`)

- **Particles**: a Fibonacci shell, a geodesic lattice (synapse pulses run
  along its edges) and an inner volume: 38.5k particles on desktop
  (19,000 + 480 edges × 24 + 8,000), fewer on small viewports
  (`small` = the shorter side or the width under 700 px).
  A nucleus with an anamorphic streak, two tilted orbit lines, a foil sheen,
  parallax dust motes.
- **States** (`CoreState`): `idle`, `listening`, `thinking`, `tool`,
  `speaking`, `guard`, `verified`. Each has a `Look` in `LOOKS` (turbulence,
  spin, scale, brightness, rings, synapse rate, scan, energy, streak, bloom,
  `shell` = skin visibility, `coreVis` = nucleus emphasis). Everything eases
  toward the target look. Waiting (`idle`): the sphere draws in to ~0.8, the
  skin dissolves in slow patches, the nucleus shows through. `tool`: a lime
  laser sweep (the separate sweep quad, `SWEEP_FRAG`) and lime sparks.
- **Idle float**: the sphere is never still (`root.position`, slow sines).
- **The wisp** (speaking): the sphere pours into its nucleus, which flies about
  her half of the screen: a spring toward targets with near-critical damping
  (0.85), a sideways lift that turns lines into arcs, hovers and glides; a
  comet tail of the sphere's particles interpolated along `uTrail[10]`. After
  speaking it flies home and the sphere re-forms. Tuning: the `wisp` block in
  `tick` (stiffness, timings, `waterFy` = how low it may fly).
- **Split layout**: `core.setFrame(x)` shifts both cameras with
  `setViewOffset`, so GAIA centres in the free space left of the chat.

### Transitions (all pass through the centre)

| Transition | Where | Timing |
|---|---|---|
| **Entrance** (page load): hidden warm-up until the Seasons mark is traced and 6 frames have rendered → canvas fades in (1.8 s) → faint spark → particles drift in as dust and gather into the Seasons mark in stroke order → the mark folds into the centre with growing speed → the sphere opens, rings grow in, the field's light grows with her | `intro` in `createGaiaCore.ts`, `uIntro` block in `CORE_VERT` | `INTRO_SECONDS = 6`; phases at 0.08–0.4 (gather), 0.62–0.8 (fold), 0.8–1 (open) |
| **Burst** (end of thinking, before speech): a short blast mostly across the view (no camera-facing blur), a hang with a few glints ("Matrix"), then an accelerating fall into the nucleus; the point takes over | `burst` in `createGaiaCore.ts`, `uBurst` block | `BURST_SECONDS = 2.1`; blast 0–0.16, hang 0.16–0.46, fall 0.46–1 (`pow 2.6`) |
| **Symbol in**: the sphere gathers into the nucleus (accelerating), then the symbol unfolds out of it in stroke order with a soft start and landing (smootherstep); the rest of the sphere returns as a faint shell | `glyphSlot()` in `CORE_VERT`, slots A/B, `uGlyph` | `GLYPH_IN_SECONDS = 3.2` |
| **Symbol out**: slight drift, a hang, an accelerating fall into the centre, the sphere opens again; orbit lines fold in too | same | `GLYPH_OUT_SECONDS = 2.1` |

Crowded at the centre each point dims (`atCentre`), so the nucleus glows
without burning.

### Symbols (`core/shapes.ts`)

Line art drawn by 24% of the particles (`glyphMembers`): strokes sampled evenly
by arc length, a tight core plus a faint halo, a drawing order `s` (the pen
front). A slow light runs along the finished line. Per-symbol tint and line
brightness in `SHAPE_TINT`.

- In answers (Core decides, `answerShape`): **shield** (guarded / safety),
  **heart** (thanks), **check** (an answer read from the chain). Drawn at the
  end of the answer by `sign()` in `GaiaStage.tsx`: it waits 3.4 s from
  `setShape` (which includes the 3.2 s draw-in; the symbol is fully open at
  ~2.7 s, so it stands complete for ~0.7 s), then releases (2.1 s exit). To
  hold it longer, raise the wait in `sign()`.
- **seasons**: the official mark, traced from `public/assets/seasons-mark.svg`;
  used only in the entrance.
- Available but unused: `sprout`, `clock`, `node`, `spark`, `mark` (GAIA leaf).
- Review any symbol: `/?state=idle&shape=<name>`.

## 2. The field (`field/scenes/harvest.ts`)

The night wheat field: 22,000 × quality blades (≈18.7k on desktop at 0.85,
≈9.9k on small screens at 0.45; instanced strips; ears catch light),
three mountain ranges with a light behind the highest summit, stars, shooting
stars, a stream of particles flowing across the sky (the original version; a
"planetary rings" variant was rejected), fireflies, dark ground.

GAIA mode (inert in other hosts):

- **Single light source**: `setLightSource(ndc, strength)` — only a soft pool
  under GAIA lights the ears and the ground; a soft ceiling
  (`orbLight = (1 − e^(−raw·1.6))·0.72`) keeps it visible from high up and
  never blown out close.
- **Downwash**: where the flying point's line of sight meets the grass tops
  (y = 0.8), blades part; 6 trail samples (one per 0.2 s) rise again with a
  1.7 s time constant (`exp(−age/1.7)`); fades out by 40 m. (`wash[6]`)
- **Voice wind**: voice peaks (> 0.5, rising, at most one per 0.9 s) send a
  ring of wind out of her light pool; capped at the pool's ceiling. (`rings[3]`)
- **Golden wave** on `verified`: one warm wave from her light across the whole
  field (7 m/s, ~14 s). (`golden`)
- **Fireflies by state** (`GATHER` in `createGaiaCore.ts`): idle 20% drift to
  her, listening 28%, thinking/tool 42% circle her on a tilted orbit, speaking
  and verified let go. They circle her **home**, never the flying point. Each
  receipt (`core.feed`) sends one channel of fireflies into the sphere; she
  brightens as they land.

## 3. Sound (`gaia/gaiaSpace.ts`, `gaiaVoice.ts`, `GaiaStage.tsx`)

- Sound is on by default; the audio graph is built on mount and resumes on the
  first pointer/key/touch (browser autoplay rule). The round button at the top
  of the chat toggles voice and ambience.
- **Voice path** (`connectVoiceSpace`): stereo panner (follows her, ±0.35) →
  dry + a sparse 0.45 s open-air impulse (send 0.06) + one dark far echo
  (0.48 s, send 0.07). An analyser reads the dry voice to drive the core.
- **Field ambience** (`startFieldAmbience`): wind (brown noise through a
  wandering band, slow swells); three crickets at different distances; a rare
  far furin chime (every 10–25 s). Ducks to 45% while she speaks.
  - Crickets: chirps of 3–5 syllables, each a near-pure tone dropping ~3.4% in
    pitch, 3 ms attack, 16–24 ms decay, faint 2nd harmonic, band-passed rasp;
    songs of 2–5 chirps, then 9–22 s rest, a quarter of songs skipped; peak
    0.0108 (10% below the first version); low-pass by distance, a little open
    air. Near her they fall silent (`setScene(pan, near)`) and start again
    slowly. Each wind ring adds a soft rustle on her side.
- **Greeting**: voiced with a performance (`content/voice-direction.ts`:
  a breath in, a warm "Hi… I'm GAIA", a soft chuckle, a playful finish),
  from a static file. If the browser already allows sound it is voiced at
  once; otherwise the text shows silently and the voice plays on the first
  click/tap/key, if no question has started and within a minute.
- **Idle lines** (`content/idle-lines.ts`, files in
  `public/assets/gaia/idle/`): 3 whispers, 2 hums, 3 musings, Matilda on
  `eleven_v4`, −24 LUFS. First after 45 s without pointer/key/wheel/touch,
  then every 80–140 s, at most 4 per visit, a different kind each time; never
  during a turn, with voice off or a hidden tab. The sphere breathes with it;
  any input fades it out. Lines play only once the browser has allowed sound
  (after the first click/tap/key). `?idle=<N>` makes the first wait N s and
  the later ones 2N–3N s, for review.
  Re-record: `npm run idle-voice [-- <id>]` in `stage/`.

## 4. Review flags (stage URL)

| Flag | Effect |
|---|---|
| `?state=<CoreState>` | Pins a state (the scene stays in it) |
| `?shape=<CoreShape>` | Pins a symbol (not overridden by answers) |
| `?ask=<question>` | Starts with that question (after the entrance) |
| `?idle=<seconds>` | Shortens the wait before the first idle line |
| `window.__gaiaCore` | Dev only (stripped in production): the core API for screenshot tools (`setShape`, `burst`, …) |

Do not leave a `?state=` URL open and judge from it: a pinned `speaking` keeps
the sphere as the flying point forever.
