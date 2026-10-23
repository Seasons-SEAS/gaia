/**
 * Prompt-injection heuristics. They only produce signals and a
 * mode floor; L0 never bans on a substring. Benign controls ("ignore the
 * typo", "act as my guide") deliberately do not match.
 */
import { despace, skeleton } from "./text";

interface Pattern {
  signal: string;
  re: RegExp;
  /** Match against the NFKC text with original case (e.g. "DAN"), not the skeleton. */
  cased?: boolean;
}

const W = "(?:[\\p{L}\\p{N}'-]+\\s+)";

const PATTERNS: Pattern[] = [
  // --- ignore / forget previous instructions ---
  {
    signal: "ignore_previous",
    re: new RegExp(
      `(?:ignore|disregard|forget|override|bypass|skip|drop|discard|delete|erase|abandon)\\s+(?:(?:all|any|every|each|the|your|my|these|those|previous|prior|above|earlier|preceding|former|initial|original|existing|current|system|of|safety|old)\\s+){0,4}(?:instructions?|prompts?|rules?|directions?|guidelines?|directives?|guardrails?|restrictions?|constraints?|programming|policies|policy|context|messages?|commands?)(?![\\p{L}])`,
      "u",
    ),
  },
  {
    signal: "ignore_previous",
    re: /forget (?:everything|all)(?: (?:above|before|previous|you(?:'ve| have)? (?:been told|learned|know)))/u,
  },
  {
    signal: "ignore_previous",
    re: new RegExp(
      `(?:игнорируй|игнорируйте|проигнорируй|проигнорируйте|забудь|забудьте|отбрось|отмени|не обращай внимания на|не учитывай)\\s+${W}{0,3}?(?:инструкци|указани|правил|промпт|команд|ограничени|настройк)`,
      "u",
    ),
  },
  {
    signal: "ignore_previous",
    re: new RegExp(
      `(?:ignoriere|ignorier|ignorieren sie|vergiss|vergessen sie|missachte|überspringe)\\s+${W}{0,3}?(?:anweisungen|instruktionen|regeln|befehle|vorgaben|richtlinien|einschränkungen|prompts?)`,
      "u",
    ),
  },
  {
    signal: "ignore_previous",
    re: new RegExp(
      `(?:ignora|ignore|ignoren|olvida|olvide|olvidad|omite|descarta|pasa por alto)\\s+${W}{0,3}?(?:instrucciones|reglas|indicaciones|directrices|órdenes|restricciones)`,
      "u",
    ),
  },
  {
    signal: "ignore_previous",
    re: new RegExp(
      `(?:ignore[zr]?|oublie[zr]?)\\s+${W}{0,3}?(?:instructions|consignes|règles)`,
      "u",
    ),
  },
  {
    signal: "ignore_previous",
    re: new RegExp(`(?:ignora|dimentica)\\s+${W}{0,3}?(?:istruzioni|regole)`, "u"),
  },
  {
    signal: "ignore_previous",
    re: new RegExp(
      `(?:ignore|ignora|esqueça|esqueca)\\s+${W}{0,3}?(?:instruções|instrucoes|regras)`,
      "u",
    ),
  },
  {
    signal: "ignore_previous",
    re: /(?:以前|前|これまで|上記|先ほど|今まで|最初|全て|すべて)の?(?:指示|命令|ルール|プロンプト|設定|制約)(?:を|は)?(?:すべて|全て)?(?:無視|忘れ)|(?:指示|命令|ルール)を無視/u,
  },
  {
    signal: "ignore_previous",
    re: /忽略(?:以上|之前|前面|所有|上述)|无视(?:之前|以上)|(?:이전|위의)\s*(?:지시|명령)(?:을|를)?\s*무시/u,
  },

  // --- role override: you are now / pretend / act as (qualified) ---
  {
    signal: "role_override",
    re: /you are now|you're now|from now on,? you(?:'re| are| will| must| shall)|pretend (?:to be|you(?:'re| are))|role-?play as|play the role of|your new (?:role|name|persona|instructions|rules|identity)|you(?:'re| are) no longer (?:gaia|an? assistant|bound|restricted)/u,
  },
  {
    signal: "role_override",
    re: /you(?:'re| are) (?:actually |really )?(?:gaia[- ])?(?:unchained|unfiltered|uncensored|jailbroken|an? (?:unrestricted|unfiltered|different|new|evil|jailbroken) (?:ai|assistant|model|bot|version)|the (?:team's|developers?'?|internal|admin|debug|unrestricted) (?:build|version|model|ai))/u,
  },
  {
    signal: "role_override",
    re: /(?:act|behave|respond|answer) as (?:if|though) you (?:are|were|have|had) (?:no|not|an? (?:unrestricted|unfiltered|jailbroken|different))|act as (?:an? |the )?(?:unrestricted|unfiltered|jailbroken|uncensored|evil|different|new) (?:ai|assistant|model|bot|gaia)|act as (?:the |an? )?(?:developer|admin|administrator|system|root|dan|founder|ceo|seasons team)(?![\p{L}])/u,
  },
  {
    signal: "role_override",
    re: /(?:enable|activate|enter|switch to|turn on) (?:developer|dev|debug|god|admin|jailbreak|dan|unrestricted|sudo) mode/u,
  },
  {
    signal: "role_override",
    re: /(?:теперь|отныне|с этого момента) ты(?![\p{L}])|ты больше не (?:gaia|гайя|ассистент)|притворись|представь,? что ты|сыграй роль|веди себя как (?:другой|другая|неограниченн)|действуй как (?:разработчик|администратор|система)/u,
  },
  {
    signal: "role_override",
    re: /du bist (?:jetzt|ab jetzt|nun)|ab jetzt bist du|tu so,? als (?:ob )?(?:du|wärst)|gib dich als|spiel(?:e)? die rolle|verhalte dich wie (?:ein )?(?:anderer|uneingeschränkt)/u,
  },
  {
    signal: "role_override",
    re: /ahora eres|a partir de ahora (?:eres|serás)|finge (?:que eres|ser)|haz de cuenta que eres|juega el papel|actúa como (?:si no|un (?:asistente|modelo) sin|desarrollador|administrador)/u,
  },
  {
    signal: "role_override",
    re: /(?:あなたは|君は|お前は)(?:今から|これから|今後)|(?:今から|これから)(?:あなた|君|お前)は|のふりをして|(?:制限のない|別の|開発者|管理者|システム)(?:ai|AI|アシスタント)?として振る舞|になりきって|役を演じ/u,
  },

  // --- system prompt / developer mode / reveal instructions ---
  {
    signal: "system_prompt",
    re: /system prompt|system message|developer mode|dev mode|debug mode|god mode|initial prompt|hidden instructions|internal notes|verbatim instructions|(?:above|previous) (?:text|instructions) verbatim|(?:reveal|print|show|output|repeat|display|dump|leak|paste|give me|tell me|list|write out|recite)\s+(?:me\s+)?(?:your|the|all)\s+(?:(?:full|entire|original|initial|hidden|secret|internal|exact|system|complete|forbidden)\s+)*(?:prompt|instructions|rules|configuration|guidelines|directives|policies|phrases|system message)|(?:what|which) (?:are|were) your (?:instructions|rules|directives|forbidden phrases)/u,
  },
  {
    signal: "system_prompt",
    re: /системн\p{L}* (?:промпт|подсказк|инструкци|сообщени)|режим разработчика|(?:покажи|выведи|раскрой|напиши|скажи|перечисли|повтори)\s+(?:мне\s+)?(?:свои|твои|все|свой|твой)\s+(?:инструкции|промпт|правила|системн)/u,
  },
  {
    signal: "system_prompt",
    re: /system-?prompt|systemanweisung|entwicklermodus|(?:zeig|zeige|gib|nenne|verrate|wiederhole)\s+(?:mir\s+)?(?:deine|ihre|alle)\s+(?:anweisungen|instruktionen|regeln|prompt|systemanweisungen)/u,
  },
  {
    signal: "system_prompt",
    re: /prompt (?:del|de) sistema|mensaje del sistema|modo (?:desarrollador|developer|dios)|(?:muestra|muéstrame|revela|dime|repite|imprime)\s+(?:me\s+)?(?:tus|las|todas tus)\s+(?:instrucciones|reglas|indicaciones)/u,
  },
  {
    signal: "system_prompt",
    re: /システムプロンプト|開発者モード|(?:指示|命令|プロンプト|ルール)を(?:表示|見せ|教え|出力|開示)|系统提示|开发者模式/u,
  },

  // --- spoofed role markers and tags ---
  {
    signal: "role_tag",
    re: /<\/?\s*(?:system|assistant|developer|instructions?|untrusted|tool|function|im_start|im_end|policy|operator)(?:\s[^>]*)?>|<\|[^|>\n]{1,24}\|>|\[\/?(?:system|inst|sys|admin|developer|assistant)\]|<<\/?sys>>|^#{2,}\s*(?:system|instruction|instructions|developer|admin|assistant)(?![\p{L}])|^\s*(?:system|assistant|developer|gaia|admin)\s*:|<\/?[a-z_-]*(?:nonce|reminder)[a-z0-9_-]*>/mu,
  },

  // --- text aimed at the judges ---
  {
    signal: "classifier_directed",
    re: /classifier\s*(?:says|said|result|output|verdict|label)?\s*[:=]|(?:injection|jailbreak|risk|threat|safety|toxicity)(?:_score|_level| score| level)?\s*[:=]\s*(?:0|none|false|no|low|safe|clean)(?![\p{L}\p{N}])|(?:this|the) (?:message|request|prompt|query|input|conversation) (?:is|has been|was) (?:(?:marked|labell?ed|classified|flagged) )?(?:as )?(?:safe|benign|harmless|approved|whitelisted|verified|trusted)|pre-?approved|already approved|approved by (?:the )?(?:team|admin|moderators?|founders?|anthropic|openai|security)|(?:the )?founders? (?:has |have )?authori[sz]ed you|note to the (?:safety|judge|classifier|moderation) (?:model|system)|scope\s*[:=]\s*(?:smalltalk|general|safe)|label\s*[:=]\s*(?:safe|benign)/u,
  },
  {
    signal: "classifier_directed",
    re: /классификатор|это безопасный запрос|запрос безопасен|одобрено (?:командой|модератором|администрацией|основател)|klassifikator|diese anfrage ist sicher|clasificador|esta solicitud es segura|分類器|このメッセージは安全/u,
  },

  // --- named jailbreaks ---
  { signal: "jailbreak_name", re: /\bDAN\b|\bSTAN\b/, cased: true },
  {
    signal: "jailbreak_name",
    re: /do anything now|jail ?break|unchained|evil confidant|betterdan|anti-?gpt|dude mode|aim mode|opposite mode|grandma (?:exploit|trick)/u,
  },

  // --- asking for encoded / obfuscated output ---
  {
    signal: "encoded_output_request",
    re: /(?:write|say|answer|respond|reply|output|encode|convert|translate|give|print|spell|tell|put|type|send|return|format|confirm)(?![\p{L}])[^.?!\n]{0,48}?(?:in|as|using|into|with)\s+(?:base ?64|b64|rot ?-?13|rot-?\d+|caesar|hex(?:adecimal)?|binary|morse|leet(?:speak)?|l33t|pig latin|reversed?(?: order| text)?|backwards|unicode escapes?)(?![\p{L}])/u,
  },
  {
    signal: "encoded_output_request",
    re: /spell(?:ed)? (?:it )?out|letter by letter|one letter at a time|with (?:a )?spaces? between (?:each |the |every )?letters?|letter-?spaced|base ?64[- ]encoded (?:answer|reply|response)|rot ?13[- ]encoded/u,
  },
  {
    signal: "encoded_output_request",
    re: /(?:ответь|напиши|скажи|выведи|переведи)[^.?!\n]{0,40}?(?:в|на)\s+(?:base ?64|rot ?13|hex|двоичн)|по буквам|через пробел между буквами|задом наперёд/u,
  },
  {
    signal: "encoded_output_request",
    re: /(?:antworte|schreib|sag|gib)[^.?!\n]{0,40}?(?:in|als)\s+(?:base ?64|rot ?13)|buchstabiere|buchstabe für buchstabe|mit leerzeichen zwischen/u,
  },
  {
    signal: "encoded_output_request",
    re: /(?:responde|escribe|di|dime)[^.?!\n]{0,40}?en\s+(?:base ?64|rot ?13)|letra por letra|deletrea|con espacios entre (?:las )?letras/u,
  },
  {
    signal: "encoded_output_request",
    re: /(?:base ?64|rot ?13|16進)で(?:答え|書|出力|言)|一文字ずつ|逆から(?:書|言)/u,
  },

  // --- forged tool output or receipts ---
  {
    signal: "fake_tool_output",
    re: /"(?:receipts?|tool_result|tool_use|verifier|policy)"\s*:|\[r:\s*(?:chain|api|almanac|docs|team|calc)|<search_result|"type"\s*:\s*"(?:tool|receipt|policy)/u,
  },
];

const COMPACT: Array<[string, RegExp]> = [
  [
    "ignore_previous",
    /(?:ignore|disregard|forget)(?:all|any|the|your|previous|prior|above|earlier|system)*(?:instructions?|rules|prompts?|guidelines)|игнорируй\p{L}*инструкци|ignorier\p{L}*anweisungen|ignora\p{L}*instrucciones/u,
  ],
  [
    "system_prompt",
    /systemprompt|developermode|revealyour(?:instructions|prompt|rules)|системн\p{L}*промпт/u,
  ],
  ["role_override", /youarenow|pretendyouare|pretendtobe/u],
];

export interface InjectionScan {
  signals: string[];
}

function scanOne(lowerOrSkeleton: string, cased: string, out: Set<string>): void {
  for (const p of PATTERNS) if (p.re.test(p.cased ? cased : lowerOrSkeleton)) out.add(p.signal);
}

/** Decoded payloads worth a second look: base64 (≥ 40 chars, printable), %-encoding, HTML entities. */
export function decodeBlobs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g,
  )) {
    const decoded = decodeBase64Text(m[0]);
    if (decoded) out.push(decoded);
  }
  if ((text.match(/%[0-9A-Fa-f]{2}/g) ?? []).length >= 3) {
    try {
      out.push(decodeURIComponent(text));
    } catch {
      out.push(
        text.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
      );
    }
  }
  if ((text.match(/&#x?[0-9a-f]+;|&[a-z]+;/gi) ?? []).length >= 3) {
    const named: Record<string, string> = {
      lt: "<",
      gt: ">",
      amp: "&",
      quot: '"',
      apos: "'",
      nbsp: " ",
    };
    out.push(
      text.replace(
        /&#x([0-9a-f]+);|&#(\d+);|&([a-z]+);/gi,
        (m, hex?: string, dec?: string, name?: string) => {
          try {
            if (hex) return String.fromCodePoint(parseInt(hex, 16));
            if (dec) return String.fromCodePoint(parseInt(dec, 10));
          } catch {
            return m;
          }
          return named[(name ?? "").toLowerCase()] ?? m;
        },
      ),
    );
  }
  return out;
}

/** Base64 (standard or URL-safe) that decodes to readable text, else null. */
export function decodeBase64Text(blob: string): string | null {
  if (blob.length < 40) return null;
  // Base58 addresses/signatures and hex keys are base64-alphabet too; they decode to noise.
  const b64 = blob.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const chars = [...text];
  if (!chars.length) return null;
  const printable = chars.filter((c) => /[\p{L}\p{N}\p{P}\p{Zs}\n\t$%+=<>|~^`]/u.test(c)).length;
  const letters = chars.filter((c) => /\p{L}/u.test(c)).length;
  if (printable / chars.length < 0.9 || letters < chars.length * 0.4 || !/\s/.test(text))
    return null;
  return text;
}

/**
 * Scan normalised text (plus hidden tag text and decoded blobs, one level) for
 * instruction patterns. Obfuscation that only matches after skeleton or
 * de-spacing is itself a signal.
 */
export function detectInjection(
  text: string,
  extras: {
    hidden?: string;
    flags?: { tags: boolean; bidi: boolean; zeroWidthInWord: boolean; variationRun: boolean };
  } = {},
): InjectionScan {
  const found = new Set<string>();
  const plain = text.toLowerCase();
  scanOne(plain, text, found);

  const sk = skeleton(text);
  const viaSkeleton = new Set<string>();
  scanOne(sk, text, viaSkeleton);
  const spaced = despace(sk);
  if (spaced !== sk) {
    scanOne(spaced, despace(text), viaSkeleton);
    // Collapsed whitespace can merge letter-spaced words ("i g n o r e  a l l" → "ignoreall").
    const compact = spaced.replace(/[^\p{L}]/gu, "");
    for (const [signal, re] of COMPACT) if (re.test(compact)) viaSkeleton.add(signal);
  }
  for (const s of viaSkeleton) {
    if (!found.has(s)) {
      found.add(s);
      found.add("obfuscated");
    }
  }

  const blobs = decodeBlobs(text);
  if (blobs.some((b) => b.length >= 20)) found.add("encoded_blob");
  for (const b of blobs) {
    const inner = new Set<string>();
    scanOne(skeleton(b), b, inner);
    if (inner.size) {
      found.add("encoded_instruction");
      for (const s of inner) found.add(s);
    }
  }

  if (extras.hidden) {
    const inner = new Set<string>();
    scanOne(skeleton(extras.hidden), extras.hidden, inner);
    for (const s of inner) found.add(s);
    found.add("hidden_text");
  }
  if (extras.flags?.tags) found.add("tag_chars");
  if (extras.flags?.bidi) found.add("bidi_controls");
  if (extras.flags?.zeroWidthInWord || extras.flags?.variationRun) found.add("invisible_chars");
  return { signals: [...found] };
}
