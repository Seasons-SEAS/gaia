import * as T from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import harvest from "../field/scenes/harvest";

import {
  CORE_VERT,
  POINT_FRAG,
  RING_VERT,
  RING_FRAG,
  QUAD_VERT,
  NUCLEUS_FRAG,
  STREAK_FRAG,
  WAVE_FRAG,
  SWEEP_FRAG,
  STREAM_VERT,
  DUST_VERT,
  FINAL_FRAG,
  SHEEN_FRAG,
} from "./core/shaders";
import { glyphMembers, sampleGlyph, sampleOutline } from "./core/shapes";

import type { Frame as FieldFrame, GaiaField } from "../field/types";
import type { CoreShape, CoreState } from "../content/gaia-stage";

/**
 * GAIA's living core, "holographic intelligence" (chosen from three cinematic
 * prototypes in output/gaia-2/core-lab; this is the ported `final` variant). A precise point-cloud mind (Fibonacci skin,
 * geodesic synapse lattice, inner volume, bright nucleus with an anamorphic
 * streak) with two tilted orbit lines and a foil sheen, floating above the
 * "Let it grow" night field (hero-lab 01 Harvest: grain, mountain ranges, the
 * light behind the summit, stars, fireflies). While she speaks the sphere
 * pours into its nucleus, a living point that darts over the field. While GAIA waits the
 * sphere draws in and its skin dissolves so the core shows through; it
 * gathers again as she listens, thinks and speaks. Everything eases toward
 * per-state targets; phases are integrated on the CPU so speed changes never jump.
 *
 * The field renders first into the same composer (FieldPass), then GAIA on top,
 * then bloom and the final pass, so the glow and grain are shared.
 */
export type GaiaCore = {
  setState: (state: CoreState) => void;
  /** Flow into a shape, or back to the sphere with `null`. */
  setShape: (shape: CoreShape | null) => void;
  /** Resolves when her entrance (dust → Seasons mark → sphere) has finished. */
  entrance: () => Promise<void>;
  /** The end of thinking: a small burst, everything falls into the nucleus; resolves when she may speak. */
  burst: () => Promise<void>;
  /** Kick the speaking wave; called once per streamed chunk. */
  pulse: (strength?: number) => void;
  /** Live voice level 0..1 (from an AnalyserNode on the TTS audio). */
  setVoice: (level: number) => void;
  /** Pointer in -1..1 for a gentle parallax. */
  setPointer: (x: number, y: number) => void;
  /** 0..1: the core rises and shrinks a little to make room for the chat. */
  setLift: (lift: number) => void;
  /** Horizontal centre of GAIA's space as a fraction of the width (0.5 = centre; the split desktop layout puts her left). */
  setFrame: (x: number) => void;
  /** Receipts arrived: fireflies fly into her, and she brightens as each lands. */
  feed: (count?: number) => void;
  /** Where she is for the ears, every frame: pan -1..1, closeness to the grass 0..1, and a wind gust she just raised. */
  onScene: (listener: ((scene: CoreScene) => void) | null) => void;
  dispose: () => void;
};

export type CoreScene = { pan: number; near: number; gust: number };

// Fireflies drawn to her per state, and how fast they circle: while she waits
// they gather slowly, while she thinks they circle, while she speaks they let go.
const GATHER: Record<CoreState, [number, number]> = {
  idle: [0.2, 0.22],
  listening: [0.28, 0.35],
  thinking: [0.42, 1],
  tool: [0.42, 1.3],
  speaking: [0, 0.3],
  guard: [0.1, 0.2],
  verified: [0, 0.3],
};

type WeightKey = Exclude<CoreState, "idle">;
type Look = {
  turb: number;
  spin: number;
  latSpin: number;
  swirl: number;
  scale: number;
  bright: number;
  ring: number;
  ringSpin: number;
  syn: number;
  scan: number;
  energy: number;
  streak: number;
  bloom: number;
  /** Skin visibility 0..1: low while waiting, whole while working. */
  shell: number;
  /** Inner core emphasis: brighter when the skin is thin. */
  coreVis: number;
  flickEvery: number;
};

const STATES: CoreState[] = [
  "idle",
  "listening",
  "thinking",
  "tool",
  "speaking",
  "guard",
  "verified",
];
const WEIGHT_KEYS: WeightKey[] = ["listening", "thinking", "tool", "speaking", "guard", "verified"];

// Global look per state (weights below drive the state-specific effects).
const LOOKS: Record<CoreState, Look> = {
  idle: {
    turb: 0.16,
    spin: 0.045,
    latSpin: -0.035,
    swirl: 0.05,
    scale: 0.8,
    bright: 1.05,
    ring: 0.5,
    ringSpin: 1,
    syn: 0.04,
    scan: 0.15,
    energy: 1.05,
    streak: 0.24,
    bloom: 0.8,
    shell: 0.2,
    coreVis: 1.75,
    flickEvery: 9,
  },
  listening: {
    turb: 0.3,
    spin: 0.09,
    latSpin: -0.05,
    swirl: 0.15,
    scale: 0.9,
    bright: 1.08,
    ring: 0.72,
    ringSpin: 1.3,
    syn: 0.12,
    scan: 0.6,
    energy: 1,
    streak: 0.35,
    bloom: 1,
    shell: 0.55,
    coreVis: 1.35,
    flickEvery: 12,
  },
  thinking: {
    turb: 0.6,
    spin: 0.22,
    latSpin: -0.16,
    swirl: 1.1,
    scale: 0.97,
    bright: 1.05,
    ring: 0.95,
    ringSpin: 3.2,
    syn: 0.55,
    scan: 0.25,
    energy: 1.1,
    streak: 0.35,
    bloom: 1.05,
    shell: 1,
    coreVis: 1.15,
    flickEvery: 4,
  },
  tool: {
    turb: 0.42,
    spin: 0.14,
    latSpin: -0.09,
    swirl: 0.5,
    scale: 0.98,
    bright: 1.02,
    ring: 1,
    ringSpin: 2.2,
    syn: 0.3,
    scan: 0,
    energy: 1,
    streak: 0.3,
    bloom: 1,
    shell: 1,
    coreVis: 1.05,
    flickEvery: 5,
  },
  speaking: {
    turb: 0.3,
    spin: 0.08,
    latSpin: -0.05,
    swirl: 0.15,
    scale: 1.06,
    bright: 1.1,
    ring: 0.9,
    ringSpin: 1.1,
    syn: 0.16,
    scan: 0.2,
    energy: 1,
    streak: 0.42,
    bloom: 1.05,
    shell: 1,
    coreVis: 1,
    flickEvery: 11,
  },
  guard: {
    turb: 0.05,
    spin: 0.02,
    latSpin: 0.012,
    swirl: 0,
    scale: 0.86,
    bright: 1.1,
    ring: 1,
    ringSpin: 0.3,
    syn: 0.02,
    scan: 0.45,
    energy: 0.8,
    streak: 0.12,
    bloom: 0.9,
    shell: 1,
    coreVis: 0.9,
    flickEvery: 1e9,
  },
  verified: {
    turb: 0.22,
    spin: 0.07,
    latSpin: -0.04,
    swirl: 0.05,
    scale: 1.04,
    bright: 1.12,
    ring: 1,
    ringSpin: 1,
    syn: 0.1,
    scan: 0.3,
    energy: 1.1,
    streak: 0.45,
    bloom: 1.05,
    shell: 1,
    coreVis: 1,
    flickEvery: 14,
  },
};

// Per symbol: tint (r, g, b), how much of it, and the line's brightness.
const SHAPE_TINT: Record<CoreShape, [number, number, number, number, number]> = {
  mark: [0.94, 0.91, 1, 0.85, 1.6],
  // The Seasons violet, lifted to glow on the night.
  seasons: [0.64, 0.52, 1, 0.9, 1.45],
  check: [0.553, 0.98, 0.267, 0.9, 1.05],
  heart: [1, 0.55, 0.85, 0.8, 1.35],
  shield: [0.86, 0.83, 1, 0.8, 1.25],
  sprout: [0.62, 0.98, 0.42, 0.85, 1.1],
  clock: [0.93, 0.91, 1, 0.8, 1.25],
  node: [0.74, 0.62, 1, 0.8, 1.35],
  spark: [1, 0.97, 1, 0.85, 1.35],
};
/** The small burst at the end of thinking, then the fall into the nucleus. */
const BURST_SECONDS = 2.1;
/** Her entrance: dust → the Seasons mark → the centre → the sphere. */
const INTRO_SECONDS = 6;
/** A symbol opening out of the centre, and going back through it. */
const GLYPH_IN_SECONDS = 3.2;
const GLYPH_OUT_SECONDS = 2.1;

const FOV = 34;
const ease = (v: number, t: number, dt: number, rate = 3) =>
  v + (t - v) * (1 - Math.exp(-dt * rate));
const rand = (a: number) => (Math.random() - 0.5) * a;

/** Unique edges of a subdivided icosahedron on the unit sphere. */
function geodesicEdges(detail: number): [T.Vector3, T.Vector3][] {
  const geo = new T.IcosahedronGeometry(1, detail);
  const pos = geo.getAttribute("position");
  const key = (i: number) =>
    `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  const seen = new Set();
  const edges: [T.Vector3, T.Vector3][] = [];
  for (let f = 0; f < pos.count; f += 3) {
    for (let e = 0; e < 3; e++) {
      const i = f + e,
        j = f + ((e + 1) % 3);
      const a = key(i),
        b = key(j);
      const k = a < b ? a + "|" + b : b + "|" + a;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push([
        new T.Vector3().fromBufferAttribute(pos, i).normalize(),
        new T.Vector3().fromBufferAttribute(pos, j).normalize(),
      ]);
    }
  }
  geo.dispose();
  return edges;
}

export function createGaiaCore(
  canvas: HTMLCanvasElement,
  options: { logoUrl?: string; seasonsUrl?: string } = {},
): GaiaCore {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = Math.min(innerWidth, innerHeight) < 700 || innerWidth < 700;
  const dpr = devicePixelRatio || 1;
  const prMax = small ? Math.min(dpr, 2) : Math.min(dpr, 1.5);
  const prMin = small ? 1.25 : 1;
  const bloomScale = small ? 0.5 : 0.6;

  const renderer = new T.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
    stencil: false,
  });
  renderer.setClearColor(0x05020f, 1);
  let pr = prMax;

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(FOV, 1, 0.1, 100);
  const root = new T.Group(); // rotates with the pointer; the mind and its orbits
  const anchor = new T.Group(); // follows root position/scale, faces the camera: glow quads
  const world = new T.Group(); // mirrored under the waterline for the reflection pass
  world.add(root, anchor);
  scene.add(world);

  const shared = {
    uTime: { value: 0 },
    uPR: { value: pr },
    uFocus: { value: 8 },
    uPointer: { value: new T.Vector2() },
    uVoice: { value: 0 },
    uPulse: { value: 0 },
    uListen: { value: 0 },
    uThink: { value: 0 },
    uTool: { value: 0 },
    uSpeak: { value: 0 },
    uGuard: { value: 0 },
    uVerified: { value: 0 },
    uFlick: { value: 1 },
    uFormed: { value: 0 },
  };
  const additive = {
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: T.AdditiveBlending,
  };
  const disposables: { dispose(): void }[] = [];
  const track = <U extends { dispose(): void }>(item: U): U => {
    disposables.push(item);
    return item;
  };

  // --- the field: the "Let it grow" night (hero-lab 01 Harvest) ------------------------
  // Grain before mountain ranges, light rising behind the summit, stars and
  // fireflies. It renders first, into the same buffers; GAIA floats above it.
  const field = harvest.create({ renderer, quality: small ? 0.45 : 0.85, mobile: small });
  const fieldFrame: FieldFrame = {
    time: 0,
    dt: 0,
    progress: 0,
    heroOut: 0,
    camera: 0,
    build: 0,
    pointer: [0, 0],
  };
  class FieldPass extends Pass {
    constructor() {
      super();
      this.needsSwap = false;
    }
    render(r: T.WebGLRenderer, _write: T.WebGLRenderTarget, read: T.WebGLRenderTarget) {
      r.setRenderTarget(this.renderToScreen ? null : read);
      field.frame(fieldFrame);
    }
  }
  const res = new T.Vector2(1, 1);

  // --- dust: parallax data particles --------------------------------------------
  const dustCount = small ? 220 : 520;
  const dustPos = new Float32Array(dustCount * 3);
  const dustSeed = new Float32Array(dustCount * 4);
  for (let i = 0; i < dustCount; i++) {
    const z = -12 + Math.random() * 15.5;
    dustPos.set([rand(22 + (z + 12) * 0.2), rand(12), z], i * 3);
    dustSeed.set([Math.random(), Math.random(), Math.random() ** 2, Math.random()], i * 4);
  }
  const dustGeo = track(new T.BufferGeometry());
  dustGeo.setAttribute("position", new T.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute("aD", new T.BufferAttribute(dustSeed, 4));
  const dustMat = track(
    new T.ShaderMaterial({
      uniforms: { ...shared, uWisp: { value: new T.Vector3() }, uWispOn: { value: 0 } },
      vertexShader: DUST_VERT,
      fragmentShader: POINT_FRAG,
      ...additive,
    }),
  );
  const dust = new T.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  dust.renderOrder = -50;
  scene.add(dust);

  // --- the mind -------------------------------------------------------------------
  const shellCount = small ? 6500 : 19000;
  const volCount = small ? 2600 : 8000;
  const edges = geodesicEdges(small ? 2 : 3);
  const perEdge = small ? 14 : 24;
  const latCount = edges.length * perEdge;
  const count = shellCount + latCount + volCount;
  const pos = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  const info = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  let n = 0;
  for (let i = 0; i < shellCount; i++, n++) {
    const y = 1 - (i / (shellCount - 1)) * 2;
    const ring = Math.sqrt(1 - y * y);
    const th = golden * i + rand(0.6);
    const r = 0.975 + rand(0.035);
    pos.set([Math.cos(th) * ring * r, y * r, Math.sin(th) * ring * r], n * 3);
    info.set([0, 0, 0], n * 3);
  }
  const va = new T.Vector3();
  edges.forEach(([a, b], e) => {
    const h = Math.random();
    const angle = a.angleTo(b);
    for (let s = 0; s < perEdge; s++, n++) {
      const t = (s + Math.random() * 0.6) / perEdge;
      // Slerp along the great circle.
      const k0 = Math.sin((1 - t) * angle) / Math.sin(angle);
      const k1 = Math.sin(t * angle) / Math.sin(angle);
      va.copy(a).multiplyScalar(k0).addScaledVector(b, k1).multiplyScalar(1.005);
      pos.set([va.x, va.y, va.z], n * 3);
      info.set([1, h + e * 0.0001, t], n * 3);
    }
  });
  for (let i = 0; i < volCount; i++, n++) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const ring = Math.sqrt(1 - u * u);
    const r = 0.1 + 0.8 * Math.pow(Math.random(), 0.75);
    pos.set([Math.cos(th) * ring * r, u * r, Math.sin(th) * ring * r], n * 3);
    info.set([2, 0, 0], n * 3);
  }
  for (let i = 0; i < count; i++)
    seeds.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);

  // Two glyph slots, so one symbol can un-draw while the next draws.
  const members = glyphMembers(count);
  const glyphA = new Float32Array(count * 4).fill(-1);
  const glyphB = new Float32Array(count * 4).fill(-1);

  const coreGeo = track(new T.BufferGeometry());
  coreGeo.setAttribute("position", new T.BufferAttribute(pos, 3));
  coreGeo.setAttribute("aSeed", new T.BufferAttribute(seeds, 4));
  coreGeo.setAttribute("aInfo", new T.BufferAttribute(info, 3));
  const glyphAttrs = [new T.BufferAttribute(glyphA, 4), new T.BufferAttribute(glyphB, 4)];
  coreGeo.setAttribute("aGlyphA", glyphAttrs[0]);
  coreGeo.setAttribute("aGlyphB", glyphAttrs[1]);
  coreGeo.boundingSphere = new T.Sphere(new T.Vector3(), 2.5);
  const logoUrl = options.logoUrl ?? "/assets/gaia/gaia-logo.png";
  // Logos are traced from their images, so they are prepared once, ahead of time:
  // the Seasons mark (three S ribbons) and GAIA's leaf (not shown for now).
  const outlines: Partial<Record<CoreShape, Float32Array>> = {};
  // A logo asked for before its image is traced is drawn as soon as it is.
  let wanted: CoreShape | null = null;
  let drawShape: (shape: CoreShape | null) => void = () => {};
  const prepare = (shape: CoreShape, url: string, crop = 1) => {
    const data = new Float32Array(count * 4);
    sampleOutline(data, members, url, { crop })
      .then((ok) => {
        if (!ok) return;
        outlines[shape] = data;
        if (wanted === shape) drawShape(shape);
      })
      .catch(() => {});
  };
  prepare("seasons", options.seasonsUrl ?? "/assets/seasons-mark.svg");
  prepare("mark", logoUrl, 0.32);

  const coreUniforms = {
    ...shared,
    uSize: { value: small ? 1.45 : 1.6 },
    uDof: { value: 1 },
    uSpin: { value: 0 },
    uLatSpin: { value: 0 },
    uSwirl: { value: 0 },
    uTurb: { value: 0.2 },
    uScale: { value: 1 },
    uBright: { value: 1 },
    uBreath: { value: 0 },
    uScanY: { value: 2 },
    uScanAmt: { value: 0.5 },
    uSweepY: { value: 0 },
    uSynT: { value: 0 },
    uSynRate: { value: 0.07 },
    uTintAmt: { value: 0 },
    uShapeGain: { value: 1 },
    uGlyph: { value: new T.Vector4() },
    uGlyphOn: { value: 0 },
    uIntro: { value: 0 },
    uBurst: { value: 0 },
    uTint: { value: new T.Vector3(1, 1, 1) },
    uShell: { value: LOOKS.idle.shell },
    uCoreVis: { value: LOOKS.idle.coreVis },
    uCollapse: { value: 0 },
    uTrail: { value: Array.from({ length: 10 }, () => new T.Vector3()) },
  };
  const coreMat = track(
    new T.ShaderMaterial({
      uniforms: coreUniforms,
      vertexShader: CORE_VERT,
      fragmentShader: POINT_FRAG,
      ...additive,
    }),
  );
  const mind = new T.Points(coreGeo, coreMat);
  mind.frustumCulled = false;
  root.add(mind);

  // --- nucleus, anamorphic streak, verification wave, laser sweep ------------------
  const quad = (
    w: number,
    h: number,
    frag: string,
    uniforms: Record<string, T.IUniform>,
    parent: T.Object3D,
    order = 0,
  ) => {
    const geo = track(new T.PlaneGeometry(w, h));
    const mat = track(
      new T.ShaderMaterial({
        uniforms,
        vertexShader: QUAD_VERT,
        fragmentShader: frag,
        // Double-sided: the reflection pass mirrors the world.
        side: T.DoubleSide,
        ...additive,
      }),
    );
    const mesh = new T.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    parent.add(mesh);
    return mesh;
  };
  const nucleusU = { ...shared, uEnergy: { value: 1 } };
  quad(3.4, 3.4, NUCLEUS_FRAG, nucleusU, anchor, -2);
  const streakU = { ...shared, uStreak: { value: 0.3 } };
  quad(small ? 6.5 : 9, 0.8, STREAK_FRAG, streakU, anchor, 5);
  quad(6.4, 6.4, WAVE_FRAG, shared, anchor, 4);
  const sweepU = { ...shared, uSweepY: coreUniforms.uSweepY, uSweepV: { value: 1 }, uCalm: { value: 1 } };
  quad(3.6, 3.6, SWEEP_FRAG, sweepU, root, 3);
  const sheenU = { ...shared, uR: { value: 1 }, uShine: { value: 0 } };
  quad(2.4, 2.4, SHEEN_FRAG, sheenU, anchor, 6);

  // --- chain-read data streams -------------------------------------------------------
  const streams = small ? 8 : 12;
  const packets = 3;
  const perPacket = small ? 12 : 16;
  const streamCount = streams * packets * perPacket;
  const streamSeed = new Float32Array(streamCount * 4);
  const streamQ = new Float32Array(streamCount);
  let si = 0;
  for (let s = 0; s < streams; s++) {
    // Mostly from the sides and above: the lower third stays calm.
    const ang = -0.55 + (s / streams) * (Math.PI + 1.1) + rand(0.25);
    const spd = 0.3 + Math.random() * 0.25;
    const lateral = Math.random();
    for (let p = 0; p < packets; p++) {
      const base = p / packets + rand(0.08);
      for (let q = 0; q < perPacket; q++, si++) {
        streamSeed.set([ang, spd, base - q * 0.0048, lateral], si * 4);
        streamQ[si] = q / perPacket;
      }
    }
  }
  const streamGeo = track(new T.BufferGeometry());
  streamGeo.setAttribute("position", new T.BufferAttribute(new Float32Array(streamCount * 3), 3));
  streamGeo.setAttribute("aS", new T.BufferAttribute(streamSeed, 4));
  streamGeo.setAttribute("aQ", new T.BufferAttribute(streamQ, 1));
  const streamU = { ...shared, uStreamT: { value: 0 } };
  const streamMat = track(
    new T.ShaderMaterial({
      uniforms: streamU,
      vertexShader: STREAM_VERT,
      fragmentShader: POINT_FRAG,
      ...additive,
    }),
  );
  const streamPts = new T.Points(streamGeo, streamMat);
  streamPts.frustumCulled = false;
  root.add(streamPts);

  // --- orbit lines ------------------------------------------------------------------
  type RingConfig = {
    r0: number;
    r1: number;
    alpha: number;
    spin: number;
    dir: number;
    tilt: [number, number, number];
  };
  const RINGS: RingConfig[] = [
    { r0: 1.14, r1: 1.152, alpha: 0.6, spin: 0.1, dir: 1, tilt: [1.2, 0.2, 0.32] },
    { r0: 1.7, r1: 1.712, alpha: 0.45, spin: -0.065, dir: -1, tilt: [-1.08, -0.15, -0.5] },
  ];
  const rings = RINGS.map((cfg) => {
    const geo = track(new T.RingGeometry(cfg.r0 - 0.02, cfg.r1 + 0.02, small ? 192 : 320, 1));
    const uniforms = {
      ...shared,
      uR0: { value: cfg.r0 },
      uR1: { value: cfg.r1 },
      uAlpha: { value: cfg.alpha },
      uPhase: { value: Math.random() },
      uDir: { value: cfg.dir },
    };
    const mat = track(
      new T.ShaderMaterial({
        uniforms,
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        side: T.DoubleSide,
        ...additive,
      }),
    );
    const mesh = new T.Mesh(geo, mat);
    mesh.frustumCulled = false;
    const holder = new T.Group();
    holder.rotation.set(cfg.tilt[0], cfg.tilt[1], cfg.tilt[2]);
    holder.add(mesh);
    root.add(holder);
    return { cfg, mesh, uniforms, holder };
  });

  // --- post -----------------------------------------------------------------------------
  // MSAA on desktop: the grass is thin geometry.
  const composer = new EffectComposer(
    renderer,
    new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, samples: 0 }),
  );
  composer.addPass(new FieldPass());
  const gaiaPass = new RenderPass(scene, camera);
  gaiaPass.clear = false;
  composer.addPass(gaiaPass);
  const bloom = new UnrealBloomPass(new T.Vector2(256, 256), 0.7, 0.45, 0.32);
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w: number, h: number) =>
    bloomSetSize(
      Math.max(64, Math.round(w * bloomScale)),
      Math.max(64, Math.round(h * bloomScale)),
    );
  composer.addPass(bloom);
  const finalPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uRes: { value: new T.Vector2(1, 1) },
      uCoreUv: { value: new T.Vector2(0.5, 0.56) },
      uTime: shared.uTime,
      uAberr: { value: 0.0022 },
      uScan: { value: 0.07 },
      uGlitch: { value: 0 },
      uGrain: { value: 0.022 },
    },
    vertexShader:
      "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
    fragmentShader: FINAL_FRAG,
  });
  composer.addPass(finalPass);

  // --- layout ----------------------------------------------------------------------------
  let liftUnits = 0;
  let frameX = 0.5;
  let cssW = 1,
    cssH = 1;
  const applySize = () => {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    // A hidden tab or a collapsed frame can report 0×0: keep the last real size
    // (a 0 aspect would put NaN into every camera); the ResizeObserver calls again.
    if (w < 2 || h < 2) return;
    cssW = w;
    cssH = h;
    // Keep the pixel count bounded on very large screens.
    const cap = Math.sqrt((small ? 1.5e6 : 3.3e6) / (cssW * cssH));
    const p = Math.max(0.75, Math.min(pr, cap));
    renderer.setPixelRatio(p);
    renderer.setSize(cssW, cssH, false);
    composer.setPixelRatio(p);
    composer.setSize(cssW, cssH);
    shared.uPR.value = p;
    const bw = Math.round(cssW * p),
      bh = Math.round(cssH * p);
    res.set(bw, bh);
    field.resize(cssW, cssH);
    // The field shifts with GAIA, so its summit light stays in her half of the screen.
    field.camera?.setViewOffset(cssW, cssH, (0.5 - frameX) * cssW, 0, cssW, cssH);
    field.camera?.updateProjectionMatrix();
    finalPass.uniforms.uRes.value.set(bw, bh);
    const aspect = cssW / cssH;
    const half = Math.tan(((FOV / 2) * Math.PI) / 180);
    const dist = Math.max(2.5 / half, 1.95 / (half * aspect));
    camera.aspect = aspect;
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, 0);
    camera.setViewOffset(
      cssW,
      cssH,
      (0.5 - frameX) * cssW,
      cssH * (small ? 0.09 : 0.06),
      cssW,
      cssH,
    );
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    shared.uFocus.value = dist - 0.35;
    liftUnits = 2 * dist * half * (small ? 0.14 : 0.13);
  };
  const observer = new ResizeObserver(applySize);
  observer.observe(canvas);
  applySize();

  // --- animation ---------------------------------------------------------------------------
  let look = LOOKS.idle;
  const now = { ...LOOKS.idle };
  const weights = Object.fromEntries(WEIGHT_KEYS.map((k) => [k, 0])) as Record<WeightKey, number>;
  let current: CoreState = "idle";
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const lift = { value: 0, target: 0 };
  const voice = { value: 0, target: 0 };
  // Each slot runs its own transition: in (0..1) opens a symbol out of the
  // centre, out (0..1) folds it back through the centre into the sphere.
  const slots = [0, 1].map(() => ({ shape: null as CoreShape | null, in: 0, out: 0, leaving: false }));
  const burst = { t: -1, hold: 0, done: null as (() => void) | null };
  // The entrance waits, invisible, until the shaders are compiled, the Seasons
  // mark is traced and a few frames have rendered: the first visible frame is
  // already smooth.
  const intro = { t: -1, warm: 0, waited: 0, done: false };
  let introResolve: () => void = () => {};
  const introDone = new Promise<void>((resolve) => (introResolve = resolve));
  canvas.style.opacity = "0";
  canvas.style.transition = "opacity 1.8s ease";
  const finishIntro = () => {
    intro.done = true;
    intro.t = 1;
    coreUniforms.uIntro.value = 1;
    canvas.style.opacity = "1";
    introResolve();
  };
  if (reduced) finishIntro();
  const tintTarget = new T.Vector3(1, 1, 1);
  let tintAmtTarget = 0;
  const phase = { scan: 0, sweep: 0, stream: 0 };
  let flickIn = 4 + Math.random() * 4;
  let flickLeft = 0;
  let ema = 16.7,
    settle = 0;
  const proj = new T.Vector3();
  // The living point: while she speaks the sphere pours into its nucleus, which
  // darts about her half of the screen like a firefly and comes home after.
  const wisp = {
    pos: new T.Vector3(),
    vel: new T.Vector3(),
    target: new T.Vector3(),
    shown: new T.Vector3(),
    next: 0,
    stiff: 30,
    collapse: 0,
  };
  const trailWorld = Array.from({ length: 10 }, () => new T.Vector3());
  const gathering = { amount: 0, phase: 0 };
  const centreTop = new T.Vector3();
  const landings: number[] = [];
  let sceneListener: ((scene: CoreScene) => void) | null = null;
  const fieldState: GaiaField = {
    point: [0, 0],
    flying: 0,
    centre: [0, 0],
    radius: 0.1,
    voice: 0,
    gather: 0,
    circle: 0,
  };
  let trailClock = 0;
  const ray = new T.Vector3();
  /** A point on the z = depth plane under a screen position (fractions from the top left). */
  const onScreen = (fx: number, fy: number, depth: number, out: T.Vector3) => {
    ray
      .set(fx * 2 - 1, 1 - fy * 2, 0.5)
      .unproject(camera)
      .sub(camera.position)
      .normalize();
    return out.copy(camera.position).addScaledVector(ray, (depth - camera.position.z) / ray.z);
  };
  let last = performance.now();
  let frame = 0;
  let running = true;
  const timeScale = reduced ? 0.18 : 1;

  const tick = (time: number) => {
    if (!running) return;
    frame = requestAnimationFrame(tick);
    const rawDt = Math.min(0.05, (time - last) / 1000);
    last = time;
    const dt = rawDt * timeScale;

    // Still waiting for a real size (started hidden or collapsed)? Take it as soon as it exists.
    if (cssW < 2 && (canvas.clientWidth || innerWidth) > 1) applySize();

    // Adaptive resolution: step down if the GPU cannot hold ~55 fps.
    ema = ema * 0.94 + rawDt * 1000 * 0.06;
    settle += rawDt;
    if (!intro.done) settle = 0;
    if (!reduced && settle > 1.2 && ema > 19.5 && pr > prMin) {
      pr = Math.max(prMin, pr - 0.25);
      applySize();
      settle = 0;
      ema = 16.7;
    }

    // Skin and size change a little slower: the sphere gathers and dissolves.
    for (const key of Object.keys(now) as (keyof Look)[])
      if (key !== "flickEvery")
        now[key] = ease(now[key], look[key], rawDt, key === "shell" || key === "scale" ? 1.9 : 3);
    for (const key of WEIGHT_KEYS)
      weights[key] = ease(
        weights[key],
        current === key ? 1 : 0,
        rawDt,
        key === "tool" || key === "verified" ? 4.5 : 3,
      );
    const u = coreUniforms;
    shared.uTime.value += dt;
    const t = shared.uTime.value;
    shared.uListen.value = weights.listening;
    shared.uThink.value = weights.thinking;
    shared.uTool.value = weights.tool;
    shared.uSpeak.value = weights.speaking;
    shared.uGuard.value = weights.guard;
    shared.uVerified.value = weights.verified;
    voice.value = ease(voice.value, voice.target, rawDt, voice.target > voice.value ? 22 : 12);
    shared.uVoice.value = voice.value;
    shared.uPulse.value *= Math.exp(-rawDt * 2.6);

    u.uSpin.value += dt * now.spin;
    u.uLatSpin.value += dt * now.latSpin;
    u.uSwirl.value += dt * now.swirl;
    u.uTurb.value = now.turb;
    u.uScale.value = now.scale;
    u.uBright.value = now.bright;
    u.uShell.value = now.shell;
    u.uCoreVis.value = now.coreVis;
    u.uSynT.value += dt * (0.55 + now.syn * 1.6);
    u.uSynRate.value = now.syn;
    u.uBreath.value = Math.sin(t * (0.85 - weights.guard * 0.35)) + 0.35 * Math.sin(t * 2.3 + 1.2);
    // Scan band: one slow pass top to bottom, then a rest.
    phase.scan += dt * (0.1 + weights.listening * 0.06 + weights.thinking * 0.2);
    const sc = phase.scan % 1;
    u.uScanY.value = sc < 0.55 ? 1.35 - (sc / 0.55) * 2.7 : 3;
    u.uScanAmt.value = now.scan;
    // Laser sweep while reading the chain: a scanner ping-pong.
    phase.sweep += dt * 1.25;
    u.uSweepY.value = Math.cos(phase.sweep) * 1.08;
    sweepU.uSweepV.value = -Math.sin(phase.sweep) >= 0 ? 1 : -1;
    phase.stream += dt;
    streamU.uStreamT.value = phase.stream;

    // --- the entrance ---
    if (!intro.done) {
      intro.warm++;
      intro.waited += rawDt;
      if (intro.t < 0) {
        const mark = outlines.seasons;
        if (mark && intro.warm >= 6) {
          glyphA.set(mark);
          glyphAttrs[0].needsUpdate = true;
          const [r, g, b, amount, gain] = SHAPE_TINT.seasons;
          coreUniforms.uShapeGain.value = gain;
          tintTarget.set(r, g, b);
          coreUniforms.uTint.value.set(r, g, b);
          tintAmtTarget = amount;
          intro.t = 0;
          canvas.style.opacity = "1";
        } else if (intro.waited > 4) finishIntro(); // no mark: just appear
      } else {
        intro.t += rawDt / INTRO_SECONDS;
        if (intro.t > 0.8) tintAmtTarget = 0;
        if (intro.t >= 1) finishIntro();
        else coreUniforms.uIntro.value = intro.t;
      }
    }
    // How lit she is during the entrance: a faint glow while she is dust,
    // the nucleus kindles as the mark folds in, full once the sphere is open.
    const introLight = intro.done ? 1 : intro.t < 0.6 ? 0.12 : Math.min(1, 0.12 + ((intro.t - 0.6) / 0.25) * 0.88);
    const introRings = intro.done ? 1 : Math.max(0, (intro.t - 0.82) / 0.18);

    // Symbols: each slot moves along its transition; a finished exit frees it.
    let formed = 0;
    let centred = 0;
    for (const slot of slots) {
      if (!slot.shape) continue;
      if (slot.leaving) slot.out = Math.min(1, slot.out + rawDt / GLYPH_OUT_SECONDS);
      else slot.in = Math.min(1, slot.in + rawDt / GLYPH_IN_SECONDS);
      if (slot.out >= 1) Object.assign(slot, { shape: null, in: 0, out: 0, leaving: false });
      const opened = Math.max(0, Math.min(1, (slot.in - 0.4) / 0.45));
      const fall = Math.max(0, Math.min(1, (slot.out - 0.3) / 0.44));
      formed = Math.max(formed, slot.out > 0 ? 1 - fall : opened);
      const inCentre = slot.in < 0.4 ? Math.min(1, slot.in / 0.36) ** 3 : 1 - opened;
      const outCentre = slot.out < 0.76 ? fall ** 4 : 1 - (slot.out - 0.76) / 0.24;
      centred = Math.max(centred, slot.out > 0 ? outCentre : slot.shape ? inCentre : 0);
    }
    u.uGlyph.value.set(slots[0].in, slots[0].out, slots[1].in, slots[1].out);
    if (!slots.some((slot) => slot.shape)) tintAmtTarget = 0;
    u.uGlyphOn.value = formed;
    shared.uFormed.value = formed;
    const tint = u.uTint.value;
    tint.set(
      ease(tint.x, tintTarget.x, rawDt, 2),
      ease(tint.y, tintTarget.y, rawDt, 2),
      ease(tint.z, tintTarget.z, rawDt, 2),
    );
    u.uTintAmt.value = ease(u.uTintAmt.value, tintAmtTarget, rawDt, 2);

    const sv = weights.speaking * voice.value;
    nucleusU.uEnergy.value =
      now.energy * now.coreVis * (1 + u.uBreath.value * (0.06 + (now.coreVis - 1) * 0.08)) +
      sv * 1.1 +
      shared.uPulse.value * 0.4;
    streakU.uStreak.value =
      now.streak * (0.85 + u.uBreath.value * 0.08) + sv * 0.7 + shared.uPulse.value * 0.25;

    // Orbit lines.
    rings.forEach(({ cfg, mesh, uniforms, holder }) => {
      holder.scale.setScalar(0.35 + now.scale * 0.65);
      uniforms.uAlpha.value = cfg.alpha * now.ring;
      uniforms.uPhase.value += dt * cfg.spin * 1.6 * now.ringSpin;
      mesh.rotation.z += dt * cfg.spin * 0.3;
    });

    // Hologram flicker, used sparingly.
    flickIn -= rawDt;
    if (!reduced && flickIn <= 0) {
      flickLeft = 0.1 + Math.random() * 0.12;
      flickIn = look.flickEvery * (0.6 + Math.random() * 0.8);
    }
    if (flickLeft > 0) {
      flickLeft -= rawDt;
      shared.uFlick.value = 0.72 + Math.random() * 0.3;
      finalPass.uniforms.uGlitch.value = 1;
    } else {
      shared.uFlick.value = 1;
      finalPass.uniforms.uGlitch.value = 0;
    }

    // Pointer, lift, layout of the centre on screen.
    pointer.x = ease(pointer.x, pointer.tx, rawDt, 2.2);
    pointer.y = ease(pointer.y, pointer.ty, rawDt, 2.2);
    shared.uPointer.value.set(pointer.x, pointer.y);
    root.rotation.set(-pointer.y * 0.14 + 0.08, pointer.x * 0.22, 0);
    lift.value = ease(lift.value, lift.target, rawDt, 2.4);
    const shrink = 1 - lift.value * 0.14;
    // Never quite still: a slow float, as if the night air holds her up.
    const float = reduced ? 0 : 1 - wisp.collapse;
    root.position.set(
      Math.sin(t * 0.31) * 0.05 * float,
      lift.value * liftUnits +
        (Math.sin(t * 0.52) * 0.07 + Math.sin(t * 0.87 + 1.3) * 0.025) * float,
      Math.sin(t * 0.23 + 2) * 0.04 * float,
    );
    root.scale.setScalar(shrink);

    // --- the burst at the end of thinking ---
    let implode = 0;
    if (burst.t >= 0) {
      burst.t += rawDt / BURST_SECONDS;
      if (burst.t >= 1) {
        // Everything is in the nucleus now: the point takes over from here.
        burst.t = -1;
        u.uBurst.value = 0;
        wisp.collapse = 1;
        burst.hold = 0.6;
        shared.uPulse.value = Math.min(1, shared.uPulse.value + 0.35);
        burst.done?.();
        burst.done = null;
      } else {
        u.uBurst.value = burst.t;
        implode = Math.max(0, (burst.t - 0.46) / 0.54) ** 2;
      }
    }
    burst.hold = Math.max(0, burst.hold - rawDt);
    const bursting = burst.t >= 0 ? 1 : 0;

    // --- the living point ---
    const home = root.position.clone();
    // Never let a bad frame poison the flight for good.
    if (![wisp.pos.x, wisp.pos.y, wisp.pos.z, wisp.vel.x, wisp.vel.y, wisp.vel.z].every(Number.isFinite)) {
      wisp.pos.copy(home);
      wisp.vel.set(0, 0, 0);
      wisp.target.copy(home);
    }
    const speakingNow = current === "speaking" && !reduced;
    const away = wisp.pos.distanceTo(home);
    const collapseTo = speakingNow || away > 0.1 || burst.hold > 0 ? 1 : 0;
    wisp.collapse = ease(wisp.collapse, collapseTo, rawDt, collapseTo > wisp.collapse ? 2.8 : 1.7);
    if (speakingNow && wisp.collapse > 0.55) {
      wisp.next -= rawDt;
      if (wisp.next <= 0) {
        const roll = Math.random() + voice.value * 0.25;
        // Down to the grass when the chat has its own column, above the text otherwise.
        const waterFy = frameX < 0.49 ? 0.84 : 0.66;
        if (roll < 0.22) {
          // Hover: a small drift, as if listening to itself.
          wisp.target.copy(wisp.pos).add(ray.set(rand(0.4), rand(0.28), rand(0.2)));
          wisp.stiff = 4;
          wisp.next = 1.6 + Math.random() * 1.2;
        } else {
          // A graceful glide to a new place, now and then a quicker, still smooth sweep.
          const span = Math.max(0.12, frameX - 0.08);
          onScreen(
            frameX + rand(span * 2),
            0.16 + Math.random() * Math.max(0.1, waterFy - 0.26),
            rand(1.6),
            wisp.target,
          );
          const sweep = roll > 0.78;
          wisp.stiff = sweep ? 11 : 6;
          wisp.next = sweep ? 1.3 + Math.random() * 0.8 : 1.9 + Math.random() * 1.4;
        }
      }
    } else wisp.target.copy(home);
    const k = speakingNow ? wisp.stiff : 14;
    // Near-critical damping: no overshoot, it eases in like something that flies.
    const damp = 2 * Math.sqrt(k) * (speakingNow ? 0.85 : 0.95);
    ray.copy(wisp.target).sub(wisp.pos).multiplyScalar(k).addScaledVector(wisp.vel, -damp);
    // A slight sideways lift turns straight lines into arcs.
    ray.x += -wisp.vel.y * 0.9;
    ray.y += wisp.vel.x * 0.9;
    wisp.vel.addScaledVector(ray, rawDt);
    wisp.pos.addScaledVector(wisp.vel, rawDt);
    const bob = wisp.collapse * (speakingNow ? 0.03 + voice.value * 0.012 : 0);
    wisp.shown
      .copy(wisp.pos)
      .add(
        ray.set(
          Math.sin(t * 1.1) * bob * 0.6,
          Math.sin(t * 1.7 + 1) * bob,
          Math.sin(t * 0.9 + 2) * bob * 0.4,
        ),
      );
    anchor.position.copy(wisp.shown);
    anchor.scale.setScalar(shrink * (0.97 + now.scale * 0.03) * (1 - wisp.collapse * 0.3));
    trailClock -= rawDt;
    if (trailClock <= 0) {
      trailClock = 0.04;
      for (let i = trailWorld.length - 1; i > 0; i--) trailWorld[i].copy(trailWorld[i - 1]);
    }
    trailWorld[0].copy(wisp.shown);
    root.updateMatrixWorld();
    coreUniforms.uTrail.value.forEach((local, i) => root.worldToLocal(local.copy(trailWorld[i])));
    coreUniforms.uCollapse.value = wisp.collapse;
    dustMat.uniforms.uWisp.value.copy(wisp.shown);
    dustMat.uniforms.uWispOn.value = wisp.collapse;
    // The orbit lines fold into the centre with everything else.
    const fold = Math.max(centred, bursting);
    rings.forEach(({ uniforms, holder }) => {
      uniforms.uAlpha.value *= (1 - wisp.collapse) * (1 - fold) * introRings;
      holder.scale.multiplyScalar((1 - fold * 0.8) * (0.2 + 0.8 * introRings));
    });
    // The scanning laser rests while she bursts and while she flies.
    sweepU.uCalm.value = (1 - bursting) * (1 - wisp.collapse);
    nucleusU.uEnergy.value *=
      (1 + wisp.collapse * (0.5 + voice.value * 0.9)) * (1 + implode * 1.6 + centred * 0.9) * introLight;
    streakU.uStreak.value *= (1 + wisp.collapse * 0.4) * introLight;

    proj.set(0, root.position.y, 0).project(camera);
    const cx = (proj.x * 0.5 + 0.5) * res.x,
      cy = (proj.y * 0.5 + 0.5) * res.y;
    sheenU.uR.value = now.scale;
    sheenU.uShine.value =
      (0.14 + weights.verified * 0.75 + formed * 0.25) *
      now.shell *
      (1 - weights.guard * 0.8) *
      (1 - wisp.collapse) *
      introRings;
    finalPass.uniforms.uCoreUv.value.set(cx / res.x, cy / res.y);

    // The field is lit by GAIA alone: still while she rests, following the point as it flies.
    proj.copy(wisp.shown).project(camera);
    field.setLightSource?.(
      [proj.x, proj.y],
      (1 + wisp.collapse * voice.value * 0.25) * now.bright * (0.15 + 0.85 * introLight),
    );
    // ...and moved by her: the downwash of the point, wind from her voice,
    // fireflies drawn to her by state.
    const [gatherTo, circleSpeed] = GATHER[current];
    gathering.amount = ease(gathering.amount, gatherTo, rawDt, gatherTo > gathering.amount ? 0.35 : 0.9);
    gathering.phase += dt * circleSpeed;
    fieldState.point[0] = proj.x;
    fieldState.point[1] = proj.y;
    fieldState.flying = wisp.collapse;
    fieldState.voice = voice.value * weights.speaking;
    fieldState.gather = gathering.amount * (1 - wisp.collapse);
    fieldState.circle = gathering.phase;
    const pan = proj.x;
    const near = wisp.collapse * Math.max(0, Math.min(1, (-0.35 - proj.y) / 0.4));
    // Fireflies circle her home, not the flying point: they never chase it.
    proj.copy(home).project(camera);
    centreTop
      .copy(home)
      .addScaledVector(camera.up, now.scale * shrink * (1 - wisp.collapse * 0.3))
      .project(camera);
    fieldState.centre[0] = proj.x;
    fieldState.centre[1] = proj.y;
    fieldState.radius = Math.abs(centreTop.y - proj.y) / 2;
    const gust = field.setGaia?.(fieldState) ?? 0;
    // Sound must never stop the picture: a failing listener is ignored.
    if (Number.isFinite(pan) && Number.isFinite(near)) {
      try {
        sceneListener?.({ pan, near, gust: Number.isFinite(gust) ? gust : 0 });
      } catch {
        /* audio errors stay out of the render loop */
      }
    }
    // Each receipt's fireflies land in her: a small brightening.
    while (landings.length && landings[0] <= time) {
      landings.shift();
      shared.uPulse.value = Math.min(1, shared.uPulse.value + 0.12);
    }
    fieldFrame.time += dt;
    fieldFrame.dt = rawDt;
    fieldFrame.pointer[0] = pointer.x;
    fieldFrame.pointer[1] = -pointer.y;

    bloom.strength = now.bloom * (1 + sv * 0.35 + shared.uPulse.value * 0.15 + implode * 0.5);
    composer.render(rawDt);
  };
  frame = requestAnimationFrame(tick);

  const api: GaiaCore = {
    setState(state: CoreState) {
      if (!STATES.includes(state)) return;
      if (state === "verified" && current !== "verified") field.gaiaWave?.();
      current = state;
      look = LOOKS[state];
      if (state === "verified" || state === "tool")
        shared.uPulse.value = Math.min(1, shared.uPulse.value + 0.3);
    },
    setShape(shape: CoreShape | null) {
      wanted = shape;
      const traced = shape === "mark" || shape === "seasons";
      const current = slots.find((slot) => slot.shape && !slot.leaving);
      if (current && current.shape === shape) return;
      // Whatever is shown folds back through the centre.
      if (current) current.leaving = true;
      // (The tint stays until the leaving symbol has folded away.)
      if (!shape || !(shape in SHAPE_TINT) || (traced && !outlines[shape])) return;
      // The new symbol opens out of the centre from a free slot (or the older one).
      // (Slot A holds the Seasons mark during the entrance.)
      const index = !intro.done
        ? 1
        : slots[0].shape === null
          ? 0
          : slots[1].shape === null
            ? 1
            : slots[0].out >= slots[1].out
              ? 0
              : 1;
      const data = index === 0 ? glyphA : glyphB;
      if (traced) data.set(outlines[shape]!);
      else sampleGlyph(shape as Exclude<CoreShape, "mark" | "seasons">, data, members);
      glyphAttrs[index].needsUpdate = true;
      Object.assign(slots[index], { shape, in: 0, out: 0, leaving: false });
      const [r, g, b, amount, gain] = SHAPE_TINT[shape];
      coreUniforms.uShapeGain.value = gain;
      tintTarget.set(r, g, b);
      tintAmtTarget = amount;
    },
    entrance() {
      return introDone;
    },
    burst() {
      if (reduced) return Promise.resolve();
      burst.done?.();
      return new Promise<void>((resolve) => {
        burst.t = 0;
        burst.done = resolve;
        shared.uPulse.value = Math.min(1, shared.uPulse.value + 0.5);
      });
    },
    pulse(strength = 0.35) {
      shared.uPulse.value = Math.min(1, shared.uPulse.value + strength);
    },
    setVoice(level: number) {
      voice.target = Math.max(0, Math.min(1, level || 0));
    },
    setPointer(x: number, y: number) {
      pointer.tx = Math.max(-1, Math.min(1, x));
      pointer.ty = Math.max(-1, Math.min(1, y));
    },
    setFrame(x: number) {
      const next = Math.max(0.2, Math.min(0.5, x || 0.5));
      if (Math.abs(next - frameX) < 0.002) return;
      frameX = next;
      applySize();
    },
    setLift(value: number) {
      lift.target = Math.max(0, Math.min(1, value));
    },
    feed(count = 1) {
      const n = Math.max(1, Math.min(8, Math.round(count)));
      field.gaiaFeed?.(n);
      const at = performance.now();
      for (let i = 0; i < n; i++) landings.push(at + 1500 + i * 280);
      landings.sort((a, b) => a - b);
    },
    onScene(listener) {
      sceneListener = listener;
    },
    dispose() {
      running = false;
      burst.done?.();
      introResolve();
      cancelAnimationFrame(frame);
      observer.disconnect();
      disposables.forEach((d) => d.dispose());
      field.dispose();
      bloom.dispose();
      finalPass.dispose();
      composer.dispose();
      renderer.dispose();
    },
  };
  drawShape = (shape) => api.setShape(shape);
  return api;
}
