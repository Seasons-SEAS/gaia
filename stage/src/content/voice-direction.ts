/**
 * How GAIA performs some of her fixed lines: ElevenLabs v4 voice-direction
 * tags in square brackets (breaths, laughs, tone). The screen shows the plain
 * line from gaia-stage.ts; the words must stay the same, since the stage
 * reveals them on the voice's timestamps (scripts/demo-voice.mjs strips the
 * tags from the timestamps when it records). Lines without an entry are read
 * plainly.
 */
export const VOICE_DIRECTION: Record<string, string> = {
  // A breath before the first word, a smile, a soft chuckle, a playful finish (owner, 2026-10-06).
  "greeting-en":
    "[breathes in] [warm, welcoming] Hi... I'm GAIA. [light laugh] Ask me anything about Seasons, [playfully] and I'll show you what's on-chain.",
};
