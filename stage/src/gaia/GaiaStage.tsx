
import { useCallback, useEffect, useRef, useState } from "react";

import {
  conversationId,
  coreAvailable,
  coreMemory,
  type CoreReceipt,
  rankReceipts,
  streamTurn,
} from "./gaiaCoreClient";
import { IDLE_LINES, type IdleKind } from "../content/idle-lines";

import {
  connectVoiceSpace,
  startFieldAmbience,
  type FieldAmbience,
  type VoiceSpace,
} from "./gaiaSpace";
import { startVoiceTake, type VoiceTake } from "./gaiaVoice";

import type { GaiaCore } from "./createGaiaCore";

import {
  demoTurnFor,
  voiceKeyFor,
  getGaiaStageCopy,
  type CoreShape,
  type CoreState,
} from "../content/gaia-stage";

const STATES: CoreState[] = [
  "idle",
  "listening",
  "thinking",
  "tool",
  "speaking",
  "guard",
  "verified",
];
const SHAPES: CoreShape[] = [
  "mark",
  "seasons",
  "check",
  "heart",
  "shield",
  "sprout",
  "clock",
  "node",
  "spark",
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Message = {
  id: number;
  role: "gaia" | "user";
  words: string[];
  done: boolean;
  receipts?: CoreReceipt[];
};

/**
 * GAIA presentation one-screener: the living core, one input line and the
 * logo. GAIA greets first; after the first question the stage becomes a
 * chat, with the core above a readable thread. When GAIA Core answers
 * `/api/gaia/v2/config` the stage talks to it (verified answers, receipts,
 * voice for verified text); otherwise it runs the reviewed demo turns.
 * `?state=<name>` / `?shape=<name>` pin the core for design review and
 * `?ask=<question>` starts the stage mid-conversation.
 */
export function GaiaStage({ locale }: { locale: string }) {
  const copy = getGaiaStageCopy(locale);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const coreRef = useRef<GaiaCore | null>(null);
  const runRef = useRef(0);
  const idRef = useRef(0);
  const audioRef = useRef<{
    element: HTMLAudioElement;
    context: AudioContext;
    analyser: AnalyserNode;
    space: VoiceSpace;
  } | null>(null);
  const audibleRef = useRef(false);
  // The spoken greeting: voiced at once when the browser already allows sound,
  // otherwise on the visitor's first click or tap (if they haven't asked yet).
  const greetingVoiceRef = useRef<{ state: "none" | "pending" | "done"; since: number }>({
    state: "none",
    since: 0,
  });
  const lateGreetingRef = useRef<() => void>(() => {});
  const shapePinnedRef = useRef(false);
  // Resolves when her entrance has played (or at once without WebGL), so she
  // greets only once she is all there.
  const entranceRef = useRef<{ done: Promise<void>; resolve: () => void } | null>(null);
  if (!entranceRef.current) {
    let resolve = () => {};
    const done = new Promise<void>((r) => (resolve = r));
    entranceRef.current = { done, resolve };
  }
  const takeRef = useRef<VoiceTake | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  // The field's own sound (wind, crickets), heard while the voice is on.
  const ambienceRef = useRef<FieldAmbience | null>(null);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;

  const [phase, setPhase] = useState<CoreState>("idle");
  const [pinned, setPinned] = useState<CoreState | null>(null);
  const [shape, setShape] = useState<CoreShape | null>(null);
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const idleRef = useRef<{
    element: HTMLAudioElement;
    gain: GainNode;
    analyser: AnalyserNode;
    space: VoiceSpace;
  } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestion, setSuggestion] = useState("");
  const [webgl, setWebgl] = useState(true);
  const [announce, setAnnounce] = useState("");
  const [statusLabel, setStatusLabel] = useState("");
  const liveRef = useRef(false);
  // Resolves once we know whether GAIA Core answers; turns wait for it.
  const liveProbeRef = useRef<Promise<boolean> | null>(null);
  const acceptedRef = useRef("");
  const greetedRef = useRef(false);

  const visual: CoreState =
    pinned ?? (busy ? phase : value.trim() && focused ? "listening" : "idle");
  const visualRef = useRef(visual);
  visualRef.current = visual;
  const chat = messages.some((message) => message.role === "user");
  // The core loads asynchronously; these carry what it must show on arrival.
  const shapeRef = useRef(shape);
  shapeRef.current = shape;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  // Desktop: GAIA on the left, the conversation in a column on the right.
  const [split, setSplit] = useState(false);
  const splitRef = useRef(split);
  splitRef.current = split;
  const frameRef = useRef(0.5);

  useEffect(() => {
    const query = matchMedia("(min-width: 960px)");
    const sync = () => setSplit(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // The core centres itself in the space left of the conversation column.
  useEffect(() => {
    const panel = panelRef.current;
    if (!split || !panel) {
      frameRef.current = 0.5;
      coreRef.current?.setFrame(0.5);
      return;
    }
    const measure = () => {
      const width = innerWidth || 1;
      frameRef.current = Math.max(0.2, (width - panel.getBoundingClientRect().width) / 2 / width);
      coreRef.current?.setFrame(frameRef.current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      removeEventListener("resize", measure);
    };
  }, [split]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const state = params.get("state") as CoreState | null;
    const pinnedShape = params.get("shape") as CoreShape | null;
    if (state && STATES.includes(state)) setPinned(state);
    if (pinnedShape && SHAPES.includes(pinnedShape)) {
      shapePinnedRef.current = true;
      setShape(pinnedShape);
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setWebgl(false);
      entranceRef.current?.resolve();
      return;
    }
    let stopped = false;
    let core: GaiaCore | null = null;
    // Cancels any scripted turn still running when the stage unmounts.
    const runs = runRef;
    (async () => {
      try {
        const { createGaiaCore } = await import("./createGaiaCore");
        if (stopped) return;
        core = createGaiaCore(canvas);
        core.setState(visualRef.current);
        core.setShape(shapeRef.current);
        core.setLift(chatRef.current && !splitRef.current ? 1 : 0);
        core.setFrame(frameRef.current);
        // The night is heard where she is: the voice follows her across the
        // screen, crickets near her fall silent, her gusts rustle the grass.
        core.onScene(({ pan, near, gust }) => {
          audioRef.current?.space.setPan(pan);
          idleRef.current?.space.setPan(pan);
          ambienceRef.current?.setScene(pan, near);
          if (gust > 0) ambienceRef.current?.rustle(gust, pan);
        });
        coreRef.current = core;
        void core.entrance().then(entranceRef.current?.resolve);
        // Dev only: lets the lab tools drive the core (never in a production build).
        if (import.meta.env.DEV) Object.assign(window, { __gaiaCore: core });
      } catch {
        setWebgl(false);
        entranceRef.current?.resolve();
      }
    })();
    return () => {
      stopped = true;
      runs.current++;
      core?.dispose();
      coreRef.current = null;
    };
  }, []);

  useEffect(() => {
    liveProbeRef.current = coreAvailable().then((live) => (liveRef.current = live));
  }, []);

  useEffect(() => {
    coreRef.current?.setState(visual);
    ambienceRef.current?.duck(visual === "speaking" ? 1 : 0);
  }, [visual]);

  useEffect(() => {
    coreRef.current?.setShape(shape);
  }, [shape]);

  useEffect(() => {
    coreRef.current?.setLift(chat && !split ? 1 : 0);
  }, [chat, split]);

  useEffect(() => {
    const box = threadRef.current;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }, [messages]);

  /** Builds the audio graph inside a user gesture, as browsers require. */
  const unlockAudio = useCallback(() => {
    if (audioRef.current) {
      void audioRef.current.context.resume();
      return;
    }
    const element = new Audio();
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaElementSource(element).connect(analyser);
    // The analyser reads the dry voice; the listener hears it in GAIA's open night.
    const space = connectVoiceSpace(context, analyser, context.destination);
    audioRef.current = { element, context, analyser, space };
    if (voiceOnRef.current) ambienceRef.current = startFieldAmbience(context, context.destination);
  }, []);

  // Sound is on by default. Browsers only allow audio after a gesture, so the
  // graph is built at once (it plays right away where the browser allows it)
  // and resumes on the visitor's first touch, click or key anywhere.
  useEffect(() => {
    unlockAudio();
    const wake = () => {
      unlockAudio();
      // The first gesture lets sound play: a greeting that was shown silently is voiced now.
      void audioRef.current?.context
        .resume()
        .then(() => lateGreetingRef.current())
        .catch(() => {});
      if (audioRef.current?.context.state === "running") {
        removeEventListener("pointerdown", wake);
        removeEventListener("keydown", wake);
        removeEventListener("touchstart", wake);
      }
    };
    addEventListener("pointerdown", wake);
    addEventListener("keydown", wake);
    addEventListener("touchstart", wake);
    return () => {
      removeEventListener("pointerdown", wake);
      removeEventListener("keydown", wake);
      removeEventListener("touchstart", wake);
    };
  }, [unlockAudio]);

  // When the visitor has been quiet a while, GAIA fills the night on her own:
  // a whisper, a soft hum or a thought said to herself (content/idle-lines.ts).
  // They are recorded files, so they cost nothing; never over a turn, never
  // with the voice off, a few times per visit at most, each of a new kind.
  useEffect(() => {
    // `?idle=<seconds>` shortens the wait for review.
    const review = Number(new URLSearchParams(location.search).get("idle")) || 0;
    const FIRST_MS = review > 0 ? review * 1000 : 45_000;
    const NEXT_MS: [number, number] = review > 0 ? [review * 2000, review * 3000] : [80_000, 140_000];
    const MAX_PER_VISIT = 4;
    let quietSince = performance.now();
    let waitFor = FIRST_MS;
    let played = 0;
    let lastKind: IdleKind | null = null;
    let lastId = "";
    let playing = false;
    let frame = 0;

    const stopIdle = (quick = true) => {
      const idle = idleRef.current;
      if (!idle || !playing) return;
      const { context } = idle.gain;
      idle.gain.gain.setTargetAtTime(0, context.currentTime, quick ? 0.12 : 0.3);
      setTimeout(() => idle.element.pause(), quick ? 450 : 900);
    };
    const wake = () => {
      quietSince = performance.now();
      if (playing) stopIdle();
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    events.forEach((name) => addEventListener(name, wake, { passive: true }));

    const play = () => {
      const audio = audioRef.current;
      if (!audio) return;
      if (!idleRef.current) {
        const element = new Audio();
        element.preload = "auto";
        const gain = audio.context.createGain();
        const analyser = audio.context.createAnalyser();
        analyser.fftSize = 512;
        audio.context.createMediaElementSource(element).connect(gain).connect(analyser);
        const space = connectVoiceSpace(audio.context, analyser, audio.context.destination);
        idleRef.current = { element, gain, analyser, space };
      }
      const idle = idleRef.current;
      const kinds = (["whisper", "hum", "muse"] as IdleKind[]).filter((kind) => kind !== lastKind);
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      const choices = IDLE_LINES.filter((line) => line.kind === kind && line.id !== lastId);
      const line = choices[Math.floor(Math.random() * choices.length)];
      lastKind = kind;
      lastId = line.id;
      idle.element.src = `/assets/gaia/idle/${line.id}.mp3`;
      idle.gain.gain.cancelScheduledValues(audio.context.currentTime);
      idle.gain.gain.setValueAtTime(0.9, audio.context.currentTime);
      playing = true;
      ambienceRef.current?.duck(0.3);
      void idle.element.play().catch(() => (playing = false));
      // The sphere breathes with her whisper or hum.
      const samples = new Uint8Array(idle.analyser.fftSize);
      const meter = () => {
        if (!playing) return;
        if (idle.element.ended || (idle.element.paused && idle.element.currentTime > 0)) {
          playing = false;
          coreRef.current?.setVoice(0);
          ambienceRef.current?.duck(0);
          return;
        }
        idle.analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        coreRef.current?.setVoice(Math.min(1, Math.sqrt(sum / samples.length) * 5) * 0.7);
        frame = requestAnimationFrame(meter);
      };
      frame = requestAnimationFrame(meter);
      played++;
      waitFor = NEXT_MS[0] + Math.random() * (NEXT_MS[1] - NEXT_MS[0]);
      quietSince = performance.now();
    };

    const timer = setInterval(() => {
      const now = performance.now();
      // A turn, speech, a hidden tab or the voice off: the quiet starts over.
      if (busyRef.current || audibleRef.current || document.hidden || !voiceOnRef.current) {
        quietSince = now;
        if (playing && !voiceOnRef.current) stopIdle();
        return;
      }
      if (playing || played >= MAX_PER_VISIT) return;
      if (audioRef.current?.context.state !== "running") return;
      if (now - quietSince >= waitFor) play();
    }, 1000);

    return () => {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      events.forEach((name) => removeEventListener(name, wake));
      idleRef.current?.element.pause();
      playing = false;
    };
  }, []);

  const stopVoice = useCallback(() => {
    takeRef.current?.cancel();
    takeRef.current = null;
    audibleRef.current = false;
    coreRef.current?.setVoice(0);
  }, []);

  /** Starts generating a reviewed line in Matilda's voice; it buffers until played. */
  const prepareVoice = useCallback(
    (text: string) => {
      stopVoice();
      const audio = audioRef.current;
      const key = voiceKeyFor(text);
      if (!audio || !key || !voiceOnRef.current) return null;
      // Fixed lines are recorded once (scripts/demo-voice.mjs) and served as static files.
      const take = startVoiceTake(audio.element, `/assets/gaia/lines/${encodeURIComponent(key)}.ndjson`);
      takeRef.current = take;
      return take;
    },
    [stopVoice],
  );

  /** Voices a verified Core answer by its message id. */
  const prepareCoreVoice = useCallback(
    (messageId: string) => {
      stopVoice();
      const audio = audioRef.current;
      const cid = conversationId();
      if (!audio || !cid || !voiceOnRef.current) return null;
      // POST, with the signed memory, so a host that restarted can still find the answer.
      const take = startVoiceTake(audio.element, "/api/gaia/v2/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ c: cid, m: messageId, memory: coreMemory() }),
      });
      takeRef.current = take;
      return take;
    },
    [stopVoice],
  );

  /** While the voice plays, its loudness drives the core. */
  const meterVoice = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const { element, analyser } = audio;
    const samples = new Uint8Array(analyser.fftSize);
    audibleRef.current = true;
    const meter = () => {
      if (element.paused || element.ended) {
        audibleRef.current = false;
        coreRef.current?.setVoice(0);
        return;
      }
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      coreRef.current?.setVoice(Math.min(1, Math.sqrt(sum / samples.length) * 5));
      requestAnimationFrame(meter);
    };
    requestAnimationFrame(meter);
  }, []);

  useEffect(
    () => () => {
      // Drop the graph as well, so a remount (React StrictMode in dev) builds a
      // fresh one instead of resuming a closed context.
      takeRef.current?.cancel();
      ambienceRef.current?.stop();
      ambienceRef.current = null;
      const audio = audioRef.current;
      audioRef.current = null;
      audio?.element.pause();
      void audio?.context.close();
    },
    [],
  );

  /**
   * Streams GAIA's words into a new message. With a voice take the words
   * follow the voice's own timestamps; otherwise they run on a timer.
   */
  const speak = useCallback(
    async (
      text: string,
      alive: () => boolean,
      gentle = false,
      take: VoiceTake | null = null,
      receipts?: CoreReceipt[],
    ) => {
      const words = text.split(" ");
      const id = ++idRef.current;
      let shown = 0;
      const show = (count: number) => {
        shown = count;
        setMessages((current) =>
          current.map((message) =>
            message.id === id ? { ...message, words: words.slice(0, count) } : message,
          ),
        );
      };
      setMessages((current) => [
        ...current,
        { id, role: "gaia", words: [], done: false, receipts },
      ]);

      // An interrupted message leaves nothing behind if it never showed a word.
      const drop = () => {
        setMessages((current) =>
          current.filter((message) => message.id !== id || message.words.length > 0),
        );
        return false;
      };

      take?.play();
      const voiced = take
        ? await Promise.race([take.started, wait(4500).then(() => false)])
        : false;
      if (!alive()) return drop();
      if (voiced && take) {
        meterVoice();
        const element = audioRef.current!.element;
        await new Promise<void>((resolve) => {
          const step = () => {
            if (!alive()) return resolve();
            let next = shown;
            while (
              next < words.length &&
              (take.wordStarts[next] ?? Infinity) <= element.currentTime + 0.04
            )
              next++;
            if (element.ended || (element.paused && take.complete())) next = words.length;
            if (next > shown) {
              show(next);
              coreRef.current?.pulse(gentle ? 0.1 : 0.22);
            }
            if (shown >= words.length) return resolve();
            requestAnimationFrame(step);
          };
          step();
        });
      } else {
        if (take) stopVoice();
        for (let index = shown; index < words.length; index++) {
          await wait(34 + Math.random() * 46);
          if (!alive()) return drop();
          show(index + 1);
          coreRef.current?.pulse(gentle ? 0.12 : 0.3);
          coreRef.current?.setVoice(gentle ? 0.25 : 0.35 + Math.min(0.5, words[index].length / 18));
        }
        coreRef.current?.setVoice(0);
      }
      if (!alive()) return false;
      setMessages((current) =>
        current.map((message) => (message.id === id ? { ...message, done: true } : message)),
      );
      setAnnounce(text);
      return true;
    },
    [meterVoice, stopVoice],
  );

  /**
   * She signs an answer: once the point is home the symbol draws itself in
   * her sphere, holds a moment and un-draws. A check comes with "verified".
   */
  const sign = useCallback(async (symbol: CoreShape | null, alive: () => boolean) => {
    // A symbol pinned for review (?shape=) stays as it is.
    if (!symbol || shapePinnedRef.current) return true;
    setPhase(symbol === "check" ? "verified" : "idle");
    setShape(symbol);
    await wait(3400);
    if (!alive()) return false;
    setShape(null);
    return true;
  }, []);

  /** One turn against GAIA Core: semantic states drive the core, the verified answer is spoken. */
  const runLive = useCallback(
    async (text: string, origin: "typed" | "suggestion", token: number) => {
      const alive = () => token === runRef.current;
      const receipts: CoreReceipt[] = [];
      let answer: { text: string; id: string } | null = null;
      let nextShape: CoreShape | null = null;
      let followup = "";
      let guarded = false;
      setPhase("thinking");
      try {
        await streamTurn(text, origin, locale, (event) => {
          if (!alive()) return;
          if (event.type === "state") {
            if (event.semantic === "tool") {
              setPhase("tool");
              setStatusLabel(event.label ?? "");
            } else if (event.semantic === "guard") {
              guarded = true;
              setPhase("guard");
            } else if (!guarded) setPhase("thinking");
          } else if (
            event.type === "policy" &&
            (event.mode === "guarded" || event.mode === "safety_alert")
          ) {
            guarded = true;
            setPhase("guard");
          } else if (event.type === "receipt") {
            receipts.push(event.receipt);
            // Each receipt read from the chain: a few fireflies fly into her.
            coreRef.current?.feed(1);
          }
          else if (event.type === "text.commit")
            answer = { text: event.text, id: event.message_id };
          else if (event.type === "shape") nextShape = event.shape;
          else if (event.type === "followup") followup = event.text;
        });
      } catch {
        answer = null;
      }
      if (!alive()) return;
      setStatusLabel("");
      const final = answer as { text: string; id: string } | null;
      if (!final) {
        await speak(copy.offline, alive, true);
        setBusy(false);
        setPhase("idle");
        return;
      }
      const take = prepareCoreVoice(final.id);
      if (!guarded) {
        // The end of thinking: a small burst, everything falls into her core,
        // and only then does she speak.
        await coreRef.current?.burst();
        if (!alive()) return;
        setPhase("speaking");
      }
      const shown = nextShape as CoreShape | null;
      if (!(await speak(final.text, alive, guarded, take, rankReceipts(receipts, final.text))))
        return;
      if (!(await sign(shown, alive))) return;
      setSuggestion(followup);
      setBusy(false);
      setPhase("idle");
    },
    [speak, sign, prepareCoreVoice, locale, copy.offline],
  );

  const run = useCallback(
    async (text: string) => {
      const token = ++runRef.current;
      const alive = () => token === runRef.current;
      if (liveProbeRef.current) await liveProbeRef.current;
      if (!alive()) return;
      if (liveRef.current) {
        const origin = text === acceptedRef.current ? "suggestion" : "typed";
        acceptedRef.current = "";
        stopVoice();
        setBusy(true);
        setShape(null);
        setValue("");
        setSuggestion("");
        setAnnounce("");
        setMessages((current) => [
          ...current,
          { id: ++idRef.current, role: "user", words: [text], done: true },
        ]);
        await runLive(text, origin, token);
        return;
      }
      const turn = demoTurnFor(text);
      // The voice starts generating while GAIA thinks, so it is ready to speak.
      const take = prepareVoice(turn.text);
      setBusy(true);
      setShape(null);
      setValue("");
      setSuggestion("");
      setAnnounce("");
      setMessages((current) => [
        ...current,
        { id: ++idRef.current, role: "user", words: [text], done: true },
      ]);

      if (turn.guard) {
        setPhase("guard");
        await wait(900);
      } else {
        setPhase("thinking");
        await wait(1200);
        if (!alive()) return;
        if (turn.tool) {
          setPhase("tool");
          await wait(1500);
        }
      }
      if (!alive()) return;
      if (!turn.guard) {
        await coreRef.current?.burst();
        if (!alive()) return;
        setPhase("speaking");
      }
      if (!(await speak(turn.text, alive, turn.guard, take))) return;
      if (!(await sign(turn.shape ?? null, alive))) return;
      setSuggestion(turn.followUp);
      setBusy(false);
      setPhase("idle");
    },
    [speak, sign, prepareVoice, runLive, stopVoice],
  );

  // GAIA says hello first (the logo shape isn't shown for now).
  useEffect(() => {
    const token = runRef.current;
    const alive = () => token === runRef.current;
    const ask = new URLSearchParams(location.search).get("ask")?.trim();
    const timer = setTimeout(async () => {
      // The visitor may already have asked something; then GAIA doesn't greet over it.
      // And she greets once: this effect re-runs when its callbacks change.
      if (!alive() || greetedRef.current) return;
      greetedRef.current = true;
      // She speaks once her entrance has played (at most ~10 s of waiting).
      await Promise.race([entranceRef.current?.done, wait(10_000)]);
      if (!alive()) return;
      if (ask) {
        run(ask.slice(0, 600));
        return;
      }
      setBusy(true);
      setPhase("speaking");
      // Voiced (with a breath and a smile, content/voice-direction.ts) when sound
      // is already allowed; otherwise shown now and voiced on the first gesture.
      const soundAllowed = audioRef.current?.context.state === "running";
      const take = soundAllowed ? prepareVoice(copy.greeting) : null;
      greetingVoiceRef.current = take
        ? { state: "done", since: Date.now() }
        : { state: "pending", since: Date.now() };
      if (!(await speak(copy.greeting, alive, false, take))) return;
      await wait(1200);
      if (!alive()) return;
      setBusy(false);
      setPhase("idle");
      setSuggestion(copy.firstSuggestion);
    }, 900);
    return () => clearTimeout(timer);
  }, [run, speak, sign, prepareVoice, copy.greeting, copy.firstSuggestion]);

  // The greeting, voiced late: on the first gesture, if nothing else has started.
  useEffect(() => {
    lateGreetingRef.current = () => {
      const greeting = greetingVoiceRef.current;
      if (greeting.state !== "pending") return;
      greeting.state = "done";
      const fresh = Date.now() - greeting.since < 60_000;
      if (!fresh || busyRef.current || audibleRef.current || !voiceOnRef.current) return;
      const take = prepareVoice(copy.greeting);
      if (!take) return;
      take.play();
      void take.started.then((voiced) => voiced && meterVoice());
    };
  }, [prepareVoice, meterVoice, copy.greeting]);

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = value.trim();
    if (!text || busy) return;
    unlockAudio();
    run(text);
  };

  const accept = () => {
    if (!suggestion || busy) return;
    unlockAudio();
    acceptedRef.current = suggestion;
    setValue(suggestion);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" && !value && suggestion && !busy) {
      event.preventDefault();
      accept();
    } else if (event.key === "Escape") {
      setValue("");
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    coreRef.current?.setPointer(
      (event.clientX / innerWidth) * 2 - 1,
      (event.clientY / innerHeight) * 2 - 1,
    );
  };

  const showGhost = !value && !busy && Boolean(suggestion);

  return (
    <div
      className="gaia-stage"
      data-state={visual}
      data-shape={shape ?? "sphere"}
      data-mode={chat ? "chat" : "intro"}
      data-layout={split ? "split" : "stack"}
      data-webgl={webgl ? "true" : "false"}
      onPointerMove={onPointerMove}
    >
      <div className="gaia-stage__aura" aria-hidden="true" />
      <div className="gaia-stage__glow" aria-hidden="true" />
      <div className="gaia-stage__glow gaia-stage__glow--lime" aria-hidden="true" />
      <canvas ref={canvasRef} className="gaia-stage__canvas" aria-hidden="true" />
      <div className="gaia-stage__orb" aria-hidden="true" />

      <header className="gaia-stage__top">
        
        <img
          className="gaia-stage__logo"
          src="/assets/gaia/gaia-logo.png"
          alt="GAIA"
          width={941}
          height={244}
          decoding="async"
        />
        <span className="gaia-stage__badge">{copy.demoBadge}</span>
      </header>

      <aside ref={panelRef} className="gaia-stage__panel" aria-label={copy.panelTitle}>
        <div className="gaia-stage__panel-head">
          <span className="gaia-stage__panel-title">{copy.panelTitle}</span>
          <button
            type="button"
            className="gaia-stage__voice"
            aria-pressed={voiceOn}
            aria-label={copy.voice}
            onClick={() => {
              unlockAudio();
              if (voiceOn) {
                stopVoice();
                ambienceRef.current?.stop();
                ambienceRef.current = null;
              } else if (audioRef.current && !ambienceRef.current) {
                const { context } = audioRef.current;
                ambienceRef.current = startFieldAmbience(context, context.destination);
              }
              setVoiceOn(!voiceOn);
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
              {voiceOn ? (
                <path
                  d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              ) : (
                <path
                  d="m16 9.5 5 5m0-5-5 5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </button>
        </div>

        <section className="gaia-stage__middle">
          <div ref={threadRef} className="gaia-stage__thread">
            {messages.map((message) => (
              <div key={message.id} className={`gaia-stage__msg gaia-stage__msg--${message.role}`}>
                {message.role === "gaia" && (chat || split) && (
                  <span className="gaia-stage__msg__who">GAIA</span>
                )}
                <p className="gaia-stage__msg__text">
                  {message.words.map((word, index) => (
                    <span key={index} className="gaia-word">
                      {word}{" "}
                    </span>
                  ))}
                  {!message.done && <span className="gaia-stage__caret" />}
                </p>
                {message.done && message.receipts?.length ? (
                  <details className="gaia-stage__proof">
                    <summary>
                      <span className="gaia-stage__proof-mark" aria-hidden="true" />
                      {message.receipts.some(
                        (receipt) => receipt.kind === "chain" || receipt.kind === "api",
                      )
                        ? copy.proofChain
                        : copy.proofSources}
                      <span className="gaia-stage__proof-count">{message.receipts.length}</span>
                    </summary>
                    <ul className="gaia-stage__receipts">
                      {message.receipts.map((receipt) => (
                        <li
                          key={receipt.id}
                          className={`gaia-stage__receipt gaia-stage__receipt--${receipt.kind}`}
                          title={`${receipt.label}: ${receipt.value}`}
                        >
                          {receipt.url ? (
                            <a href={receipt.url} target="_blank" rel="noopener noreferrer">
                              <b>{receipt.label}</b> {receipt.value}
                            </a>
                          ) : (
                            <span>
                              <b>{receipt.label}</b> {receipt.value}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
          <p className="gaia-stage__sr" aria-live="polite">
            {announce}
          </p>
        </section>

        <footer className="gaia-stage__dock">
          <p className="gaia-stage__status" role="status">
            <span className="gaia-stage__dot" aria-hidden="true" />
            GAIA · {visual === "tool" && statusLabel ? statusLabel : copy.states[visual]}
          </p>
          <form className="gaia-stage__form" onSubmit={submit}>
            <input
              ref={inputRef}
              className="gaia-stage__input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={showGhost ? "" : copy.placeholder}
              aria-label={copy.inputLabel}
              maxLength={600}
              autoComplete="off"
              enterKeyHint="send"
            />
            {showGhost && (
              <span className="gaia-stage__ghost">
                <span className="gaia-stage__ghost-text" aria-hidden="true">
                  {suggestion}
                </span>
                <button type="button" className="gaia-stage__key" onClick={accept}>
                  {copy.acceptHint}
                </button>
              </span>
            )}
            <button
              type="submit"
              className="gaia-stage__send"
              aria-label={copy.send}
              disabled={!value.trim() || busy}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  d="M12 19V5M5.5 11.5 12 5l6.5 6.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </form>
        </footer>
      </aside>

      <a
        className="gaia-stage__powered"
        href="https://seasons.wtf"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span>Powered by</span>
        <span className="gaia-stage__powered-logo" role="img" aria-label="Seasons" />
      </a>
    </div>
  );
}
