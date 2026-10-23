import * as T from "three";

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** Quintic smoothstep: zero velocity and acceleration at both ends. */
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Deterministic PRNG so every load composes the same scene. */
export function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Site palette (v7 dark theme), as linear-ish shader colours. */
export const GLSL_PALETTE = /* glsl */ `
  const vec3 INK = vec3(.043,.031,.071);      // #0b0812 page
  const vec3 DEEP = vec3(.086,.055,.176);     // #160e2d
  const vec3 VIOLET = vec3(.329,.118,.965);   // #541ef6 brand
  const vec3 BRIGHT = vec3(.478,.125,.976);   // #7a20f9
  const vec3 LILAC = vec3(.702,.604,1.);      // #b39aff accent
  const vec3 PEARL = vec3(.949,.933,.984);    // #f2eefb text
  const vec3 LIME = vec3(.553,.980,.267);     // #8dfa44
`;

export const GLSL_NOISE = /* glsl */ `
  float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
  float vnoise(vec2 p){
    vec2 i=floor(p), f=fract(p);
    vec2 u=f*f*(3.-2.*f);
    return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y);
  }
  float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.1,9.2); a*=.5; } return s; }
  // Ordered dithering hides 8-bit banding in dark gradients.
  float dither(vec2 frag){ return (hash12(frag)-.5)/255.; }
`;

/**
 * A full-screen backdrop drawn first, in the same pass as the scene: deep ink
 * with one soft violet bloom and a vignette. `glow` is (x, y, radius) in
 * viewport units, y up.
 */
export function createBackdrop(fragmentBody?: string) {
  const uniforms = {
    res: { value: new T.Vector2(1, 1) },
    time: { value: 0 },
    glow: { value: new T.Vector3(0.62, 0.42, 0.55) },
    glowStrength: { value: 1 },
  };
  const material = new T.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `void main(){ gl_Position = vec4(position.xy, 0.9999, 1.); }`,
    fragmentShader:
      GLSL_PALETTE +
      GLSL_NOISE +
      /* glsl */ `
      uniform vec2 res; uniform float time; uniform vec3 glow; uniform float glowStrength;
      void main(){
        vec2 uv = gl_FragCoord.xy / res;
        vec2 d = (uv - glow.xy) * vec2(res.x / res.y, 1.);
        float g = exp(-dot(d, d) / (glow.z * glow.z));
        vec3 col = INK + DEEP * .9 * g * glowStrength + VIOLET * .07 * g * g * glowStrength;
        ${fragmentBody ?? ""}
        vec2 v = uv - .5;
        col *= 1. - dot(v, v) * .85;
        gl_FragColor = vec4(col + dither(gl_FragCoord.xy), 1.);
      }`,
  });
  const mesh = new T.Mesh(new T.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, uniforms, material };
}

/** Round, soft sprite with an energy-conserving core; shared by particle scenes. */
export const GLSL_SPRITE = /* glsl */ `
  float sprite(vec2 c, float hardness){
    float d = length(c - .5) * 2.;
    return exp(-d * d * hardness) * (1. - smoothstep(.75, 1., d));
  }
`;

/** The golden ratio and its powers: the lab's proportions and breakpoints. */
export const PHI = (1 + Math.sqrt(5)) / 2;
/** 0.618 and 0.382: the golden lines of any frame. */
export const GOLD = 1 / PHI;
export const GOLD_MINOR = 1 - GOLD;
/** Bar width as a share of the bar pitch: width : pitch = 1 : φ. */
export const BAR_FILL = GOLD;

/**
 * Nine DCA bars growing along the Fibonacci sequence (1, 1, 2, 3, 5, 8, 13,
 * 21, 34) over a φ⁻⁴ floor: the chart itself reads as compounding.
 */
const FIBONACCI = [1, 1, 2, 3, 5, 8, 13, 21, 34];
export const DCA_BARS = FIBONACCI.map((f, i) => ({
  t: i / 8,
  height: Math.pow(GOLD, 4) + (1 - Math.pow(GOLD, 4)) * (f / 34),
}));
