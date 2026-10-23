// Symbols GAIA draws inside her sphere (unit: sphere radius 1). Each glyph is
// line art: a few strokes, sampled evenly along their length, so a fraction of
// the particles can draw it like a pen, in stroke order. Written as vec4:
// x, y, z and `s`, the share of the drawing done when the point lands (0..1).
// Particles that are not part of the glyph get s = -1 and stay in the sphere.
import type { CoreShape } from "../../content/gaia-stage";

type Pt = [number, number];
/** A polyline; `weight` scales its share of the points (thicker, brighter). */
type Stroke = { pts: Pt[]; weight?: number };

const TAU = Math.PI * 2;
const gauss = () => {
  let u = 0,
    v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
};

const arc = (cx: number, cy: number, r: number, from: number, to: number, n = 96): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / n;
    return [cx + Math.cos(t) * r, cy + Math.sin(t) * r];
  });
const quad = (a: Pt, c: Pt, b: Pt, n = 48): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n,
      s = 1 - t;
    return [
      s * s * a[0] + 2 * s * t * c[0] + t * t * b[0],
      s * s * a[1] + 2 * s * t * c[1] + t * t * b[1],
    ];
  });
const cubic = (a: Pt, c1: Pt, c2: Pt, b: Pt, n = 64): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n,
      s = 1 - t;
    const k = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
    return [
      k[0] * a[0] + k[1] * c1[0] + k[2] * c2[0] + k[3] * b[0],
      k[0] * a[1] + k[1] * c1[1] + k[2] * c2[1] + k[3] * b[1],
    ];
  });
const line = (a: Pt, b: Pt, n = 24): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => [
    a[0] + ((b[0] - a[0]) * i) / n,
    a[1] + ((b[1] - a[1]) * i) / n,
  ]);
const mirror = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [-x, y] as Pt).reverse();
const scale = (pts: Pt[], k: number): Pt[] => pts.map(([x, y]) => [x * k, y * k]);

// --- the glyphs ------------------------------------------------------------------
const heartCurve = (): Pt[] =>
  Array.from({ length: 241 }, (_, i) => {
    // Start at the top notch and run round the outline.
    const t = Math.PI + (i / 240) * TAU;
    const x = (16 * Math.sin(t) ** 3) / 17;
    const y =
      (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17;
    return [x * 0.5, y * 0.5 + 0.06];
  });

const shieldHalf = (k: number): Pt[] =>
  scale(
    [
      ...cubic([0, 0.56], [0.14, 0.5], [0.3, 0.46], [0.44, 0.46]),
      ...cubic([0.44, 0.46], [0.46, 0.1], [0.36, -0.3], [0, -0.58]).slice(1),
    ],
    k,
  );
const shield = (k: number): Pt[] => [...mirror(shieldHalf(k)), ...shieldHalf(k).slice(1)];

const sparkle = (cx: number, cy: number, r: number): Pt[] =>
  Array.from({ length: 241 }, (_, i) => {
    const t = (i / 240) * TAU + Math.PI / 2;
    return [cx + r * Math.cos(t) ** 3, cy + r * Math.sin(t) ** 3];
  });

const corner = (i: number, r: number): Pt => {
  const a = Math.PI / 2 + (i * TAU) / 3;
  return [Math.cos(a) * r, Math.sin(a) * r];
};

const GLYPHS: Record<Exclude<CoreShape, "mark" | "seasons">, Stroke[]> = {
  // A verified badge: the check first, then the ring closes around it.
  check: [
    {
      pts: [...line([-0.3, 0.02], [-0.08, -0.2], 12), ...line([-0.08, -0.2], [0.34, 0.25], 24).slice(1)],
      weight: 2.6,
    },
    { pts: arc(0, 0, 0.6, Math.PI / 2, Math.PI / 2 + TAU, 160) },
  ],
  heart: [{ pts: heartCurve(), weight: 1.3 }],
  // Safety: a shield with an inner line.
  shield: [
    { pts: shield(1), weight: 1.2 },
    { pts: shield(0.74), weight: 0.45 },
  ],
  // "Let it grow": a stem rising, then its two leaves, then the ground.
  sprout: [
    { pts: quad([0, -0.56], [0.06, -0.2], [0, 0.16], 40), weight: 1.1 },
    {
      pts: [
        ...quad([0, -0.06], [-0.1, 0.28], [-0.44, 0.3], 32),
        ...quad([-0.44, 0.3], [-0.32, 0.02], [0, -0.06], 32).slice(1),
      ],
      weight: 1.1,
    },
    {
      pts: [
        ...quad([0, 0.12], [0.08, 0.5], [0.46, 0.5], 32),
        ...quad([0.46, 0.5], [0.36, 0.16], [0, 0.12], 32).slice(1),
      ],
      weight: 1.1,
    },
    { pts: quad([-0.24, -0.56], [0, -0.6], [0.24, -0.56], 20), weight: 0.5 },
  ],
  // The payout calendar: a dial, four ticks, two hands.
  clock: [
    { pts: arc(0, 0, 0.56, Math.PI / 2, Math.PI / 2 - TAU, 160) },
    ...[0, 1, 2, 3].map((i) => {
      const a = Math.PI / 2 - (i * TAU) / 4;
      return {
        pts: line([Math.cos(a) * 0.43, Math.sin(a) * 0.43], [Math.cos(a) * 0.51, Math.sin(a) * 0.51], 6),
        weight: 1.2,
      };
    }),
    { pts: line([0, 0], [0, 0.34], 16), weight: 1 },
    { pts: line([0, 0], [0.26, -0.14], 16), weight: 1 },
  ],
  // Nodes: the triangle of the Seasons node visuals, a ring on each corner.
  node: [
    { pts: [0, 1, 2, 3].flatMap((i) => (i ? line(corner(i - 1, 0.52), corner(i, 0.52), 32).slice(1) : [corner(0, 0.52)])), weight: 1.2 },
    ...[0, 1, 2].map((i) => {
      const [x, y] = corner(i, 0.52);
      return { pts: arc(x, y, 0.085, 0, TAU, 40), weight: 0.8 };
    }),
  ],
  // Hello: a four-point sparkle and a small one beside it.
  spark: [
    { pts: sparkle(-0.04, -0.02, 0.56), weight: 1.2 },
    { pts: sparkle(0.4, 0.4, 0.15), weight: 0.9 },
  ],
};

/** Particles that draw a glyph: the same ones every time. */
export function glyphMembers(count: number, share = 0.24): Uint8Array {
  const members = new Uint8Array(count);
  const want = Math.round(count * share);
  let placed = 0;
  while (placed < want) {
    const i = Math.floor(Math.random() * count);
    if (!members[i]) {
      members[i] = 1;
      placed++;
    }
  }
  return members;
}

/** Samples `shape` into `out` (vec4 per particle) for the member particles. */
export function sampleGlyph(
  shape: Exclude<CoreShape, "mark" | "seasons">,
  out: Float32Array,
  members: Uint8Array,
) {
  // Every segment in drawing order, with its weighted and its drawn length.
  const segs: { a: Pt; b: Pt; s0: number; s1: number; w: number; d0: number; d1: number }[] = [];
  let total = 0,
    drawn = 0;
  for (const stroke of GLYPHS[shape]) {
    const w = stroke.weight ?? 1;
    for (let i = 0; i < stroke.pts.length - 1; i++) {
      const a = stroke.pts[i],
        b = stroke.pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      segs.push({ a, b, s0: total, s1: total + len * w, w, d0: drawn, d1: drawn + len });
      total += len * w;
      drawn += len;
    }
  }
  const memberCount = members.reduce((sum, m) => sum + m, 0);
  let k = 0,
    seg = 0;
  for (let i = 0; i < out.length / 4; i++) {
    if (!members[i]) {
      out.set([0, 0, 0, -1], i * 4);
      continue;
    }
    // Stratified along the weighted length: even density, no clumps.
    const at = ((k++ + Math.random()) / memberCount) * total;
    while (seg < segs.length - 1 && segs[seg].s1 < at) seg++;
    const { a, b, s0, s1, w, d0, d1 } = segs[seg];
    const t = Math.min(1, (at - s0) / Math.max(s1 - s0, 1e-6));
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / len,
      ny = (b[0] - a[0]) / len;
    // A crisp line: a tight core and, for one point in ten, a faint halo.
    const width = (Math.random() < 0.1 ? 0.034 : 0.009) * (0.8 + 0.2 * w);
    const off = gauss() * width;
    out.set(
      [
        a[0] + (b[0] - a[0]) * t + nx * off,
        a[1] + (b[1] - a[1]) * t + ny * off,
        gauss() * 0.014,
        Math.min(0.999, (d0 + (d1 - d0) * t) / drawn),
      ],
      i * 4,
    );
  }
  return out;
}

/**
 * A logo as line art: its outline, traced from the image's alpha at a fine
 * resolution, drawn by the pen around its centre from the top, clockwise.
 * `crop` keeps the left share of the image (the GAIA wordmark's leaf).
 */
export async function sampleOutline(
  out: Float32Array,
  members: Uint8Array,
  url: string,
  { crop = 1, height = 1.2 } = {},
) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const px = 520;
  const iw = image.naturalWidth || 80,
    ih = image.naturalHeight || 106;
  const w = Math.round((px * iw * crop) / ih);
  const h = px;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(image, 0, 0, (px * iw) / ih, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const alpha = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 4 + 3];
  const edge: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (
        alpha(x, y) > 128 &&
        (alpha(x - 1, y) <= 128 ||
          alpha(x + 1, y) <= 128 ||
          alpha(x, y - 1) <= 128 ||
          alpha(x, y + 1) <= 128)
      )
        edge.push(x, y);
  if (!edge.length) return false;
  const k = height / h;
  for (let i = 0; i < out.length / 4; i++) {
    if (!members[i]) {
      out.set([0, 0, 0, -1], i * 4);
      continue;
    }
    const j = Math.floor(Math.random() * (edge.length / 2)) * 2;
    const x = (edge[j] + Math.random() - w / 2) * k;
    const y = -(edge[j + 1] + Math.random() - h / 2) * k;
    // Around the centre, starting at the top and going clockwise.
    const turn = (Math.atan2(x, y) / TAU + 1) % 1;
    out.set([x, y, gauss() * 0.012, Math.min(0.999, turn)], i * 4);
  }
  return true;
}
