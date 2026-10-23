// Records GAIA's fixed lines (the greeting in each locale, the scripted demo
// answers, the fallback line) once, in the same NDJSON form the live voice
// streams (audio plus character timestamps), into public/assets/gaia/lines/.
// The stage plays them as static files: no ElevenLabs call per page view, and
// the greeting is voiced on any host without a key. Re-record after changing
// a line in src/content/gaia-stage.ts:
//   npm run demo-voice            every line
//   npm run demo-voice -- turn-2  one line
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { voiceLines } from "../src/content/gaia-stage.ts";
import { VOICE_DIRECTION } from "../src/content/voice-direction.ts";

const env = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const key = env.match(/^ELEVENLABS_API_KEY=(.*)$/m)?.[1].trim().replace(/^"|"$/g, "");
if (!key) throw new Error("ELEVENLABS_API_KEY is missing in .env.local");
// Same voice and model as GAIA Core's live voice (core/src/voice/elevenlabs.ts);
// directed lines (with [tags]) use eleven_v4, which performs the tags.
const VOICE = "XrExE9yKIg1WjnnlVkGX";
const MODEL = "eleven_v4_turbo";
const DIRECTED_MODEL = "eleven_v4";

/**
 * The timestamps of a directed take include the [tags] as characters; drop
 * each tag and the space after it, so the timed words match the plain line on
 * screen. Tags may span chunk boundaries, so the state carries across lines.
 */
function stripTags(ndjson) {
  const state = { inTag: false, dropSpace: false };
  const clean = (alignment) => {
    if (!alignment?.characters) return alignment;
    const keep = alignment.characters.map((ch) => {
      if (state.inTag) {
        if (ch === "]") state.inTag = false, state.dropSpace = true;
        return false;
      }
      if (ch === "[") return (state.inTag = true), false;
      if (state.dropSpace && ch === " ") return (state.dropSpace = false), false;
      state.dropSpace = false;
      return true;
    });
    const pick = (list) => list?.filter((_, i) => keep[i]);
    return {
      ...alignment,
      characters: pick(alignment.characters),
      character_start_times_seconds: pick(alignment.character_start_times_seconds),
      character_end_times_seconds: pick(alignment.character_end_times_seconds),
    };
  };
  const lines = ndjson.split("\n").filter((line) => line.trim());
  const out = lines.map((line) => {
    const chunk = JSON.parse(line);
    const savedState = { ...state };
    chunk.alignment = clean(chunk.alignment);
    // normalized_alignment covers the same text: run it from the same state.
    const after = { ...state };
    Object.assign(state, savedState);
    chunk.normalized_alignment = clean(chunk.normalized_alignment);
    Object.assign(state, after);
    return JSON.stringify(chunk);
  });
  return out.join("\n") + "\n";
}
const spoken = (text) => text.replace(/\$?\bSEAS\b/g, "Seas").replace(/\$Seas\b/g, "Seas");
const only = process.argv.slice(2);
const out = new URL("../public/assets/gaia/lines/", import.meta.url);
mkdirSync(out, { recursive: true });

for (const [id, text] of voiceLines()) {
  if (only.length && !only.includes(id)) continue;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: spoken(VOICE_DIRECTION[id] ?? text),
        model_id: VOICE_DIRECTION[id] ? DIRECTED_MODEL : MODEL,
      }),
    },
  );
  if (!res.ok) {
    console.log(id, "failed", res.status);
    continue;
  }
  const body = await res.text();
  writeFileSync(new URL(`${id}.ndjson`, out), VOICE_DIRECTION[id] ? stripTags(body) : body);
  console.log(id, "ok");
}
