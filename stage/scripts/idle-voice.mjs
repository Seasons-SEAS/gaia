// Records GAIA's idle lines (whispers, hums, quiet musings) in her voice,
// Matilda on ElevenLabs eleven_v4, into public/assets/gaia/idle/*.mp3, each
// loudness-normalised with ffmpeg. They are static files: playing them costs
// nothing. The key comes from the repository's .env.local and is never printed.
//   node scripts/idle-voice.mjs            record every line
//   node scripts/idle-voice.mjs hum-2      record one line again
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { IDLE_LINES } from "../src/content/idle-lines.ts";

const env = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const key = env.match(/^ELEVENLABS_API_KEY=(.*)$/m)?.[1].trim().replace(/^"|"$/g, "");
if (!key) throw new Error("ELEVENLABS_API_KEY is missing in .env.local");
const VOICE = "XrExE9yKIg1WjnnlVkGX";
const only = process.argv.slice(2);
const out = new URL("../public/assets/gaia/idle/", import.meta.url);

for (const line of IDLE_LINES) {
  if (only.length && !only.includes(line.id)) continue;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: line.script, model_id: "eleven_v4" }),
    },
  );
  if (!res.ok) {
    console.log(line.id, "failed", res.status);
    continue;
  }
  const raw = new URL(`${line.id}.raw.mp3`, out).pathname;
  writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
  // Quiet and even: idle lines sit well under GAIA's answers.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-af", "loudnorm=I=-24:TP=-3:LRA=7", "-ar", "44100", "-b:a", "128k", new URL(`${line.id}.mp3`, out).pathname]);
  unlinkSync(raw);
  console.log(line.id, "ok");
}
