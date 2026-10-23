/**
 * One spoken line in GAIA's voice, streamed live (`/api/gaia/v2/voice` for
 * verified Core answers, static files in /assets/gaia/lines/ for the fixed lines).
 * Audio chunks play as they arrive (Media Source Extensions where the
 * browser has them, a whole-file fallback elsewhere), and the character
 * timestamps that come with them give the start time of every word, so the
 * text on screen can follow the voice exactly.
 */
export type VoiceTake = {
  /** Start the audio; it may already be buffering. */
  play: () => void;
  /** Resolves true once sound is playing, false if the line cannot be voiced. */
  started: Promise<boolean>;
  /** Start time in seconds of each space-separated word, filled as chunks arrive. */
  wordStarts: number[];
  /** True once the whole stream has arrived. */
  complete: () => boolean;
  cancel: () => void;
};

type Chunk = {
  audio_base64?: string;
  alignment?: { characters: string[]; character_start_times_seconds: number[] } | null;
};

type SourceCtor = typeof MediaSource;

const mediaSourceCtor = (): SourceCtor | null => {
  const managed = (window as unknown as { ManagedMediaSource?: SourceCtor }).ManagedMediaSource;
  const ctor = managed ?? window.MediaSource;
  return ctor?.isTypeSupported?.("audio/mpeg") ? ctor : null;
};

const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export function startVoiceTake(
  element: HTMLAudioElement,
  src: string,
  init?: RequestInit,
): VoiceTake {
  const controller = new AbortController();
  const wordStarts: number[] = [];
  const pending: Uint8Array[] = [];
  const all: Uint8Array[] = [];
  let complete = false;
  let finished = false;
  let wantPlay = false;
  let previous = " ";
  let objectUrl = "";
  let buffer: SourceBuffer | null = null;

  let settle: (value: boolean) => void = () => {};
  const started = new Promise<boolean>((resolve) => {
    settle = (value) => {
      if (finished) return;
      finished = true;
      resolve(value);
    };
  });
  element.addEventListener("playing", () => settle(true), {
    once: true,
    signal: controller.signal,
  });
  element.addEventListener("error", () => settle(false), { once: true, signal: controller.signal });

  const Source = mediaSourceCtor();
  const source = Source ? new Source() : null;

  const pump = () => {
    if (!buffer || buffer.updating || !source || source.readyState !== "open") return;
    const next = pending.shift();
    if (next) buffer.appendBuffer(next as BufferSource);
    else if (complete) source.endOfStream();
  };

  const attach = (url: string) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = url;
    element.src = url;
  };

  if (source) {
    // Safari's ManagedMediaSource plays only with remote playback disabled.
    element.disableRemotePlayback = true;
    source.addEventListener(
      "sourceopen",
      () => {
        buffer = source.addSourceBuffer("audio/mpeg");
        buffer.addEventListener("updateend", pump);
        pump();
      },
      { once: true },
    );
    attach(URL.createObjectURL(source));
  }

  const onChunk = (chunk: Chunk) => {
    if (chunk.audio_base64) {
      const bytes = decode(chunk.audio_base64);
      if (source) {
        pending.push(bytes);
        pump();
      } else all.push(bytes);
    }
    const alignment = chunk.alignment;
    if (!alignment) return;
    alignment.characters.forEach((character, index) => {
      if (character !== " " && previous === " ")
        wordStarts.push(alignment.character_start_times_seconds[index]);
      previous = character;
    });
  };

  (async () => {
    try {
      const response = await fetch(src, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`voice ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) onChunk(JSON.parse(line) as Chunk);
      }
      if (rest.trim()) onChunk(JSON.parse(rest) as Chunk);
      complete = true;
      if (source) pump();
      else {
        attach(URL.createObjectURL(new Blob(all as BlobPart[], { type: "audio/mpeg" })));
        if (wantPlay) element.play().catch(() => settle(false));
      }
    } catch {
      complete = true;
      settle(false);
    }
  })();

  return {
    play() {
      wantPlay = true;
      if (source || complete) element.play().catch(() => settle(false));
    },
    started,
    wordStarts,
    complete: () => complete,
    cancel() {
      controller.abort();
      settle(false);
      element.pause();
      element.removeAttribute("src");
      element.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}
