import type * as T from "three";

/** One frame of the Hero stage, shared by every lab scene. */
export type Frame = {
  /** Seconds since the scene started (paused while hidden). */
  time: number;
  /** Seconds since the previous frame, clamped. */
  dt: number;
  /** Scroll through the sticky stage, 0 at rest to 1 when DCA is settled. */
  progress: number;
  /** Hero copy leaving, 0..1. */
  heroOut: number;
  /** Camera travel from the Hero composition to the DCA view, 0..1. */
  camera: number;
  /** DCA chart growth, 0..1. */
  build: number;
  /** Smoothed pointer in -1..1, y up. */
  pointer: [number, number];
};

export type Scene = {
  /** The scene's own camera, for hosts that frame it (GAIA shifts it beside her chat). */
  camera?: T.PerspectiveCamera;
  /**
   * Light the field from one moving source only (GAIA's sphere), at a screen
   * position in NDC; null returns to the scene's own rolling gusts of light.
   */
  setLightSource?(ndc: [number, number] | null, strength?: number): void;
  /**
   * GAIA mode, called every frame: her flight, voice and state move the field.
   * Returns the strength of a wind ring started this frame (0 if none), for sound.
   */
  setGaia?(gaia: GaiaField): number;
  /** A verified answer: one golden wave from her light across the field. */
  gaiaWave?(): void;
  /** Receipts arrived: a few fireflies per receipt fly into her. */
  gaiaFeed?(count?: number): void;
  frame(frame: Frame): void;
  resize(width: number, height: number): void;
  dispose(): void;
};

export type GaiaField = {
  /** The flying point in NDC, and how far the sphere has become it (0..1). */
  point: [number, number];
  flying: number;
  /** The sphere's centre in NDC and its radius as a share of the frame height. */
  centre: [number, number];
  radius: number;
  /** Live voice level 0..1. */
  voice: number;
  /** Share of fireflies drawn to her (0..1) and the phase of their circling. */
  gather: number;
  circle: number;
};

export type SceneContext = {
  renderer: T.WebGLRenderer;
  /** 1 on capable desktops, lower on WebKit and small screens. */
  quality: number;
  /** Narrow viewport: compositions move the scene under the copy. */
  mobile: boolean;
};

export type SceneModule = {
  /** MSAA helps thin geometry (grass, lines) and costs little there. */
  antialias: boolean;
  create(context: SceneContext): Scene;
};
