/**
 * What GAIA does when the visitor has been quiet for a while: a whisper, a
 * soft hum, or a thought said to herself. Recorded once (scripts/idle-voice.mjs)
 * into public/assets/gaia/idle/<id>.mp3. `script` carries the voice direction
 * tags for eleven_v4; `text` is what is heard.
 */
export type IdleKind = "whisper" | "hum" | "muse";
export type IdleLine = { id: string; kind: IdleKind; script: string; text: string };

export const IDLE_LINES: IdleLine[] = [
  {
    id: "whisper-1",
    kind: "whisper",
    script: "[whispers] Hey... I'm still here. Whenever you're ready, just ask.",
    text: "Hey… I'm still here. Whenever you're ready, just ask.",
  },
  {
    id: "whisper-2",
    kind: "whisper",
    script: "[whispers] Psst... curious what the chain says today? I'm listening.",
    text: "Psst… curious what the chain says today? I'm listening.",
  },
  {
    id: "whisper-3",
    kind: "whisper",
    script: "[whispers] No rush at all. I'll keep the field warm for you.",
    text: "No rush at all. I'll keep the field warm for you.",
  },
  {
    id: "hum-1",
    kind: "hum",
    script: "[hums softly] Mmm, mm-mm-mmm... mm, mm-mmm...",
    text: "(hums softly)",
  },
  {
    id: "hum-2",
    kind: "hum",
    script: "[hums a slow, gentle lullaby] Mm-mmm... mm-mm... mmm-mm-mmm...",
    text: "(hums a slow lullaby)",
  },
  {
    id: "muse-1",
    kind: "muse",
    script: "[softly, to herself] The wheat grows at night, you know. Quietly... like the best things do.",
    text: "The wheat grows at night, you know. Quietly… like the best things do.",
  },
  {
    id: "muse-2",
    kind: "muse",
    script: "[softly, to herself] Stars, grain, and a little patience... Let it grow.",
    text: "Stars, grain, and a little patience… Let it grow.",
  },
  {
    id: "muse-3",
    kind: "muse",
    script: "[sighs contentedly] Such a calm night. I'm right here if you need me.",
    text: "Such a calm night. I'm right here if you need me.",
  },
];
