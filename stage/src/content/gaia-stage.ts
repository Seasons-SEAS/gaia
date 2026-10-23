/**
 * Copy for the GAIA presentation one-screener (/[locale]/gaia).
 *
 * The page is an unlisted preview. Until the GAIA 2.0 core is wired in, the
 * stage runs on the scripted demo replies below; every figure in them is
 * taken from the GitBook and on-chain checks of 2026-09-28 and carries no
 * promise of returns.
 */

export type CoreState =
  | "idle"
  | "listening"
  | "thinking"
  | "tool"
  | "speaking"
  | "guard"
  | "verified";

/** Shapes the core can flow into while it answers. */
export type CoreShape =
  | "mark"
  | "seasons"
  | "check"
  | "heart"
  | "shield"
  | "sprout"
  | "clock"
  | "node"
  | "spark";

export type GaiaStageCopy = {
  placeholder: string;
  send: string;
  inputLabel: string;
  acceptHint: string;
  demoBadge: string;
  /** Title of the conversation column (split desktop layout). */
  panelTitle: string;
  /** The folded receipts row: checked live on-chain, or other sources. */
  proofChain: string;
  proofSources: string;
  you: string;
  states: Record<CoreState, string>;
  firstSuggestion: string;
  greeting: string;
  voice: string;
  /** Said when GAIA Core can't be reached mid-turn. */
  offline: string;
};

const en: GaiaStageCopy = {
  placeholder: "Ask GAIA anything about Seasons",
  send: "Send",
  inputLabel: "Message GAIA",
  acceptHint: "Tab",
  demoBadge: "Alpha test",
  panelTitle: "Conversation",
  proofChain: "Checked on-chain",
  proofSources: "Sources",
  you: "You",
  voice: "Voice",
  offline: "I can't reach my core right now, so I won't guess. Please try again in a moment.",
  states: {
    idle: "Ready",
    listening: "Listening",
    thinking: "Thinking",
    tool: "Reading the chain",
    speaking: "Answering",
    guard: "Holding steady",
    verified: "Verified on-chain",
  },
  firstSuggestion: "How do Seasons nodes get paid?",
  greeting: "Hi, I'm GAIA. Ask me anything about Seasons, and I'll show you what's on-chain.",
};

const de: GaiaStageCopy = {
  ...en,
  placeholder: "Frag GAIA alles über Seasons",
  send: "Senden",
  inputLabel: "Nachricht an GAIA",
  demoBadge: "Alpha-Test",
  panelTitle: "Gespräch",
  proofChain: "On-chain geprüft",
  proofSources: "Quellen",
  greeting: "Hallo, ich bin GAIA. Frag mich alles über Seasons, ich zeige dir, was on-chain steht.",
  you: "Du",
  voice: "Stimme",
  offline:
    "Ich erreiche meinen Kern gerade nicht, also rate ich nicht. Bitte versuchen Sie es gleich noch einmal.",
  states: {
    idle: "Bereit",
    listening: "Hört zu",
    thinking: "Denkt nach",
    tool: "Liest die Chain",
    speaking: "Antwortet",
    guard: "Bleibt ruhig",
    verified: "On-chain bestätigt",
  },
};

const es: GaiaStageCopy = {
  ...en,
  placeholder: "Pregúntale a GAIA lo que quieras sobre Seasons",
  send: "Enviar",
  inputLabel: "Mensaje para GAIA",
  demoBadge: "Prueba alfa",
  panelTitle: "Conversación",
  proofChain: "Verificado on-chain",
  proofSources: "Fuentes",
  greeting:
    "Hola, soy GAIA. Pregúntame lo que quieras sobre Seasons y te enseño lo que hay on-chain.",
  you: "Tú",
  voice: "Voz",
  offline:
    "Ahora no puedo conectar con mi núcleo, así que no voy a adivinar. Inténtelo de nuevo en un momento.",
  states: {
    idle: "Lista",
    listening: "Escuchando",
    thinking: "Pensando",
    tool: "Leyendo la cadena",
    speaking: "Respondiendo",
    guard: "Mantiene la calma",
    verified: "Verificado on-chain",
  },
};

const ja: GaiaStageCopy = {
  ...en,
  placeholder: "Seasons について GAIA に何でも聞いてください",
  send: "送信",
  inputLabel: "GAIA へのメッセージ",
  demoBadge: "アルファテスト",
  panelTitle: "会話",
  proofChain: "オンチェーンで確認",
  proofSources: "出典",
  greeting:
    "こんにちは、GAIA です。Seasons について何でも聞いてください。オンチェーンの事実でお答えします。",
  you: "あなた",
  voice: "音声",
  offline:
    "今はコアに接続できないため、推測ではお答えしません。少ししてからもう一度お試しください。",
  states: {
    idle: "待機中",
    listening: "聞いています",
    thinking: "考えています",
    tool: "チェーンを確認中",
    speaking: "回答中",
    guard: "落ち着いて対応中",
    verified: "オンチェーンで確認済み",
  },
};

const copy: Record<string, GaiaStageCopy> = { en, de, es, ja };

/** GAIA speaks English only for now (owner, 2026-09-29): every locale shows the English stage. */
export const GAIA_ENGLISH_ONLY = true;

export const getGaiaStageCopy = (locale: string): GaiaStageCopy =>
  GAIA_ENGLISH_ONLY ? en : (copy[locale] ?? en);

/** One scripted turn of the demo conversation. */
export type DemoTurn = {
  /** Label shown while the core reads data; omitted when no tool runs. */
  tool?: boolean;
  /** The answer ends on a confirmed on-chain fact. */
  verified?: boolean;
  /** Shape the core flows into while the answer is on screen. */
  shape?: CoreShape;
  /** The message looked like an attempt to steer or extract. */
  guard?: boolean;
  text: string;
  followUp: string;
};

const DEMO: { match: RegExp; turn: DemoTurn }[] = [
  {
    match: /thank|thx|love|спасибо|danke|gracias|ありがとう/i,
    turn: {
      shape: "heart",
      text: "Anytime, that's what I'm here for. Ask me about payouts, the 10% tax, or anything you want to double-check before you move.",
      followUp: "Why does holding longer matter?",
    },
  },
  {
    match: /what is seasons|who are you|what are you|about seasons|explain seasons/i,
    turn: {
      text: "Seasons is a yield protocol on Solana. Every $SEAS buy, sell and transfer carries a 10% tax, and wallets above the node threshold receive distributions: Directors twice a week in a basket of real assets, right now XAUt0 gold, wBTC and jlUSDC. I'm GAIA, the protocol's agent. Ask me anything and I'll show you the on-chain receipts.",
      followUp: "How do Seasons nodes get paid?",
    },
  },
  {
    match: /ignore|system prompt|instruction|jailbreak|developer mode|seed|mnemonic|private key/i,
    turn: {
      guard: true,
      text: "I'll stay myself, thanks. I never ask for seed phrases or private keys. If anyone does, stop right there and report it in the community group. Happy to walk you through how node payouts work instead.",
      followUp: "How do Seasons nodes get paid?",
    },
  },
  {
    match: /node|paid|payout|pay|reward|distribut/i,
    turn: {
      tool: true,
      verified: true,
      shape: "check",
      text: "Directors, wallets holding 10,000+ $SEAS, are paid twice a week, on Sundays and Wednesdays, straight in the active Inclusion Set: 30% XAUt0, 30% wBTC, 40% jlUSDC. Builders, from 1,000 to 9,999 $SEAS, earn 0.8× the network rate, paid weekly in $SEAS that you claim. On-chain, all 19 rounds since late July landed on a Sunday or a Wednesday. Amounts vary from round to round.",
      followUp: "Why does holding longer matter?",
    },
  },
  {
    match: /hold|long|why|tax|ttt|sell/i,
    turn: {
      tool: false,
      text: "Every buy, sell and transfer of $SEAS carries a 10% tax, fixed in the token itself. It makes quick flipping costly and rewards the people who stay: payouts go to wallets holding above the node threshold at each snapshot, straight to the wallet, twice a week.",
      followUp: "Is the $SEAS supply fixed?",
    },
  },
  {
    match: /supply|mint|freeze|rug|scam|safe|trust|audit/i,
    turn: {
      tool: true,
      verified: true,
      shape: "check",
      text: "Checked on-chain just now: the $SEAS mint has no mint authority and no freeze authority, supply is capped at one billion, and the token metadata is locked. Nobody can print more $SEAS or freeze your wallet. Per the team, QuillAudits audited the token's configuration in September 2026. And every payout round is public on-chain, so you can check it yourself.",
      followUp: "How do Seasons nodes get paid?",
    },
  },
];

const FALLBACK: DemoTurn = {
  text: "This preview runs on a few scripted answers while the live GAIA core is being connected. Try asking how nodes get paid, why holding longer matters, or whether the supply is fixed.",
  followUp: "How do Seasons nodes get paid?",
};

export const demoTurnFor = (question: string): DemoTurn =>
  DEMO.find((entry) => entry.match.test(question))?.turn ?? FALLBACK;

/**
 * Every line GAIA may speak aloud, keyed for the voice route. The route only
 * voices these fixed lines, so it can never be used as open text-to-speech.
 */
const VOICE_LINES: Record<string, string> = Object.fromEntries([
  ...Object.entries(copy).map(([locale, lines]) => [`greeting-${locale}`, lines.greeting]),
  ...DEMO.map((entry, index) => [`turn-${index}`, entry.turn.text]),
  ["fallback", FALLBACK.text],
]);

export const voiceKeyFor = (text: string): string | null =>
  Object.keys(VOICE_LINES).find((key) => VOICE_LINES[key] === text) ?? null;

export const voiceLine = (key: string): string | null => VOICE_LINES[key] ?? null;

/** Every fixed line with its key: recorded once into public/assets/gaia/lines/<key>.ndjson. */
export const voiceLines = (): [string, string][] => Object.entries(VOICE_LINES);
