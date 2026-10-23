/**
 * GAIA's night field, heard: the voice in open air (almost no tail, a faint
 * distant echo off the mountains) and a quiet bed of wind in the grass, a few
 * crickets and, rarely, a far-off Japanese wind bell. Everything is
 * synthesised; nothing is downloaded.
 */

/** A short, sparse open-air impulse: a field has no hall tail. */
function airImpulse(context: BaseAudioContext, seconds = 0.45): AudioBuffer {
  const length = Math.round(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      data[i] = Math.random() < 0.02 ? (Math.random() * 2 - 1) * Math.pow(1 - t, 6) : 0;
    }
  }
  return buffer;
}

export type VoiceSpace = {
  /** Where she is across the screen, -1..1: the voice follows her, gently. */
  setPan(x: number): void;
};

/** Routes the voice to `output`: dry, a touch of air, one faint far echo. */
export function connectVoiceSpace(
  context: AudioContext,
  source: AudioNode,
  output: AudioNode,
): VoiceSpace {
  const input = context.createStereoPanner();
  source.connect(input);
  input.connect(output);

  const air = context.createConvolver();
  air.buffer = airImpulse(context);
  const airSend = context.createGain();
  airSend.gain.value = 0.06;
  input.connect(air).connect(airSend).connect(output);

  // The ridge far away: one soft, dark repeat, fading fast.
  const delay = context.createDelay(1.5);
  delay.delayTime.value = 0.48;
  const feedback = context.createGain();
  feedback.gain.value = 0.16;
  const tone = context.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 1800;
  const echoSend = context.createGain();
  echoSend.gain.value = 0.07;
  input.connect(tone).connect(delay);
  delay.connect(feedback).connect(delay);
  delay.connect(echoSend).connect(output);

  let lastPan = 0;
  return {
    setPan(x) {
      if (!Number.isFinite(x)) return;
      const pan = Math.max(-1, Math.min(1, x)) * 0.35;
      if (Math.abs(pan - lastPan) < 0.02) return;
      lastPan = pan;
      input.pan.setTargetAtTime(pan, context.currentTime, 0.25);
    },
  };
}

function noiseBuffer(context: BaseAudioContext, seconds = 4): AudioBuffer {
  const length = Math.round(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    // Brown-ish noise: soft and low, like air moving through grass.
    let last = 0;
    for (let i = 0; i < length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.2;
    }
  }
  return buffer;
}

export type FieldAmbience = {
  /** 0..1: how much to step back (while GAIA speaks). */
  duck(level: number): void;
  /** Where GAIA is (pan -1..1) and how close to the grass (0..1): crickets near her fall silent. */
  setScene(pan: number, near: number): void;
  /** A gust she raised: a soft rustle through the grass on her side. */
  rustle(strength: number, pan: number): void;
  stop(): void;
};

/** A quiet bed of wind in the grass and a few crickets, started inside a user gesture. */
export function startFieldAmbience(context: AudioContext, output: AudioNode): FieldAmbience {
  const master = context.createGain();
  master.gain.value = 0;
  master.connect(output);
  master.gain.setTargetAtTime(1, context.currentTime, 1.5);
  const stops: (() => void)[] = [];

  // Wind: noise through a slowly wandering band, in slow swells.
  const wind = context.createBufferSource();
  wind.buffer = noiseBuffer(context);
  wind.loop = true;
  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 520;
  band.Q.value = 0.7;
  const windGain = context.createGain();
  windGain.gain.value = 0.05;
  const swell = context.createOscillator();
  swell.frequency.value = 0.07;
  const swellDepth = context.createGain();
  swellDepth.gain.value = 0.03;
  swell.connect(swellDepth).connect(windGain.gain);
  const sweep = context.createOscillator();
  sweep.frequency.value = 0.045;
  const sweepDepth = context.createGain();
  sweepDepth.gain.value = 260;
  sweep.connect(sweepDepth).connect(band.frequency);
  wind.connect(band).connect(windGain).connect(master);
  wind.start();
  swell.start();
  sweep.start();
  stops.push(() => [wind, swell, sweep].forEach((node) => node.stop()));

  // Crickets: a few, at different distances, singing short songs with long
  // rests in between. Each chirp is a handful of syllables: a near-pure tone
  // that drops a little in pitch, a sharp attack and a quick decay, a breath of
  // rasp and a faint harmonic, never two alike; a touch of open air around them.
  const crickets = [
    { pan: -0.6, pitch: 4300, near: 0.85 },
    { pan: 0.45, pitch: 4650, near: 1 },
    { pan: 0.05, pitch: 3950, near: 0.6 },
  ];
  let alive = true;
  const field = context.createConvolver();
  field.buffer = airImpulse(context, 0.35);
  const fieldSend = context.createGain();
  fieldSend.gain.value = 0.35;
  field.connect(fieldSend).connect(master);
  const rasp = noiseBuffer(context, 0.5);
  // Each cricket's presence: it goes quiet when GAIA comes down close by, the
  // way real crickets do, and starts again once she has passed.
  const presence: { pan: number; gain: GainNode }[] = [];
  for (const cricket of crickets) {
    const hush = context.createGain();
    const distance = context.createBiquadFilter();
    distance.type = "lowpass";
    distance.frequency.value = 5200 + cricket.near * 3200;
    const panner = context.createStereoPanner();
    panner.pan.value = cricket.pan;
    hush.connect(distance).connect(panner);
    panner.connect(master);
    panner.connect(field);
    presence.push({ pan: cricket.pan, gain: hush });

    const syllable = (at: number, peak: number) => {
      const f = cricket.pitch * (1 + (Math.random() - 0.5) * 0.012);
      const length = 0.016 + Math.random() * 0.008;
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + 0.003);
      env.gain.exponentialRampToValueAtTime(0.00001, at + length);
      env.connect(hush);
      for (const [ratio, level] of [
        [1, 1],
        [2, 0.07],
      ] as const) {
        const osc = context.createOscillator();
        osc.frequency.setValueAtTime(f * ratio, at);
        osc.frequency.exponentialRampToValueAtTime(f * ratio * 0.966, at + length);
        const g = context.createGain();
        g.gain.value = level;
        osc.connect(g).connect(env);
        osc.start(at);
        osc.stop(at + length + 0.01);
      }
      const noise = context.createBufferSource();
      noise.buffer = rasp;
      const band = context.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = f;
      band.Q.value = 9;
      const grit = context.createGain();
      grit.gain.value = 0.9;
      noise.connect(band).connect(grit).connect(env);
      noise.start(at, Math.random() * 0.4, length + 0.01);
    };
    const chirp = (at: number) => {
      const syllables = 3 + Math.floor(Math.random() * 3);
      const base = 0.0108 * cricket.near * (0.75 + Math.random() * 0.25);
      let t = at;
      for (let i = 0; i < syllables; i++) {
        syllable(t, base * (0.7 + Math.random() * 0.3) * (i === 0 ? 0.8 : 1));
        t += 0.036 + Math.random() * 0.014;
      }
    };
    // A song of a few chirps, then a long rest; now and then a song is skipped.
    const song = () => {
      if (!alive) return;
      if (Math.random() > 0.25) {
        const now = context.currentTime + 0.05;
        const chirps = 2 + Math.floor(Math.random() * 4);
        for (let c = 0, t = now; c < chirps; c++, t += 0.6 + Math.random() * 0.5) chirp(t);
      }
      setTimeout(song, (9 + Math.random() * 13) * 1000);
    };
    setTimeout(song, (2 + Math.random() * 10) * 1000);
  }

  // Far away, now and then: a furin (Japanese wind bell) stirs. Inharmonic
  // glassy partials, a pentatonic handful of pitches, long soft decay.
  const bellTone = context.createBiquadFilter();
  bellTone.type = "lowpass";
  bellTone.frequency.value = 5200;
  const bellGain = context.createGain();
  bellGain.gain.value = 0.55;
  bellTone.connect(bellGain).connect(master);
  const PITCHES = [1568, 1760, 2093, 2349, 2637, 3136];
  const strike = (at: number, pitch: number, pan: number, level: number) => {
    const panner = context.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(bellTone);
    for (const [ratio, gain, decay] of [
      [1, 1, 2.6],
      [2.76, 0.42, 1.4],
      [5.4, 0.18, 0.7],
    ] as const) {
      const osc = context.createOscillator();
      osc.frequency.value = pitch * ratio * (1 + (Math.random() - 0.5) * 0.004);
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(level * gain, at + 0.004);
      env.gain.exponentialRampToValueAtTime(0.00001, at + decay);
      osc.connect(env).connect(panner);
      osc.start(at);
      osc.stop(at + decay + 0.05);
    }
  };
  const chime = () => {
    if (!alive) return;
    const now = context.currentTime + 0.05;
    const pan = (Math.random() - 0.5) * 1.2;
    const notes = 1 + Math.floor(Math.random() * 3);
    for (let n = 0; n < notes; n++)
      strike(
        now + n * (0.18 + Math.random() * 0.35),
        PITCHES[Math.floor(Math.random() * PITCHES.length)],
        pan,
        0.006 + Math.random() * 0.006,
      );
    setTimeout(chime, (10 + Math.random() * 15) * 1000);
  };
  setTimeout(chime, (4 + Math.random() * 6) * 1000);

  // Rustle: a short breath of high noise through the grass.
  const rustleNoise = noiseBuffer(context, 2);
  let lastScene = 0;

  return {
    setScene(pan, near) {
      if (!Number.isFinite(pan) || !Number.isFinite(near)) return;
      const now = context.currentTime;
      if (now - lastScene < 0.12) return;
      lastScene = now;
      for (const cricket of presence) {
        const d = cricket.pan - pan * 0.8;
        const quiet = near * Math.exp(-(d * d) / 0.3);
        // Falling silent is quick; starting again takes a while.
        cricket.gain.gain.setTargetAtTime(1 - quiet, now, quiet > 0.3 ? 0.25 : 1.6);
      }
    },
    rustle(strength, pan) {
      const at = context.currentTime + 0.02;
      const source = context.createBufferSource();
      source.buffer = rustleNoise;
      source.playbackRate.value = 1.6 + Math.random() * 0.6;
      const band = context.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 2400 + Math.random() * 1400;
      band.Q.value = 0.9;
      const env = context.createGain();
      const level = 0.05 * Math.max(0, Math.min(1, strength));
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(level, at + 0.22);
      env.gain.setTargetAtTime(0, at + 0.3, 0.35);
      const panner = context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan)) * 0.6;
      source.connect(band).connect(env).connect(panner).connect(master);
      source.start(at, Math.random());
      source.stop(at + 2);
    },
    duck(level) {
      master.gain.setTargetAtTime(
        1 - 0.55 * Math.max(0, Math.min(1, level)),
        context.currentTime,
        0.4,
      );
    },
    stop() {
      alive = false;
      master.gain.setTargetAtTime(0, context.currentTime, 0.3);
      setTimeout(() => stops.forEach((stop) => stop()), 1500);
    },
  };
}
