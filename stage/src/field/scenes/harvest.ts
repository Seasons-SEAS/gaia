import * as T from "three";

import {
  BAR_FILL,
  createBackdrop,
  DCA_BARS,
  GLSL_NOISE,
  GLSL_PALETTE,
  GLSL_SPRITE,
  GOLD,
  GOLD_MINOR,
  mix,
  PHI,
  rng,
  smooth,
} from "../common";

import type { Frame, SceneModule } from "../types";

/**
 * 01 Harvest — "Let it grow". A night field of grain before layered mountain
 * ranges. Light rises from behind the highest peak, which stands on the right
 * golden vertical; the horizon lies on the lower golden line and the peaks
 * step down by φ. Stars fill the sky, and a fine stream of particles, as in
 * the v7 Hero, flows across it and sets behind the ranges. The field runs on
 * as dark ground to the foot of the mountains. Stalks are near-silhouettes;
 * only the ears catch the light
 * when a gust lifts them, and a few fireflies drift above the field. On scroll
 * the camera cranes up and the fireflies gather into nine stalks of light with
 * Fibonacci heights: points set a golden angle apart, crowned by sunflower
 * seed heads. The field grows the DCA chart out of its own light.
 */

const LEVELS = [0, 0.3, 0.55, 0.68, 0.74, 0.8, 0.86, 0.92, 0.97, 1];
const FOV = 36;
const TAN = Math.tan(T.MathUtils.degToRad(FOV / 2));
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PITCH = (mobile: boolean) => (mobile ? 0.9 : 1.2);
const ROW_Z = -6.5;
/** Every stalk clears the grass; the tallest reaches 3.7. */
const stalkHeight = (h: number) => 0.9 + 2.8 * h;
/** The highest summit: 0.146 (φ⁻⁴) of the frame above the horizon at rest. */
const SUMMIT = 0.094;
/** The hidden light, a little below the summit and far behind it. */
const LIGHT_DISTANCE = 700;
const LIGHT_ANGLE = 0.034;

const BLADE = /* glsl */ `
  uniform float time, build, orbOnly;
  uniform vec3 gust;
  uniform vec4 orb; // x, z on the field, strength, radius: a single light source
  uniform vec4 plots; // pitch, stalk radius, unused, row z
  // GAIA mode (all zero otherwise): her downwash and its fading trail (x, z,
  // strength, radius), wind rings from her voice (x, z, age, amplitude) and the
  // golden wave of a verified answer (x, z, age, amplitude).
  uniform vec4 wash[6];
  uniform vec4 rings[3];
  uniform vec4 golden;
  float gaiaGold;
  attribute vec4 iBase; // x, z, height, phase
  attribute vec4 iMisc; // ripe, lean, unused, unused
  // The light a stalk casts on the grass around its foot.
  float footprint(vec2 p, out float index){
    index = clamp(floor(p.x / plots.x + 4.5), 0., 8.);
    vec2 d = p - vec2((index - 4.) * plots.x, plots.w);
    float r = length(d) / (plots.y * 2.4);
    return exp(-r * r * 2.2);
  }
  vec3 blade(float t, out float ear, out float sheen, out float lit){
    vec2 p = iBase.xy;
    float h = iBase.z;
    float index;
    float near = footprint(p, index);
    lit = near * smoothstep(index * .06, index * .06 + .42, build);
    // Rolling gusts: the crest bends the stalks and lights their ears.
    float wave = .5 + .5 * sin(dot(p, vec2(.34, .12)) - time * 1.05 + vnoise(p * .11 + time * .035) * 2.6);
    wave *= wave * wave;
    // With a single source (GAIA), only the grass beneath her catches light.
    vec2 od = p - orb.xy;
    // Inverse-square-like falloff with a soft ceiling: a real lamp of GAIA's
    // colour, visible from high up, never blown out close.
    float raw = orb.z / (1. + dot(od, od) / (orb.w * orb.w));
    float orbLight = (1. - exp(-raw * 1.6)) * .72;
    // Wind from her voice: rings run out from the pool of her light, bend the
    // stalks as they pass and tip the ears into her light.
    vec2 windPush = vec2(0.);
    float windLight = 0.;
    for (int i = 0; i < 3; i++) {
      vec2 a = p - rings[i].xy;
      float d = length(a);
      float front = exp(-pow((d - rings[i].z * 3.4) / .8, 2.)) * rings[i].w * exp(-rings[i].z * .8);
      windPush += a / max(d, 1e-3) * front * .55;
      windLight += front;
    }
    // A verified answer: one warm wave crosses the whole field.
    vec2 ga = p - golden.xy;
    float gd = length(ga);
    gaiaGold = exp(-pow((gd - golden.z * 7.) / 2.2, 2.)) * golden.w * exp(-golden.z * .22);
    windPush += ga / max(gd, 1e-3) * gaiaGold * .3;
    // The wind only tips more of her own light into the ears: it approaches
    // the same soft ceiling as the brightest spot under her, never beyond it.
    float tip = windLight * (.06 + orbLight * .45);
    sheen = mix(wave, orbLight + (.72 - orbLight) * tip / (1. + tip), orbOnly);
    float flutter = sin(time * 2.2 + iBase.w * 6.283) * .045;
    vec2 dir = vec2(.96, -.26) * (.1 + .6 * wave) + vec2(flutter, flutter * .3) + vec2(iMisc.y * .1, 0.);
    vec2 away = p - gust.xy;
    dir += normalize(away + 1e-4) * gust.z * exp(-dot(away, away) * .14) * .9;
    // GAIA flying low: the air under her parts the grass, and the path she
    // leaves rises again slowly.
    for (int i = 0; i < 6; i++) {
      vec2 a = p - wash[i].xy;
      float fall = wash[i].z * exp(-dot(a, a) / (wash[i].w * wash[i].w));
      dir += normalize(a + 1e-4) * fall * 1.15;
    }
    dir += windPush;
    float bend = t * t;
    // Ears have a fixed length, so a tall stalk does not grow a giant ear.
    float earStart = 1. - .24 / max(h, .3);
    ear = smoothstep(earStart - .05, earStart + .06, t) * (1. - smoothstep(.95, 1., t));
    return vec3(p.x + dir.x * bend * h, t * h * (1. - .12 * bend * length(dir)), p.y + dir.y * bend * h);
  }
`;

function buildField(quality: number) {
  const random = rng(20260926);
  const count = Math.round(22000 * quality);
  const base = new Float32Array(count * 4);
  const misc = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const z = 2.6 - Math.pow(random(), 1.5) * 58;
    const x = (random() - 0.5) * (12 + (2.6 - z) * 1.2);
    base.set([x, z, 0.5 + random() * 0.45, random()], i * 4);
    misc.set([random() < 0.03 ? 1 : 0, random() * 2 - 1, 0, 0], i * 4);
  }
  // One stalk: a camera-facing strip; its width profile lives in the shader.
  const levels = LEVELS.length;
  const t = new Float32Array(levels * 2);
  const side = new Float32Array(levels * 2);
  const indices: number[] = [];
  LEVELS.forEach((value, i) => {
    t.set([value, value], i * 2);
    side.set([-1, 1], i * 2);
    if (i < levels - 1) indices.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  });
  const geometry = new T.InstancedBufferGeometry();
  geometry.setAttribute("position", new T.BufferAttribute(new Float32Array(levels * 2 * 3), 3));
  geometry.setAttribute("t", new T.BufferAttribute(t, 1));
  geometry.setAttribute("side", new T.BufferAttribute(side, 1));
  geometry.setIndex(indices);
  geometry.setAttribute("iBase", new T.InstancedBufferAttribute(base, 4));
  geometry.setAttribute("iMisc", new T.InstancedBufferAttribute(misc, 4));
  geometry.instanceCount = count;

  // Glints: ripe ears catching the light.
  const glints: number[] = [];
  for (let i = 0; i < count; i++) if (misc[i * 4] > 0.5) glints.push(i);
  const gBase = new Float32Array(glints.length * 4);
  const gMisc = new Float32Array(glints.length * 4);
  glints.forEach((src, i) => {
    gBase.set(base.subarray(src * 4, src * 4 + 4), i * 4);
    gMisc.set(misc.subarray(src * 4, src * 4 + 4), i * 4);
  });
  const glintGeometry = new T.InstancedBufferGeometry();
  glintGeometry.setAttribute("position", new T.BufferAttribute(new Float32Array(3), 3));
  glintGeometry.setAttribute("iBase", new T.InstancedBufferAttribute(gBase, 4));
  glintGeometry.setAttribute("iMisc", new T.InstancedBufferAttribute(gMisc, 4));
  glintGeometry.instanceCount = glints.length;

  return { geometry, glintGeometry };
}

/** 1D value-noise fBm for ridgelines; ridged octaves give sharp crests. */
function ridgeNoise(seed: number) {
  const random = rng(seed);
  const table = Float32Array.from({ length: 1024 }, () => random());
  const noise = (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = table[i & 1023];
    const b = table[(i + 1) & 1023];
    return a + (b - a) * f * f * (3 - 2 * f);
  };
  return (x: number, ridged: boolean) => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    for (let o = 0; o < 6; o++) {
      const n = noise(x * freq + o * 31.7);
      sum += amp * (ridged ? 1 - Math.abs(2 * n - 1) : n);
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum;
  };
}

type Range = {
  distance: number;
  seed: number;
  /** x as a share of the rest view, summit (radians over the horizon), half-width, skew. */
  peaks: [number, number, number, number][];
  floor: number;
  /** Serration of the ridgeline, as a share of each summit. */
  jag: number;
  tone: [number, number, number];
  haze: number;
  rim: number;
};

// Three ranges, far to near, each darker and lower: aerial perspective in
// steps. Summits step down by φ — the highest on the right golden vertical,
// shoulders on the 0.382 and 0.854 lines — and valleys leave room for the
// range behind.
const RANGES: Range[] = [
  {
    distance: 900,
    seed: 5,
    peaks: [
      [GOLD, SUMMIT, 0.19, 0.22],
      [GOLD + 0.118, SUMMIT / PHI, 0.09, -0.1],
      [GOLD - 0.146, SUMMIT / PHI ** 2, 0.1, 0.1],
      [0.236, SUMMIT / PHI ** 3, 0.13, 0],
      [0.95, SUMMIT / PHI ** 2, 0.14, -0.2],
    ],
    floor: 0.016,
    jag: 0.16,
    tone: [0.105, 0.07, 0.215],
    haze: 0.55,
    rim: 1,
  },
  {
    distance: 560,
    seed: 8,
    peaks: [
      [GOLD_MINOR, SUMMIT / PHI ** 2, 0.17, 0.15],
      [0.854, SUMMIT / PHI ** 2.5, 0.12, -0.1],
      [1.16, SUMMIT / PHI, 0.2, 0],
      [0.02, SUMMIT / PHI ** 3, 0.14, 0],
    ],
    floor: 0.012,
    jag: 0.12,
    tone: [0.068, 0.044, 0.15],
    haze: 0.4,
    rim: 0.3,
  },
  {
    distance: 330,
    seed: 13,
    peaks: [
      [0.09, SUMMIT / PHI ** 3, 0.2, 0.1],
      [0.764, SUMMIT / PHI ** 4, 0.16, -0.15],
      [1.05, SUMMIT / PHI ** 3, 0.18, 0],
    ],
    floor: 0.008,
    jag: 0.08,
    tone: [0.04, 0.026, 0.094],
    haze: 0.24,
    rim: 0.1,
  },
];

function buildRange(range: Range) {
  const noise = ridgeNoise(range.seed);
  const columns = 1100;
  const ridge = new Float32Array((columns + 1) * 4);
  const tops = new Float32Array((columns + 1) * 2);
  const indices: number[] = [];
  for (let i = 0; i <= columns; i++) {
    const x = -0.5 + (2 * i) / columns;
    let angle = range.floor * (0.35 + 0.65 * noise(x * 5, false));
    for (const [px, summit, width, skew] of range.peaks) {
      // Asymmetric flanks: one side long and gentle, the other steep.
      const w = x < px ? width * (1 + skew) : width * (1 - skew);
      const t = Math.max(0, 1 - Math.abs(x - px) / w);
      const body = summit * Math.pow(t, 1.35) * (0.82 + 0.36 * noise(x * 19 + px * 7, true));
      angle = Math.max(angle, body + range.floor * 0.4) + body * 0.08;
      // Fine serration along the crest.
      angle += summit * range.jag * (noise(x * 97 + px * 13, true) - 0.5) * t;
    }
    // Top at the ridgeline, bottom well under the field's far edge.
    ridge.set([x, angle, x, -0.2], i * 4);
    tops.set([angle, angle], i * 2);
    if (i < columns) {
      const k = i * 2;
      indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute(
    "position",
    new T.BufferAttribute(new Float32Array((columns + 1) * 2 * 3), 3),
  );
  geometry.setAttribute("ridge", new T.BufferAttribute(ridge, 2));
  geometry.setAttribute("top", new T.BufferAttribute(tops, 1));
  geometry.setIndex(indices);
  return geometry;
}

/** Stars on the sky dome: golden-angle spacing with jitter, few bright ones. */
function buildStars(quality: number) {
  const random = rng(6765);
  const count = Math.round(6765 * Math.max(quality, 0.6));
  const dirs = new Float32Array(count * 3);
  const data = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const y = -0.02 + 0.98 * ((i + random()) / count);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * GOLDEN_ANGLE + random() * 0.6;
    dirs.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
    data.set([Math.pow(random(), 5), random()], i * 2);
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute("position", new T.BufferAttribute(dirs, 3));
  geometry.setAttribute("star", new T.BufferAttribute(data, 2));
  return geometry;
}

/**
 * Fireflies that become the chart. Each point has a free place over the field
 * and a slot: on a stalk (golden angle between successive points, rising) or
 * in its seed head (Vogel's sunflower model, r ∝ √n).
 */
function buildFireflies(quality: number, mobile: boolean) {
  const random = rng(1597);
  const density = Math.round(233 * Math.max(quality, 0.55));
  const capCount = 233;
  const slots: number[] = [];
  DCA_BARS.forEach((bar, column) => {
    const n = Math.round(density * stalkHeight(bar.height));
    for (let i = 0; i < n; i++)
      slots.push(column, (i + 0.5) / n, (i * GOLDEN_ANGLE) % (Math.PI * 2), 0);
    for (let i = 0; i < capCount; i++)
      slots.push(column, (i + 0.5) / capCount, (i * GOLDEN_ANGLE) % (Math.PI * 2), 1);
  });
  const count = slots.length / 4;
  const free = new Float32Array(count * 4);
  const misc = new Float32Array(count * 4);
  const spread = mobile ? 4.5 : 7.5;
  for (let i = 0; i < count; i++) {
    const z = 1.5 - Math.pow(random(), 0.8) * 26;
    free.set(
      [(random() - 0.5) * 2 * (spread + (1.5 - z) * 0.45), z, 0.9 + random() * 1.1, random()],
      i * 4,
    );
    misc.set([random(), random(), random(), random()], i * 4);
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute("position", new T.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("aSlot", new T.BufferAttribute(new Float32Array(slots), 4));
  geometry.setAttribute("aFree", new T.BufferAttribute(free, 4));
  geometry.setAttribute("aMisc", new T.BufferAttribute(misc, 4));
  return geometry;
}

const harvest: SceneModule = {
  antialias: true,
  create({ renderer, quality, mobile }) {
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(FOV, 1, 0.1, 1500);

    // Rest: the horizon on the lower golden line (tan θ = 0.236·tan(FOV/2)).
    const lift = (1 - 2 * GOLD_MINOR) * TAN;
    const start = mobile
      ? { pos: new T.Vector3(0, 1.6, 8.4), look: new T.Vector3(0, 1.6 + lift * 38.4, -30) }
      : { pos: new T.Vector3(0, 1.45, 7.4), look: new T.Vector3(0, 1.45 + lift * 37.4, -30) };
    // End: the row spans 0.618 of the width, the tallest seed head just under
    // the DCA copy, the feet near the 0.854 line.
    const end = mobile
      ? { pos: new T.Vector3(0, 8.4, 11.5), look: new T.Vector3(0, 2.4, -6.5) }
      : { pos: new T.Vector3(0, 6.9, 8.4), look: new T.Vector3(0, 2.5, -6.5) };

    const uniforms = {
      time: { value: 0 },
      build: { value: 0 },
      gust: { value: new T.Vector3(0, -40, 0) },
      orb: { value: new T.Vector4(0, -8, 0, 3) },
      orbOnly: { value: 0 },
      wash: { value: Array.from({ length: 6 }, () => new T.Vector4(0, -80, 0, 1)) },
      rings: { value: Array.from({ length: 3 }, () => new T.Vector4(0, -80, 9, 0)) },
      golden: { value: new T.Vector4(0, -80, 40, 0) },
      // GAIA's sphere in field space (x, y, z, radius); the share of fireflies
      // drawn to her and the phase of their circling; one start time per
      // receipt channel (a few fireflies each fly into her).
      gaia: { value: new T.Vector4(0, 2, -4, 0.5) },
      gather: { value: new T.Vector2(0, 0) },
      feeds: { value: new Array(8).fill(-100) },
      pixelWorld: { value: 0.001 },
      pixelAngle: { value: 0.001 },
      fogColor: { value: new T.Color(0.066, 0.04, 0.14) },
      fogRange: { value: new T.Vector2(6, 48) },
      pixelRatio: { value: renderer.getPixelRatio() },
      focus: { value: 0 },
      res: { value: new T.Vector2(1, 1) },
      aspect: { value: 1 },
      // The hidden light behind the summit, projected every frame.
      light: { value: new T.Vector2(GOLD, GOLD_MINOR) },
      lightStrength: { value: 1 },
      skyFade: { value: 1 },
      rangeFade: { value: 0 },
      copyDim: { value: 0 },
      horizon: { value: GOLD_MINOR },
      // The camera at rest: the ranges are art-directed in that view.
      rest: { value: new T.Vector2(start.pos.y, start.pos.z) },
      // Nine stalks: diameter : pitch = 1 : φ.
      plots: { value: new T.Vector4(PITCH(mobile), (PITCH(mobile) * BAR_FILL) / 2, 0, ROW_Z) },
      heights: { value: DCA_BARS.map((b) => stalkHeight(b.height)) },
    };

    const backdrop = createBackdrop(/* glsl */ `
      // Night sky: ink overhead, violet dusk over the ranges.
      float above = uv.y - horizon;
      col = mix(col, INK * .72, smoothstep(0., .5, above) * .85);
      col += vec3(.06, .03, .14) * exp(-pow(max(above, 0.) / .14, 1.3));
      // Light rising from behind the highest peak: a hot core the summit
      // hides, a bloom above the ridges, a wide violet wash and slow shafts.
      vec2 dl = (uv - light) * vec2(res.x / res.y, 1.);
      float core = exp(-(dl.x * dl.x / .006 + dl.y * dl.y / .0022));
      float bloom = exp(-(dl.x * dl.x / .07 + dl.y * dl.y / .024));
      float wash = exp(-length(dl * vec2(.62, 1.)) / .42);
      float ang = atan(dl.y, dl.x);
      float shafts = smoothstep(.5, .95, vnoise(vec2(ang * 9., time * .018)) * .65 + vnoise(vec2(ang * 23. + 4., time * .026)) * .35);
      shafts *= exp(-length(dl) * 2.6) * smoothstep(0., .06, dl.y);
      col += (mix(LILAC, PEARL, .55) * core * .75 + mix(VIOLET, LILAC, .5) * bloom * .36
        + VIOLET * wash * .15 + LILAC * shafts * .07) * lightStrength;
    `);
    backdrop.material.uniforms.horizon = uniforms.horizon;
    backdrop.material.uniforms.light = uniforms.light;
    backdrop.material.uniforms.lightStrength = uniforms.lightStrength;
    backdrop.material.fragmentShader = backdrop.material.fragmentShader.replace(
      "uniform vec2 res;",
      "uniform float horizon, lightStrength; uniform vec2 light; uniform vec2 res;",
    );
    backdrop.uniforms.glowStrength.value = 0;
    scene.add(backdrop.mesh);

    // Mountain ranges: opaque silhouettes, hazier with distance, a thin
    // lining of light along the ridges nearest the hidden light.
    const rangeGeometries = RANGES.map(buildRange);
    const rangeMaterials = RANGES.map(
      (range) =>
        new T.ShaderMaterial({
          uniforms: {
            ...uniforms,
            rangeDistance: { value: range.distance },
            tone: { value: new T.Vector3(...range.tone) },
            haze: { value: range.haze },
            rimStrength: { value: range.rim },
          },
          side: T.DoubleSide,
          vertexShader: /* glsl */ `
            uniform float rangeDistance, aspect;
            uniform vec2 rest;
            attribute vec2 ridge; attribute float top;
            varying float vAngle; varying float vTop;
            void main(){
              float depth = rangeDistance + rest.y;
              vec3 p = vec3((ridge.x - .5) * 2. * ${TAN.toFixed(6)} * aspect * depth, rest.x + depth * tan(ridge.y), -rangeDistance);
              vAngle = ridge.y; vTop = top;
              gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
            }`,
          fragmentShader:
            GLSL_PALETTE +
            /* glsl */ `
            uniform vec3 tone; uniform float haze, rimStrength, lightStrength, pixelAngle, rangeFade;
            uniform vec2 light, res;
            varying float vAngle; varying float vTop;
            void main(){
              vec2 uv = gl_FragCoord.xy / res;
              vec2 dl = (uv - light) * vec2(res.x / res.y, 1.);
              float near = exp(-dot(dl, dl) / .05);
              float wide = exp(-dot(dl, dl) / .6);
              float behind = exp(-dl.x * dl.x / .012);
              vec3 hazeCol = mix(DEEP * 1.3, mix(VIOLET, LILAC, .4) * .45, near * lightStrength);
              vec3 col = mix(tone, hazeCol, haze * (.35 + .65 * wide));
              // Backlit ridges: a hairline of light where the light is behind them.
              // Only the far range sees the light itself; nearer ranges stand
              // in its shadow and keep just a faint sky rim.
              float sees = step(.99, rimStrength);
              float below = max(vTop - vAngle, 0.);
              float rim = exp(-below / (pixelAngle * 1.25)) * (.03 + sees * (1.25 * behind + .25 * near)) * rimStrength;
              float spill = exp(-below / (pixelAngle * 9.)) * behind * .22 * sees;
              col += mix(LILAC, PEARL, .5) * rim * lightStrength + mix(VIOLET, LILAC, .5) * spill * lightStrength;
              col = mix(col, INK * .8, rangeFade);
              gl_FragColor = vec4(col, 1.);
            }`,
        }),
    );
    rangeGeometries.forEach((g, i) => {
      const mesh = new T.Mesh(g, rangeMaterials[i]);
      mesh.frustumCulled = false;
      mesh.renderOrder = -5 - i;
      scene.add(mesh);
    });

    // Stars at infinity, behind the ranges; the light washes out the faint ones.
    const starGeometry = buildStars(quality);
    const starMaterial = new T.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      vertexShader:
        GLSL_PALETTE +
        /* glsl */ `
        uniform float time, pixelRatio, lightStrength, skyFade;
        uniform vec2 light, res;
        attribute vec2 star; // magnitude, phase
        varying float vAlpha; varying vec3 vTint;
        void main(){
          vec4 clip = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.);
          clip.z = clip.w * .99999;
          gl_Position = clip;
          vec2 uv = clip.xy / clip.w * .5 + .5;
          vec2 dl = (uv - light) * vec2(res.x / res.y, 1.);
          float wash = exp(-dot(dl, dl) / .05) * lightStrength;
          float low = smoothstep(-.01, .14, position.y);
          float twinkle = .62 + .38 * sin(time * (.7 + star.y * 2.4) + star.y * 50.);
          vAlpha = (.16 + .95 * star.x) * twinkle * low * (1. - .9 * wash) * mix(.55, 1., skyFade);
          gl_PointSize = (.9 + 2.3 * star.x) * pixelRatio;
          vTint = mix(mix(LILAC, PEARL, .65), LIME, step(.988, fract(star.y * 91.)));
        }`,
      fragmentShader:
        GLSL_SPRITE +
        /* glsl */ `
        varying float vAlpha; varying vec3 vTint;
        void main(){ gl_FragColor = vec4(vTint * sprite(gl_PointCoord, 4.) * vAlpha, 1.); }`,
    });
    const stars = new T.Points(starGeometry, starMaterial);
    stars.frustumCulled = false;
    scene.add(stars);

    // The sky stream, in the v7 Hero's particle language: fine points flowing
    // left to right in a wide band, bright currents on the 0.382 and 0.618
    // lanes, sparse crisp glints. It passes above the Hero copy and the summit
    // and sets behind the right-hand ranges.
    const streamRandom = rng(17711);
    const streamCount = Math.round(28657 * Math.max(quality, 0.5));
    const stream = new Float32Array(streamCount * 4);
    for (let i = 0; i < streamCount; i++)
      stream.set([streamRandom(), streamRandom(), streamRandom(), streamRandom()], i * 4);
    const streamGeometry = new T.BufferGeometry();
    streamGeometry.setAttribute(
      "position",
      new T.BufferAttribute(new Float32Array(streamCount * 3), 3),
    );
    streamGeometry.setAttribute("stream", new T.BufferAttribute(stream, 4));
    const streamMaterial = new T.ShaderMaterial({
      uniforms: {
        ...uniforms,
        // The Hero copy: the stream dims behind it until the copy leaves.
        copyBox: { value: new T.Vector4(0.02, 0.3, 0.52, 0.74) },
      },
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      vertexShader:
        GLSL_PALETTE +
        /* glsl */ `
        uniform float time, pixelRatio, aspect, skyFade, copyDim, horizon;
        uniform vec4 copyBox;
        attribute vec4 stream; // phase along, lane across, pace, brightness
        varying float vAlpha; varying float vSoft; varying vec3 vTint;
        vec2 bez(vec2 a, vec2 b, vec2 c, vec2 d, float t){
          float s = 1. - t;
          return s * s * s * a + 3. * s * s * t * b + 3. * s * t * t * c + t * t * t * d;
        }
        void main(){
          float b = stream.w;
          float t = fract(stream.x + time * (.009 + stream.z * .006));
          // Control points in frame heights (x scaled by the aspect).
          vec2 A = vec2(-.1 * aspect, .97), B = vec2(.35 * aspect, .93);
          vec2 C = vec2(.78 * aspect, .66), D = vec2(1.12 * aspect, .36);
          vec2 p = bez(A, B, C, D, t);
          vec2 tangent = 3. * (1. - t) * (1. - t) * (B - A) + 6. * (1. - t) * t * (C - B) + 3. * t * t * (D - C);
          vec2 normal = normalize(vec2(-tangent.y, tangent.x));
          float lane = stream.y;
          // Wider where it enters, as if nearer, narrowing as it recedes.
          p += normal * (lane - .5) * mix(.14, .07, t);
          p += normal * sin(t * 11. + lane * 9. + time * .2) * .002;
          vec2 uv = vec2(p.x / aspect, p.y + horizon - ${GOLD_MINOR.toFixed(6)});
          gl_Position = vec4(uv * 2. - 1., .99995, 1.);

          float current = exp(-pow((lane - .382) * 10., 2.)) + .45 * exp(-pow((lane - .618) * 20., 2.));
          float edges = smoothstep(0., .18, lane) * (1. - smoothstep(.82, 1., lane));
          float ends = smoothstep(0., .08, t) * (1. - smoothstep(.9, 1., t));
          float crisp = step(.8, b);
          float glint = crisp * pow(.5 + .5 * sin(time * (1.2 + b * .8) + stream.x * 181. + lane * 57.), 12.);
          vec2 inside = smoothstep(copyBox.xy - .04, copyBox.xy, uv) * (1. - smoothstep(copyBox.zw, copyBox.zw + .04, uv));
          float behindCopy = inside.x * inside.y * (1. - copyDim);
          vAlpha = (.1 + b * .26 + current * .4) * edges * ends * mix(1., 2.1, crisp) * (1. + glint * .6)
            * .55 * skyFade * (1. - .7 * behindCopy);
          vec3 tint = mix(vec3(.3775, .31, .58), vec3(.8175, .79, .9), clamp(.3 + current, 0., 1.));
          tint = mix(tint, vec3(.9425, .93, .98), crisp * .88);
          vTint = mix(tint, LIME, step(.992, b));
          float near = pow(1. - t, 3.);
          vSoft = (1. - crisp) * (.35 + .65 * near);
          gl_PointSize = mix(.9 + b * 1.3 + near * b * b * 5., 1.2 + b * .9, crisp) * pixelRatio * (1. + glint * .3);
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha; varying float vSoft; varying vec3 vTint;
        void main(){
          float d = length(gl_PointCoord - .5) * 2.;
          float a = exp(-d * d * mix(6., 3.5, vSoft)) * (1. - smoothstep(.35, 1., d));
          gl_FragColor = vec4(vTint * a * vAlpha, 1.);
        }`,
    });
    const streamPoints = new T.Points(streamGeometry, streamMaterial);
    streamPoints.frustumCulled = false;
    scene.add(streamPoints);

    // Shooting stars: three streaks on Fibonacci periods, each cycle placed
    // anew from a hash, falling toward the lower left over the ranges.
    const meteorGeometry = new T.InstancedBufferGeometry();
    meteorGeometry.setAttribute("position", new T.BufferAttribute(new Float32Array(12), 3));
    meteorGeometry.setAttribute(
      "q",
      new T.BufferAttribute(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), 2),
    );
    meteorGeometry.setIndex([0, 2, 1, 1, 2, 3]);
    meteorGeometry.setAttribute(
      "meteor",
      new T.InstancedBufferAttribute(
        new Float32Array([13, 0.31, 0.17, 0.73, 21, 0.67, 0.41, 0.29, 34, 0.12, 0.83, 0.57]),
        4,
      ),
    );
    meteorGeometry.instanceCount = 3;
    const meteorMaterial = new T.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
      blending: T.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float time, aspect, pixelRatio, skyFade, horizon;
        uniform vec2 res;
        attribute vec2 q; attribute vec4 meteor; // period, offset, seeds
        varying float vFade; varying float vAlong;
        float hash(float n){ return fract(sin(n) * 43758.5453); }
        void main(){
          float clock = time + meteor.y * meteor.x;
          float cycle = floor(clock / meteor.x);
          float k = (clock - cycle * meteor.x) / 1.3;
          vec2 start = vec2(mix(.46, .97, hash(cycle * 12.99 + meteor.z * 78.2)) * aspect,
            mix(horizon + .22, .97, hash(cycle * 39.35 + meteor.w * 11.1)));
          float ang = mix(-2.75, -2.3, hash(cycle * 73.16 + meteor.z * 3.1));
          vec2 dir = vec2(cos(ang), sin(ang));
          float travel = mix(.16, .3, hash(cycle * 5.7 + meteor.w));
          vec2 head = start + dir * travel * (1. - pow(1. - clamp(k, 0., 1.), 2.));
          float tail = .11 * sin(3.14159 * clamp(k, 0., 1.)) + .01;
          vec2 p = head - dir * tail * q.x + vec2(-dir.y, dir.x) * q.y * 1.1 * pixelRatio / res.y;
          gl_Position = vec4(p.x / aspect * 2. - 1., p.y * 2. - 1., .99995, 1.);
          vFade = step(k, 1.) * sin(3.14159 * clamp(k, 0., 1.)) * skyFade;
          vAlong = q.x;
        }`,
      fragmentShader:
        GLSL_PALETTE +
        /* glsl */ `
        varying float vFade; varying float vAlong;
        void main(){ gl_FragColor = vec4(mix(PEARL, LILAC, vAlong) * pow(1. - vAlong, 1.8) * vFade * .8, 1.); }`,
    });
    const meteors = new T.Mesh(meteorGeometry, meteorMaterial);
    meteors.frustumCulled = false;
    scene.add(meteors);

    const { geometry, glintGeometry } = buildField(quality);
    const bladeMaterial = new T.ShaderMaterial({
      uniforms,
      vertexShader:
        GLSL_NOISE +
        BLADE +
        /* glsl */ `
        attribute float t; attribute float side;
        uniform float pixelWorld; uniform vec2 fogRange;
        varying float vT, vFog, vEar, vRipe, vSheen, vLit, vGold;
        void main(){
          float ear, sheen, lit;
          vec3 pos = blade(t, ear, sheen, lit);
          vGold = gaiaGold;
          vec4 mv = modelViewMatrix * vec4(pos, 1.);
          float w = (.0036 * (1. - t * .4) + ear * .0082) * (1. + iMisc.y * .2);
          w = max(w, pixelWorld * -mv.z * .45);
          mv.x += side * w;
          gl_Position = projectionMatrix * mv;
          vT = t; vEar = ear; vRipe = iMisc.x; vSheen = sheen; vLit = lit;
          vFog = smoothstep(fogRange.x, fogRange.y, -mv.z);
        }`,
      fragmentShader:
        GLSL_PALETTE +
        /* glsl */ `
        uniform vec3 fogColor; uniform vec2 res, light; uniform float focus, lightStrength;
        varying float vT, vFog, vEar, vRipe, vSheen, vLit, vGold;
        void main(){
          // Night: stalks are silhouettes; a passing gust lifts the ears into
          // the light, and the stalks of light glow on the grass at their feet.
          float light2 = pow(vSheen, 1.4);
          vec3 stem = mix(vec3(.016, .011, .036), vec3(.07, .046, .15), vT);
          stem += vec3(.1, .07, .22) * light2 * vT * vT * vT + vec3(.16, .11, .34) * vLit * pow(vT, 3.);
          vec3 ear = vec3(.1, .066, .2) + vec3(.62, .52, 1.) * (light2 * .95 + vLit * (.35 + .4 * light2));
          vec3 col = mix(stem, ear, vEar);
          // The golden wave warms the ears most, the stems a little.
          col += vec3(1., .74, .34) * vGold * (.09 + .36 * vEar) * (.3 + .7 * vT);
          // The rest of the field steps back while the stalks grow.
          col *= mix(1., .6, focus * (1. - smoothstep(0., .25, vLit)));
          col *= mix(.45, 1., smoothstep(.0, .42, gl_FragCoord.y / res.y));
          // Far rows fade into the same dark haze as the ground under them.
          col = mix(col, fogColor, vFog);
          gl_FragColor = vec4(col, 1.);
        }`,
    });
    const blades = new T.Mesh(geometry, bladeMaterial);
    blades.frustumCulled = false;
    scene.add(blades);

    // Ground: the dark underlay of the field. It carries on beyond the last
    // stalks to the foot of the ranges, fading into the same haze, and far
    // off the gusts still move across it as faint bands of light.
    const groundGeometry = new T.PlaneGeometry(1800, 1100)
      .rotateX(-Math.PI / 2)
      .translate(0, -0.01, -540);
    const groundMaterial = new T.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vW; varying float vDepth;
        void main(){
          vec4 w = modelMatrix * vec4(position, 1.);
          vW = w.xyz;
          vec4 mv = viewMatrix * w;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader:
        GLSL_NOISE +
        /* glsl */ `
        uniform vec3 fogColor; uniform vec2 fogRange, res; uniform float time, focus, orbOnly; uniform vec4 orb, golden;
        varying vec3 vW; varying float vDepth;
        void main(){
          vec3 col = mix(vec3(.016, .011, .036), fogColor, smoothstep(fogRange.x, fogRange.y, vDepth));
          vec2 p = vW.xz;
          float wave = .5 + .5 * sin(dot(p, vec2(.34, .12)) - time * 1.05 + vnoise(p * .11 + time * .035) * 2.6);
          col += vec3(.03, .02, .066) * wave * wave * wave * smoothstep(20., 60., vDepth) * (1. - smoothstep(160., 420., vDepth)) * (1. - orbOnly);
          vec2 od = p - orb.xy;
          col += vec3(.05, .032, .11) * (1. - exp(-orb.z / (1. + dot(od, od) / (orb.w * orb.w * 2.2)))) * orbOnly;
          float gd = length(p - golden.xy);
          col += vec3(.07, .05, .02) * exp(-pow((gd - golden.z * 7.) / 2.6, 2.)) * golden.w * exp(-golden.z * .22) * (1. - smoothstep(20., 70., vDepth));
          col *= mix(1., .6, focus);
          col *= mix(.45, 1., smoothstep(.0, .42, gl_FragCoord.y / res.y));
          gl_FragColor = vec4(col, 1.);
        }`,
    });
    const earth = new T.Mesh(groundGeometry, groundMaterial);
    earth.frustumCulled = false;
    // Drawn after the grass, so the depth test skips what the stalks cover.
    earth.renderOrder = 1;
    scene.add(earth);

    const glintMaterial = new T.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      vertexShader:
        GLSL_NOISE +
        BLADE +
        /* glsl */ `
        uniform float pixelRatio; uniform vec2 fogRange;
        varying float vAlpha;
        void main(){
          float ear, sheen, lit;
          vec3 pos = blade(.86, ear, sheen, lit);
          vec4 mv = modelViewMatrix * vec4(pos, 1.);
          gl_Position = projectionMatrix * mv;
          float twinkle = pow(.5 + .5 * sin(time * (1.3 + iBase.w * 1.8) + iBase.w * 40.), 8.);
          float fade = 1. - smoothstep(fogRange.x, fogRange.y * .75, -mv.z);
          vAlpha = fade * (.15 + .85 * twinkle) * (.35 + .65 * max(sheen, lit));
          gl_PointSize = clamp(14. / -mv.z, 1.1, 5.) * pixelRatio * (.7 + .5 * twinkle);
        }`,
      fragmentShader:
        GLSL_PALETTE +
        GLSL_SPRITE +
        /* glsl */ `
        varying float vAlpha;
        void main(){ gl_FragColor = vec4(LIME * sprite(gl_PointCoord, 5.) * vAlpha, 1.); }`,
    });
    const glints = new T.Points(glintGeometry, glintMaterial);
    glints.frustumCulled = false;
    scene.add(glints);

    const fireflyGeometry = buildFireflies(quality, mobile);
    const fireflyMaterial = new T.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      vertexShader:
        GLSL_PALETTE +
        /* glsl */ `
        uniform float time, build, pixelRatio, pixelWorld;
        uniform vec4 plots, gaia;
        uniform vec2 gather;
        uniform float heights[9];
        uniform float feeds[8];
        attribute vec4 aSlot; // column, share, angle, seed head
        attribute vec4 aFree; // x, z, height, delay
        attribute vec4 aMisc; // phase, brightness, firefly, unused
        varying float vAlpha; varying vec3 vTint;
        void main(){
          float c = aSlot.x;
          float grow = smoothstep(c * .06, c * .06 + .42, build);
          float h = max(heights[int(c + .5)] * grow, .02);
          vec3 axis = vec3((c - 4.) * plots.x, 0., plots.w);
          float R = plots.y;
          float spin = time * .16;
          float head = aSlot.w;
          vec3 slot;
          float slotAlpha;
          vec3 slotTint;
          if (head < .5) {
            // A stalk: successive points a golden angle apart, the lattice rising.
            float f = fract(aSlot.y + time * .012);
            float a = aSlot.z + spin;
            vec3 n = vec3(cos(a), 0., sin(a));
            slot = axis + n * R + vec3(0., f * h, 0.);
            float facing = dot(n, normalize(cameraPosition - slot));
            slotAlpha = mix(.26, .9, smoothstep(-.3, .45, facing)) * smoothstep(0., .06, f) * (1. - smoothstep(.9, .99, f));
            slotTint = mix(mix(VIOLET, LILAC, .35), mix(LILAC, PEARL, .5), f);
          } else {
            // Seed head: Vogel's sunflower, r ∝ √n, turned toward the viewer the
            // way sunflowers follow the light; young florets glow at the heart.
            float a = aSlot.z - spin * 1.4;
            float rr = R * 1.18 * sqrt(aSlot.y);
            vec3 top = axis + vec3(0., h + .06, 0.);
            vec3 n = normalize(mix(vec3(0., 1., 0.), normalize(cameraPosition - top), .6));
            vec3 e1 = normalize(cross(vec3(0., 1., 0.), n));
            vec3 e2 = cross(n, e1);
            slot = top + (e1 * cos(a) + e2 * sin(a)) * rr + n * (1. - aSlot.y) * .07;
            slotAlpha = 1.;
            slotTint = mix(mix(PEARL, LIME, .55), mix(LILAC, PEARL, .6), sqrt(aSlot.y));
          }
          slot += vec3(sin(time * 1.3 + aMisc.x * 40.), sin(time * 1.1 + aMisc.x * 23.), cos(time * 1.2 + aMisc.x * 31.)) * .01;
          // The stalks sway with the wind, most at the head.
          float sway = (.6 * sin(time * .8 + c * .7) + .4 * sin(time * 1.9 + c * 2.3)) * .07;
          slot.xz += vec2(.96, -.26) * sway * pow(clamp(slot.y / max(h, .1), 0., 1.2), 2.);

          // Free: a firefly wandering over the field.
          vec3 free = vec3(aFree.x, aFree.z, aFree.y);
          free += vec3(sin(time * .31 + aMisc.x * 17.), sin(time * .47 + aMisc.x * 9.) * .45, cos(time * .27 + aMisc.x * 13.)) * .5;
          float blink = pow(.5 + .5 * sin(time * (.8 + aMisc.y * 1.4) + aMisc.x * 40.), 5.);
          float firefly = step(aMisc.z, .1);
          // GAIA mode: a share of the fireflies drifts to her and circles her
          // on a loose, tilted orbit (the first to come are the last to leave).
          float join = smoothstep(aMisc.w - .1, aMisc.w, gather.x) * firefly;
          float ang = aMisc.x * 6.2832 + gather.y * (.55 + aMisc.y * .9);
          float rr = gaia.w * (1.3 + aMisc.z * 7.);
          vec3 orbit = gaia.xyz + vec3(cos(ang) * rr, (aMisc.y - .5) * rr * .7 + sin(ang * 2. + aMisc.x * 9.) * rr * .12, sin(ang) * rr * .5);
          free = mix(free, orbit, join);
          float glow = 1.;
          // A receipt: the fireflies of one channel fly into her, go out, and
          // come back to the field a little later.
          int ch = int(aMisc.w * 64.);
          if (ch < 8 && firefly > .5) {
            float f = time - feeds[ch] - aMisc.x * .35;
            if (f > 0. && f < 6.) {
              float go = smoothstep(0., 1.5, f);
              vec3 flight = mix(free, gaia.xyz, go);
              flight.y += sin(3.14159 * go) * .5;
              free = f < 1.5 ? flight : free;
              glow = f < 1.5 ? 1.2 + go * 1.6 : smoothstep(3.2, 5.6, f);
              blink = mix(blink, 1., step(f, 1.5));
            }
          }
          float freeAlpha = firefly * (.12 + .88 * mix(blink, .8, join * .6)) * glow;

          float delay = c * .05 + aFree.w * .2;
          float m = smoothstep(delay, delay + .34, build);
          vec3 p = mix(free, slot, m);
          p.y += sin(3.14159 * m) * .7;
          vec4 mv = viewMatrix * vec4(p, 1.);
          gl_Position = projectionMatrix * mv;
          vAlpha = mix(freeAlpha, slotAlpha * (.55 + .45 * aMisc.y), m) * step(.001, max(firefly, m));
          vTint = mix(LIME * (.6 + .4 * blink), slotTint, m);
          float world = mix(.05 * (.6 + .4 * blink), head > .5 ? .045 : .034, m);
          gl_PointSize = clamp(world / (pixelWorld * -mv.z), .9, 7.) * pixelRatio;
        }`,
      fragmentShader:
        GLSL_SPRITE +
        /* glsl */ `
        varying float vAlpha; varying vec3 vTint;
        void main(){ gl_FragColor = vec4(vTint * sprite(gl_PointCoord, 3.6) * vAlpha, 1.); }`,
    });
    const fireflies = new T.Points(fireflyGeometry, fireflyMaterial);
    fireflies.frustumCulled = false;
    scene.add(fireflies);

    const pos = new T.Vector3();
    const look = new T.Vector3();
    const ray = new T.Raycaster();
    const ndc = new T.Vector2();
    const ground = new T.Plane(new T.Vector3(0, 1, 0), -0.4);
    const hit = new T.Vector3();
    const horizon = new T.Vector3();
    const lightWorld = new T.Vector3();
    const lightScreen = new T.Vector3();
    let gustStrength = 0;
    const lastPointer: [number, number] = [0, 0];

    const lightNdc = new T.Vector2();
    // GAIA mode state: the downwash trail, the voice rings, the golden wave.
    const trail = Array.from({ length: 6 }, () => ({ x: 0, z: -80, s: 0, r: 1, age: 9 }));
    let trailClock = 0;
    const ringState = Array.from({ length: 3 }, () => ({ x: 0, z: -80, age: 9, amp: 0 }));
    let ringNext = 0;
    let ringCool = 0;
    let lastVoice = 0;
    let goldenAge = 40;
    let feedNext = 0;
    const sphere = new T.Vector3();
    /** The grass tops, where GAIA's downwash lands. */
    const tops = new T.Plane(new T.Vector3(0, 1, 0), -0.8);
    return {
      camera,
      setGaia(g) {
        // Her downwash: where the point's line of sight meets the grass tops
        // (near stalks rise above the horizon on screen), fading with distance.
        const head = trail[0];
        ray.setFromCamera(lightNdc.set(g.point[0], g.point[1]), camera);
        const touches = g.flying > 0.001 && ray.ray.intersectPlane(tops, hit);
        const distance = touches ? hit.distanceTo(camera.position) : Infinity;
        if (touches && distance < 40) {
          head.x = hit.x;
          head.z = hit.z;
          head.r = Math.max(0.55, 0.075 * distance);
          head.s = g.flying * (1 - smooth(14, 40, distance)) * (0.8 + 0.3 * g.voice);
          head.age = 0;
        } else head.s = 0;
        // The sphere, for the fireflies: a point along the view ray at a depth
        // among them, sized to her radius on screen.
        ray.setFromCamera(lightNdc.set(g.centre[0], g.centre[1]), camera);
        const depth = 9;
        const c = ray.ray.at(depth, sphere);
        uniforms.gaia.value.set(c.x, c.y, c.z, Math.max(0.12, g.radius * 2 * TAN * depth));
        uniforms.gather.value.x = g.gather;
        uniforms.gather.value.y = g.circle;
        // Voice peaks send a ring of wind out of her light.
        let gust = 0;
        if (g.voice > 0.5 && g.voice - lastVoice > 0.04 && ringCool <= 0) {
          const ring = ringState[ringNext];
          ringNext = (ringNext + 1) % ringState.length;
          ring.x = uniforms.orb.value.x;
          ring.z = uniforms.orb.value.y;
          ring.age = 0;
          ring.amp = Math.min(1, g.voice) * (0.45 + 0.35 * g.flying);
          ringCool = 0.9;
          gust = ring.amp;
        }
        lastVoice = g.voice;
        return gust;
      },
      gaiaWave() {
        goldenAge = 0;
        uniforms.golden.value.set(uniforms.orb.value.x, uniforms.orb.value.y, 0, 1);
      },
      gaiaFeed(count = 1) {
        const now = uniforms.time.value;
        for (let i = 0; i < count; i++) {
          const channel = feedNext;
          feedNext = (feedNext + 1) % 8;
          const start = now + i * 0.28;
          // A channel still in flight keeps its current trip.
          if (now - uniforms.feeds.value[channel] > 6) uniforms.feeds.value[channel] = start;
        }
      },
      setLightSource(source, strength = 1) {
        if (!source) {
          uniforms.orbOnly.value = 0;
          return;
        }
        uniforms.orbOnly.value = 1;
        // The patch of field under the source: a little below it on screen, so
        // the light falls toward the viewer as the source comes lower.
        const low = Math.max(0, Math.min(1, (0.1 - source[1]) / 0.6));
        ray.setFromCamera(lightNdc.set(source[0], Math.min(source[1] - 0.5, -0.4)), camera);
        // High up: a wide, gentle pool; close to the grass: tighter, a little
        // brighter, and the soft ceiling in the shader keeps it from burning.
        if (ray.ray.intersectPlane(ground, hit))
          uniforms.orb.value.set(hit.x, hit.z, strength * (0.8 + 0.35 * low), 4.6 - 2.4 * low);
      },
      frame(f: Frame) {
        const e = f.camera;
        pos.lerpVectors(start.pos, end.pos, e);
        pos.y += Math.sin(Math.PI * e) * 1.1;
        pos.z += Math.sin(Math.PI * e) * 1.4;
        pos.x += f.pointer[0] * 0.3 * (1 - e * 0.6);
        look.lerpVectors(start.look, end.look, smooth(0, 1, e));
        look.y += f.pointer[1] * 0.35 * (1 - e);
        camera.position.copy(pos);
        camera.lookAt(look);
        camera.updateMatrixWorld();

        // The pointer stirs its own gust where it touches the field.
        const speed =
          Math.hypot(f.pointer[0] - lastPointer[0], f.pointer[1] - lastPointer[1]) /
          Math.max(f.dt, 1e-3);
        lastPointer[0] = f.pointer[0];
        lastPointer[1] = f.pointer[1];
        gustStrength += (Math.min(1, speed * 0.9) - gustStrength) * Math.min(1, f.dt * 3);
        ray.setFromCamera(ndc.set(f.pointer[0], f.pointer[1]), camera);
        if (ray.ray.intersectPlane(ground, hit))
          uniforms.gust.value.set(hit.x, hit.z, gustStrength * (1 - e));

        uniforms.time.value = f.time;
        backdrop.uniforms.time.value = f.time;
        // GAIA mode: the trail rises again, rings run out, the golden wave travels.
        trailClock -= f.dt;
        if (trailClock <= 0) {
          trailClock = 0.2;
          for (let i = trail.length - 1; i > 0; i--) Object.assign(trail[i], trail[i - 1]);
        }
        trail.forEach((sample, i) => {
          if (i > 0) sample.age += f.dt;
          uniforms.wash.value[i].set(
            sample.x,
            sample.z,
            sample.s * Math.exp(-sample.age / 1.7),
            sample.r * (1 + sample.age * 0.35),
          );
        });
        ringCool -= f.dt;
        ringState.forEach((ring, i) => {
          ring.age += f.dt;
          uniforms.rings.value[i].set(ring.x, ring.z, ring.age, ring.age < 6 ? ring.amp : 0);
        });
        goldenAge += f.dt;
        uniforms.golden.value.z = goldenAge;
        if (goldenAge > 14) uniforms.golden.value.w = 0;
        uniforms.build.value = f.build;
        uniforms.focus.value = smooth(0.2, 0.9, f.build);
        uniforms.copyDim.value = f.heroOut;
        horizon.set(camera.position.x, 0, camera.position.z - 2000).project(camera);
        uniforms.horizon.value = Math.min(1.3, horizon.y * 0.5 + 0.5);
        lightScreen.copy(lightWorld).project(camera);
        uniforms.light.value.set(lightScreen.x * 0.5 + 0.5, lightScreen.y * 0.5 + 0.5);
        // The light and the ranges step back before the DCA copy arrives.
        uniforms.lightStrength.value = 1 - 0.85 * smooth(0.2, 0.75, e);
        uniforms.rangeFade.value = 0.6 * smooth(0.3, 0.8, e);
        uniforms.skyFade.value = 1 - smooth(0.25, 0.8, e);
        uniforms.fogRange.value.set(mix(6, 8, e), mix(48, 38, e));
        renderer.render(scene, camera);
      },
      resize(width, h) {
        camera.aspect = width / h;
        camera.updateProjectionMatrix();
        uniforms.aspect.value = camera.aspect;
        uniforms.pixelWorld.value = (2 * TAN) / h;
        uniforms.pixelAngle.value = (2 * TAN) / h;
        uniforms.pixelRatio.value = renderer.getPixelRatio();
        backdrop.uniforms.res.value.set(
          width * renderer.getPixelRatio(),
          h * renderer.getPixelRatio(),
        );
        uniforms.res.value.copy(backdrop.uniforms.res.value);
        // The light sits on the right golden vertical of the rest view.
        const depth = LIGHT_DISTANCE + start.pos.z;
        lightWorld.set(
          (GOLD - 0.5) * 2 * TAN * camera.aspect * depth,
          start.pos.y + depth * Math.tan(LIGHT_ANGLE),
          -LIGHT_DISTANCE,
        );
      },
      dispose() {
        [
          geometry,
          glintGeometry,
          groundGeometry,
          fireflyGeometry,
          starGeometry,
          streamGeometry,
          meteorGeometry,
          backdrop.mesh.geometry,
          ...rangeGeometries,
        ].forEach((g) => g.dispose());
        [
          bladeMaterial,
          glintMaterial,
          groundMaterial,
          fireflyMaterial,
          starMaterial,
          streamMaterial,
          meteorMaterial,
          backdrop.material,
          ...rangeMaterials,
        ].forEach((m) => m.dispose());
      },
    };
  },
};

export default harvest;
