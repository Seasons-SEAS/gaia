/**
 * GAIA's voice: Matilda on ElevenLabs v4 Turbo, streamed with character
 * timestamps (newline-delimited JSON) so the client can reveal words in step
 * with the voice. Only verified answers stored by the conversation are ever
 * voiced, so this is never an open text-to-speech proxy.
 */
const VOICE_ID = "XrExE9yKIg1WjnnlVkGX";
const MODEL_ID = "eleven_v4_turbo";

/**
 * What the voice reads: the ticker is said as the word "Seas" (like "sees"),
 * never "dollar SEAS" and never spelled out letter by letter, which an
 * all-caps SEAS sometimes triggers. One word stays one word, so the stage's
 * word timing still lines up.
 */
export const spokenText = (text: string) =>
  text.replace(/\$?\bSEAS\b/g, "Seas").replace(/\$Seas\b/g, "Seas");

/**
 * Finished voice takes, keyed by the exact words they speak, so the same
 * answer (the answer cache hands out the same text) is voiced once and then
 * replayed without calling ElevenLabs again. Bodies are the NDJSON stream as
 * received (audio plus timestamps).
 */
export interface VoiceStore {
  get(key: string): Promise<ArrayBuffer | null>;
  put(key: string, body: ArrayBuffer): Promise<void>;
}

/** A day: the same words make the same audio, so a take can be kept long. */
export const VOICE_TTL_SECONDS = 86_400;

export async function voiceKey(text: string): Promise<string> {
  const data = new TextEncoder().encode(
    `${VOICE_ID}:${MODEL_ID}:${spokenText(text).slice(0, 1200)}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const NDJSON = {
  "Content-Type": "application/x-ndjson",
  "Cache-Control": "private, max-age=3600",
};

/**
 * Voices `text`, from the store when this exact take exists; otherwise from
 * ElevenLabs, streaming to the listener while a copy is kept for next time
 * (`waitUntil` lets the copy finish after the response has gone out).
 */
export async function speakCached(
  text: string,
  apiKey: string,
  store?: VoiceStore,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<Response> {
  const key = store ? await voiceKey(text) : "";
  if (store) {
    const hit = await store.get(key).catch(() => null);
    if (hit)
      return new Response(hit, {
        headers: { ...NDJSON, "X-Gaia-Voice": "cache" },
      });
  }
  const fresh = await speak(text, apiKey);
  if (!store || !fresh.ok || !fresh.body) return fresh;
  const [toListener, toStore] = fresh.body.tee();
  const keep = new Response(toStore)
    .arrayBuffer()
    .then((buffer) => store.put(key, buffer))
    .catch(() => {});
  if (waitUntil) waitUntil(keep);
  return new Response(toListener, { headers: NDJSON });
}

/** Cloudflare: the edge cache keeps large bodies (Durable Object values cap at 128 KiB). No-op on *.workers.dev. */
type EdgeCache = {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
};
export const edgeVoiceStore = (): VoiceStore => {
  const edge = (caches as unknown as { default: EdgeCache }).default;
  return {
    async get(key) {
      const hit = await edge.match(`https://gaia-voice.cache/${key}`);
      return hit ? await hit.arrayBuffer() : null;
    },
    async put(key, body) {
      await edge.put(
        `https://gaia-voice.cache/${key}`,
        new Response(body, {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Cache-Control": `public, max-age=${VOICE_TTL_SECONDS}`,
          },
        }),
      );
    },
  };
};

/** One process (the Vercel demo): newest takes kept in memory up to `maxBytes`, each for a day. */
export function memoryVoiceStore(maxBytes = 40_000_000): VoiceStore {
  const takes = new Map<string, { body: ArrayBuffer; until: number }>();
  let bytes = 0;
  return {
    async get(key) {
      const take = takes.get(key);
      if (!take || take.until < Date.now()) return null;
      // Refresh its place: the least recently used take is dropped first.
      takes.delete(key);
      takes.set(key, take);
      return take.body;
    },
    async put(key, body) {
      const old = takes.get(key);
      if (old) bytes -= old.body.byteLength;
      takes.delete(key);
      takes.set(key, { body, until: Date.now() + VOICE_TTL_SECONDS * 1000 });
      bytes += body.byteLength;
      for (const [k, take] of takes) {
        if (bytes <= maxBytes) break;
        takes.delete(k);
        bytes -= take.body.byteLength;
      }
    },
  };
}

export async function speak(text: string, apiKey: string): Promise<Response> {
  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: spokenText(text).slice(0, 1200),
        model_id: MODEL_ID,
      }),
    },
  );
  if (!upstream.ok || !upstream.body)
    return new Response("voice unavailable", { status: 502 });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
