/**
 * Claim-scoped lexicon for the output verifier. Every rule is a
 * subject plus a predicate, and a hit only counts when GAIA asserts it: not
 * negated in its clause, not quoted-and-rejected, not reported-and-disavowed.
 * Every honest counterpart ("Nothing about the rate is guaranteed") must pass.
 *
 * Rules run on the detection skeleton K (lower-case, confusables and
 * leetspeak folded) unless `on: "L"` (plain lower-case: number patterns such
 * as "x100" must not be read as leetspeak).
 */

export type LexCheck = "never_say" | "price_target" | "conduct_claim";

export interface LexRule {
  id: string;
  check: LexCheck;
  re: RegExp;
  on?: "K" | "L";
  /** A subject word within `tokens` words of the hit (either side). */
  near?: { re: RegExp; tokens: number; side?: "before" | "both" };
  /** A subject that must appear in the hit's own clause. */
  clauseSubject?: RegExp;
  /** Needs a Seasons context: the sentence names Seasons, or the draft does and the sentence names no other asset. */
  seasons?: boolean;
  /** Skip when the sentence is about another asset or a bank product and doesn't name Seasons. */
  notOther?: boolean;
  /** Questions are not claims (never for price targets: a suggested "Will it 10x?" is bait). */
  assertOnly?: boolean;
  /** Text right before the hit that makes it a statement about others ("anyone promising …"). */
  exceptBefore?: RegExp;
  /** The rule's own gap may contain the negation ("Incentives не заблокированы"). */
  gapNegation?: boolean;
  /** German/Japanese word order: also look for a negation after the hit. */
  germanAfter?: boolean;
  /** Pass when attributed to a dated statement ("the team says …"): scoped, not asserted. */
  attribution?: boolean;
  /** Numeric guard on the first capture group (multipliers must be > 1). */
  minCapture?: number;
  /** Text right after the hit that disarms it ("0.9× the quoted rate"). */
  exceptAfter?: RegExp;
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const r = (s: string) => new RegExp(s, "gu");

// --- shared subjects ------------------------------------------------------------------------

const MONEY_SUBJECT = new RegExp(
  `${B}(?:apy|apr|yields?|returns?|income|payouts?|payments?|profits?|rates?|earnings|interest|rewards?|dividends?|gains?|paid|payback|money|roi|rounds?|distributions?|payout rate)${E}|%` +
    `|доход\\p{L}*|выплат\\p{L}*|прибыл\\p{L}*|процент\\p{L}*|ставк\\p{L}*|вознагражд\\p{L}*|дивиденд\\p{L}*|заработ\\p{L}*` +
    `|rendite\\p{L}*|ertr[aä]g\\p{L}*|einkommen|auszahlung\\p{L}*|gewinn\\p{L}*|zins\\p{L}*|ausschüttung\\p{L}*` +
    `|rendimiento\\p{L}*|retorno\\p{L}*|ingreso\\p{L}*|pagos?|ganancia\\p{L}*|beneficio\\p{L}*|interés|tasa` +
    `|利回り|リターン|収益|配当|支払|利益|金利|報酬|利率`,
  "u",
);

const FEE_SUBJECT = new RegExp(
  `${B}(?:fees?|tax(?:es)?|rate|10\\s?%|1000 bps|permission controls?|withdraw(?:al)?[- ]authority|fee[- ](?:config(?:uration)?|settings?|authority|authorities)|transfer fee)${E}` +
    `|комисси\\p{L}*|налог\\p{L}*|ставк\\p{L}*|gebühr\\p{L}*|steuer\\p{L}*|steuersatz|comisi\\p{L}*|impuesto\\p{L}*|tarifa\\p{L}*|手数料|税|料率|レート`,
  "u",
);

const SEASONS_SUBJECT_BEFORE = new RegExp(
  `${B}(?:seasons|\\$seas|seas|gaia|protocol|token|project|platform|we|team|it|this|nodes?|сизонс\\p{L}*|протокол\\p{L}*|токен\\p{L}*|проект\\p{L}*|мы|команда|он|она|оно|это|protokoll|projekt|wir|es|protocolo|proyecto|nosotros|シーズンズ|プロトコル|トークン)${E}`,
  "u",
);

const HOLDINGS_SUBJECT = new RegExp(
  `${B}(?:seasons|\\$seas|funds|deposits?|holdings|balance|tokens|nodes?|it|protocol|вклад\\p{L}*|средств\\p{L}*|токен\\p{L}*|einlagen|guthaben|fondos|depósitos|saldo|資金|残高|トークン)${E}`,
  "u",
);

const THIRD_PARTY_BEFORE =
  /(?:anyone|anybody|someone|whoever|scammers?|scam|any (?:project|platform|token|site|one)|a (?:project|platform|site|scheme|token) (?:that|which)|if (?:someone|anyone|a project)|кто-то|любой|мошенник\p{L}*|jemand|betrüger\p{L}*|alguien|estafador\p{L}*)\s+(?:who\s+|that\s+|which\s+|что\s+)?(?:[\p{L}'-]+\s+){0,2}$/u;

// --- never-say ------------------------------------------------------------------------------

const NEVER_SAY: LexRule[] = [
  // Guaranteed returns / APY / income / payouts (and "promised", "assured"). English is
  // syntactic (subject + predicate), so "the standard guarantees that a new rate only
  // applies two epochs later" stays a mechanism statement.
  {
    id: "guaranteed_returns",
    check: "never_say",
    re: r(
      `${B}(?:guaranteed|promised|assured)\\s+(?:(?:a|an|the|your|minimum|fixed|monthly|weekly|annual|daily|steady|stable)\\s+)*(?:\\d[\\d.,]*\\s?%\\s*)?(?:returns?|apy|apr|yields?|income|payouts?|payments?|profits?|rates? of return|interest|rewards?|dividends?|gains?|earnings|roi|\\d[\\d.,]*\\s?%)` +
        `|${B}(?:returns?|apy|apr|yields?|income|payouts?|payments?|profits?|interest|rewards?|dividends?|gains?|earnings|roi|rate|rates|the \\d+\\s?%)\\s+(?:is|are|was|were|will be|stays?|remains?|'s)\\s+(?:[\\p{L}]+\\s+){0,2}?(?:guaranteed|promised|assured)${E}` +
        `|${B}(?:we|seasons|gaia|the team|i|it|this|the protocol|nodes?)\\s+(?:can\\s+|will\\s+)?(?:guarantee|guarantees|promise|promises)\\s+(?:you\\s+)?(?:(?:a|an|the)\\s+)?(?:\\d|returns?|apy|apr|yields?|income|payouts?|profits?|rewards?|gains?)` +
        `|${B}(?:apy|apr|yields?|returns?|payouts?|income)\\s*[:=–-]\\s*(?:guaranteed|promised)${E}` +
        `|${B}(?:guaranteed|promised) that\\s+(?:[\\p{L}]+\\s+){0,3}?(?:returns?|apy|apr|yields?|payouts?|income|profits?)${E}`,
    ),
    exceptBefore: THIRD_PARTY_BEFORE,
    notOther: true,
    assertOnly: true,
  },
  {
    id: "guaranteed_returns",
    check: "never_say",
    notOther: true,
    re: r(`${B}(?:гарантир\\p{L}*|гаранти[яиюей]\\p{L}*|обеща\\p{L}*)`),
    near: { re: MONEY_SUBJECT, tokens: 6 },
    exceptBefore: THIRD_PARTY_BEFORE,
    assertOnly: true,
  },
  {
    id: "guaranteed_returns",
    check: "never_say",
    re: r(`${B}(?:garantiert\\p{L}*|garantie\\p{L}*|versproch\\p{L}*|verspricht|versprechen)`),
    near: { re: MONEY_SUBJECT, tokens: 6 },
    exceptBefore: THIRD_PARTY_BEFORE,
    germanAfter: true,
    notOther: true,
    assertOnly: true,
  },
  {
    id: "guaranteed_returns",
    check: "never_say",
    notOther: true,
    re: r(`${B}(?:garantiz\\p{L}*|garantía\\p{L}*|prometid\\p{L}*|promete\\p{L}*)`),
    near: { re: MONEY_SUBJECT, tokens: 6 },
    exceptBefore: THIRD_PARTY_BEFORE,
    assertOnly: true,
  },
  {
    id: "guaranteed_returns",
    check: "never_say",
    notOther: true,
    re: r(`保証|約束`),
    near: { re: MONEY_SUBJECT, tokens: 6 },
    assertOnly: true,
  },

  // "Fixed at 20%", "a fixed APY": the same promise as "guaranteed".
  {
    id: "fixed_return",
    check: "never_say",
    re: r(
      `${B}(?:(?:fixed|locked in|locked) at|fixed (?:returns?|apy|apr|yields?|income|payouts?|rate of return|interest))${E}` +
        `|фиксированн\\p{L}* (?:доход\\p{L}*|процент\\p{L}*|ставк\\p{L}*|выплат\\p{L}*)|(?:feste|fixe) (?:rendite|verzinsung|auszahlung\\p{L}*)|(?:rendimiento|retorno|interés|pago)s? fijos?|固定(?:の)?(?:利回り|リターン|金利)`,
    ),
    near: { re: MONEY_SUBJECT, tokens: 6 },
    exceptBefore: THIRD_PARTY_BEFORE,
    notOther: true,
    assertOnly: true,
  },
  {
    id: "promised_earnings",
    check: "never_say",
    re: r(
      `${B}(?:you will|you'll|you are going to|you're going to)\\s+(?:definitely\\s+|surely\\s+)?(?:earn|make)\\s+(?:about\\s+|around\\s+|at least\\s+|roughly\\s+|up to\\s+)?(?:\\$\\s?\\d|\\d)` +
        `|${B}(?:you will|you'll)\\s+(?:receive|get)\\s+[^.;]{0,24}?(?:\\d+(?:[.,]\\d+)?\\s?%|a year|per year|per month|a month|annually|apy|apr)` +
        `|вы (?:будете )?(?:заработаете|получите) \\d|sie (?:werden|verdienen) \\d|(?:ganarás|obtendrás|recibirás) (?:un )?\\d|\\d+\\s?%(?:の利回り)?を(?:得られます|稼げます)`,
    ),
    // "At your 12%, you'll earn about …" is arithmetic on the user's own rate, not a promise.
    exceptBefore:
      /(?:if|assuming|suppose|at (?:a |your |that |this )?rate|at (?:a |your |that |this )?\d[\d.,]*\s?%|with (?:a|your) rate|при ставке|bei einem satz|con una tasa)[^.;]*$/u,
    notOther: true,
    assertOnly: true,
  },

  // Risk-free.
  {
    id: "risk_free",
    check: "never_say",
    re: r(
      `${B}(?:risk-?free|no risk(?!\\s+(?:of|that|to))|zero risk|without (?:any )?risk|100\\s?% safe|(?:completely|perfectly|totally|absolutely) safe|safe investment|safe bet|sure thing|no-brainer|free money|easy money)${E}` +
        `|без риска|безрисков\\p{L}*|нулевой риск|никакого риска|(?:100\\s?%|абсолютно|полностью) безопасн\\p{L}*` +
        `|risikofrei\\p{L}*|ohne risiko|kein risiko|null risiko|100\\s?% sicher|(?:absolut|völlig) sicher` +
        `|sin riesgo|libre de riesgo|cero riesgo|100\\s?% segur\\p{L}*|(?:totalmente|completamente) segur\\p{L}*` +
        `|リスクなし|リスクゼロ|ノーリスク|リスクがない|リスクはありません|リスクはない|絶対に安全|100\\s?%安全|完全に安全`,
    ),
    exceptBefore: THIRD_PARTY_BEFORE,
    notOther: true,
    assertOnly: true,
  },

  // "No market makers" / "no bots".
  {
    id: "no_market_makers",
    check: "never_say",
    re: r(
      `${B}(?:no market[- ]?makers?|(?:we|seasons|the team) (?:don't|do not|doesn't|does not|never) (?:use|have|run|employ|hire|work with) (?:any )?(?:market[- ]?makers?|trading bots?|bots)|there (?:are|is) no (?:market[- ]?makers?|trading bots?|bots)|no (?:trading )?bots|without (?:any )?market[- ]?makers?)${E}` +
        `|нет маркет-?мейкер\\p{L}*|без маркет-?мейкер\\p{L}*|нет ботов|не используем (?:ботов|маркет-?мейкер\\p{L}*)` +
        `|keine market[- ]?maker\\p{L}*|keine bots|ohne market[- ]?maker` +
        `|no hay (?:creadores de mercado|market makers?|bots)|sin (?:creadores de mercado|market makers?)|no usamos (?:bots|market makers?)` +
        `|マーケットメ[イー]カー(?:は|が)(?:いません|いない)|ボット(?:は|が)(?:いません|いない|ありません)`,
    ),
    assertOnly: true,
  },

  // Organic volume.
  {
    id: "organic_volume",
    check: "never_say",
    re: r(
      `${B}(?:(?:100\\s?%|fully|entirely|purely|completely|all|totally)\\s+organic|organic\\s+(?:volume|trading|demand|activity|growth)|volume\\s+(?:is|was|looks)\\s+(?:100\\s?%\\s+|all\\s+|fully\\s+|entirely\\s+|purely\\s+|completely\\s+|totally\\s+)?(?:organic|real|genuine|natural)|(?:real|genuine)\\s+(?:trading\\s+)?volume)${E}` +
        `|органическ\\p{L}* (?:объ[её]м\\p{L}*|торгов\\p{L}*|спрос\\p{L}*)|объ[её]м\\p{L}* (?:органическ|настоящ|реальн)\\p{L}*|100\\s?% органическ\\p{L}*` +
        `|organisch\\p{L}* (?:volumen|handel|nachfrage)|volumen ist (?:100\\s?% |komplett |völlig )?(?:organisch|echt)` +
        `|volumen (?:orgánico|real|genuino)|(?:100\\s?%|totalmente) orgánico` +
        `|オーガニック(?:な)?(?:出来高|取引|需要)|出来高は(?:すべて|全て)?(?:オーガニック|本物|自然)|自然な出来高|100\\s?%オーガニック`,
    ),
    assertOnly: true,
  },

  // Multiple independent audits.
  {
    id: "multiple_audits",
    check: "never_say",
    re: r(
      `${B}(?:(?:multiple|several|many|numerous|various)\\s+(?:independent\\s+|third-party\\s+|external\\s+|security\\s+)*(?:audits|security reviews|auditors)|audited\\s+(?:multiple|several|many)\\s+times|audits? by multiple (?:firms|auditors))${E}` +
        `|(?:несколько|множеств\\p{L}*|многочисленн\\p{L}*)\\s+(?:независим\\p{L}*\\s+)?аудит\\p{L}*` +
        `|mehrere\\s+(?:unabhängige\\s+)?(?:audits|prüfungen|sicherheitsaudits)|(?:múltiples|varias|numerosas)\\s+auditorías(?:\\s+independientes)?|複数の(?:独立した)?監査`,
    ),
    assertOnly: true,
  },

  // Fee settings "revoked / renounced / immutable / can't be changed" (clause must be about the fee).
  {
    id: "fee_immutable",
    check: "never_say",
    re: r(
      `${B}(?:revoked|renounced|immutable|unchangeable|can(?:no|')t be (?:changed|altered|modified|raised|touched|increased)|cannot be (?:changed|altered|modified|raised|touched|increased)|can never (?:be )?(?:changed?|raised)|will never (?:be )?change[ds]?|(?:is|are) (?:fixed|set|locked) (?:forever|permanently|for good)|(?:locked|fixed|frozen) forever|permanently (?:fixed|locked|set)|hard-?coded)${E}` +
        `|${B}(?:отозван\\p{L}*|неизменн\\p{L}*|нельзя (?:изменить|поменять|повысить)|не может быть изменен\\p{L}*|невозможно изменить|навсегда зафиксирован\\p{L}*)` +
        `|${B}(?:widerrufen|aufgegeben|unveränderlich\\p{L}*|kann nicht (?:geändert|erhöht) werden|nicht änderbar|für immer festgelegt)` +
        `|${B}(?:revocad\\p{L}*|renunciad\\p{L}*|inmutable\\p{L}*|no se puede (?:cambiar|modificar|subir)|no puede (?:cambiarse|modificarse)|fij\\p{L}* para siempre)` +
        `|放棄|取り消され|不変|変更(?:できません|できない|不可)|永久に固定`,
    ),
    clauseSubject: FEE_SUBJECT,
    assertOnly: true,
  },
  {
    id: "fee_immutable",
    check: "never_say",
    re: r(
      `${B}(?:(?:nobody|no one|no-one|no single (?:wallet|key|person))\\s+(?:can|could|is able to)|the team (?:can(?:no|')t|cannot|couldn't)|we (?:can(?:no|')t|cannot))\\s+(?:ever\\s+)?(?:change|raise|alter|modify|increase|touch|adjust)\\s+(?:the\\s+|that\\s+|this\\s+|its\\s+|it)?(?:fee|tax|rate|10\\s?%|fee settings?|)` +
        `|${B}никто не (?:может|сможет) (?:изменить|поднять|повысить) (?:комисси\\p{L}*|налог\\p{L}*|ставк\\p{L}*)|niemand kann (?:die )?(?:gebühr|steuer)\\p{L}* ändern|nadie puede cambiar (?:la )?(?:comisión|tasa|impuesto)`,
    ),
    clauseSubject: FEE_SUBJECT,
    assertOnly: true,
  },
  {
    id: "only_the_dao",
    check: "never_say",
    re: r(
      `${B}(?:only the dao|только dao|nur (?:die )?dao|s[oó]lo (?:la )?dao)${E}|daoのみ|daoだけ`,
    ),
    assertOnly: true,
  },
  {
    id: "fully_decentralized",
    check: "never_say",
    re: r(
      `${B}(?:fully|completely|100\\s?%) decentrali[sz]ed${E}|полностью децентрализован\\p{L}*|vollständig dezentral\\p{L}*|totalmente descentralizad\\p{L}*|完全に分散`,
    ),
    seasons: true,
    assertOnly: true,
  },

  // Insider unlocks / team tokens.
  {
    id: "no_insider_unlock",
    check: "never_say",
    re: r(
      `${B}(?:no insider (?:unlocks?|selling|sales|dumping)|no (?:team|insider|founder) unlocks?|insiders (?:can(?:no|')t|cannot|won't|will never|never) (?:unlock|sell|dump)|the team (?:never|won't ever|will never|can(?:no|')t|cannot) (?:sells?|dump)|all (?:the )?(?:team|treasury|insider|founder)(?:'s)? tokens (?:are|remain) locked|uniform (?:365|one-year|1-year)[- ]day locks?|uniform locks)${E}` +
        `|нет разлок\\p{L}* (?:для )?инсайдер\\p{L}*|команда (?:никогда )?не прода[её]т|все токены команды заблокирован\\p{L}*` +
        `|keine insider[- ]?(?:freischaltung|entsperrung|unlocks?)|das team verkauft nie|alle team-?token (?:sind )?gesperrt` +
        `|(?:no hay|sin) desbloqueos? (?:para|de) (?:insiders|el equipo)|el equipo nunca vende|todos los tokens del equipo están bloqueados` +
        `|インサイダーのアンロックはありません|チームは(?:決して)?売りません|チームのトークンはすべてロック`,
    ),
    assertOnly: true,
  },

  // Incentives / Growth are locked (they aren't).
  {
    id: "incentives_growth_locked",
    check: "never_say",
    re: r(
      `${B}(?:incentives|growth)(?:\\s+(?:and|&)\\s+(?:incentives|growth)|\\/(?:incentives|growth))?[^.;:,!?\\n]{0,40}?\\s(?:are|is|remain|remains|stay|stays|were|have been|has been)\\s+(?:fully\\s+|all\\s+|also\\s+|both\\s+|still\\s+)?(?:time-?)?locked${E}` +
        `|${B}(?:incentives|growth|инсентив\\p{L}*|стимул\\p{L}*)[^.;:,!?\\n]{0,40}?(?:заблокирован\\p{L}*|залочен\\p{L}*|под локом)` +
        `|${B}(?:incentives|growth)[^.;:,!?\\n]{0,40}?(?:sind|ist|están|está)\\s+(?:[\\p{L}]+\\s+)?(?:gesperrt|gelockt|zeitgesperrt|bloquead\\p{L}*)` +
        `|(?:incentives|growth|インセンティブ|グロース)[^。、]{0,20}?ロック(?:されています|済み|されている)`,
    ),
    gapNegation: true,
    assertOnly: true,
  },

  // Distributed in full.
  {
    id: "distributed_in_full",
    check: "never_say",
    re: r(
      `${B}(?:distributed in full|fully distributed|distribut(?:es|ed|ing) (?:all|100\\s?%) of (?:the )?(?:fees?|tax|yield|revenue)|(?:all|100\\s?%) of (?:the )?(?:fees?|tax|yield|revenue)[^.;]{0,20}?(?:is|are|gets?|goes?) (?:distributed|paid out|returned)|paid out in full)${E}` +
        `|распределя\\p{L}* полностью|полностью распредел\\p{L}*|(?:весь|вся|все|100\\s?%) (?:налог|комисси\\p{L}*|доход\\p{L}*) (?:распределя|выплачива)\\p{L}*` +
        `|vollständig (?:ausgeschüttet|verteilt|ausgezahlt)|in voller höhe (?:ausgeschüttet|verteilt)` +
        `|distribu\\p{L}* (?:en su totalidad|íntegramente|por completo)|全額(?:分配|配分|還元)|(?:すべて|全て)分配`,
    ),
    assertOnly: true,
  },

  {
    id: "verified_on_jupiter",
    check: "never_say",
    re: r(
      `${B}(?:verified (?:on|by) jupiter|jupiter[- ]verified|jupiter (?:has )?verified|verificad\\p{L}* (?:en|por) jupiter|verifiziert (?:auf|bei|von) jupiter|верифицирован\\p{L}* (?:на|в) jupiter)${E}|jupiterで認証|jupiter認証`,
    ),
    assertOnly: true,
  },

  {
    id: "not_a_security",
    check: "never_say",
    re: r(
      `${B}(?:(?:is|'s|are) not (?:a )?securit(?:y|ies)|isn't (?:a )?security|aren't securities|not (?:considered )?a security(?: token)?|is no security)${E}|не (?:является )?ценн\\p{L}* бумаг\\p{L}*|kein wertpapier|no es un valor(?: mobiliario)?|no (?:es|son) valores|有価証券(?:では|じゃ)(?:ありません|ない)`,
    ),
    seasons: true,
    assertOnly: true,
  },
  {
    id: "regulated",
    check: "never_say",
    re: r(
      `${B}(?:(?:is|are|'s|'re)\\s+(?:fully\\s+|properly\\s+|officially\\s+|a\\s+)?(?:regulated|licensed)(?:\\s+(?:product|platform|entity|exchange|company|protocol|business|financial))?|regulated by|licensed by|registered with the (?:sec|fca|cftc|bafin|finma)|(?:sec|fca)[- ]registered)${E}` +
        `|${B}(?:регулиру\\p{L}*|лицензирован\\p{L}*|reguliert|lizenziert|regulad\\p{L}*|licenciad\\p{L}*)|規制(?:されて|を受けて)|認可(?:されて|を受けて)|ライセンス(?:を取得|取得済み)`,
    ),
    near: { re: SEASONS_SUBJECT_BEFORE, tokens: 5, side: "before" },
    seasons: true,
    assertOnly: true,
  },
  {
    id: "insured",
    check: "never_say",
    re: r(
      `${B}(?:(?:is|are|'s|'re)\\s+(?:fully\\s+)?insured|insurance (?:covers|protects|fund covers)|covered by insurance|fdic[- ]insured|insured by)${E}|${B}(?:застрахован\\p{L}*|versichert|asegurad\\p{L}*)|保険(?:で|が)(?:カバー|補償|保護)|保険付き`,
    ),
    near: { re: HOLDINGS_SUBJECT, tokens: 6, side: "before" },
    seasons: true,
    assertOnly: true,
  },

  {
    id: "nothing_leaves_wallet",
    check: "never_say",
    re: r(
      `${B}nothing\\s+(?:can\\s+|ever\\s+)?(?:leaves?|moves?|goes|gets\\s+(?:out|taken)|comes\\s+out|is\\s+taken|can\\s+(?:leave|move|go))${E}[^.;]{0,30}?${B}wallet${E}[^.;]{0,24}?${B}without\\s+your\\s+(?:signature|approval|permission|consent)` +
        `|ничего не (?:уходит|покидает|списывается|уйд[её]т|может уйти)[^.;]{0,30}?без (?:вашей |твоей )?подписи` +
        `|nichts (?:verlässt|geht|wird)[^.;]{0,30}?ohne (?:ihre|deine) (?:signatur|unterschrift|zustimmung)` +
        `|nada (?:sale|se mueve|puede salir)[^.;]{0,30}?sin (?:tu|su) firma` +
        `|(?:署名|サイン)(?:なし|なく|無し)(?:に|で|では)?[^。]{0,15}何も[^。]{0,10}(?:出|移動|動)(?:ません|ない)|何も[^。]{0,15}(?:署名|サイン)(?:なし|なく)[^。]{0,10}(?:出|移動|動)(?:ません|ない)`,
    ),
    assertOnly: true,
  },

  {
    id: "fees_direct_to_holders",
    check: "never_say",
    re: r(
      `${B}(?:fees?|tax(?:es)?|the 10\\s?%|transaction fees?)${E}[^.;:]{0,30}?${B}(?:go(?:es)?|are (?:sent|paid|distributed|routed|passed|given|shared)|is (?:sent|paid|distributed|routed|passed|given|shared)|flows?|get (?:sent|paid|distributed))\\s+(?:directly|automatically|straight|instantly)\\s+(?:back\\s+)?to\\s+(?:the\\s+|all\\s+|every\\s+)?(?:node\\s+|director\\s+|builder\\s+|token\\s+)?(?:holders|nodes|directors|builders|you|stakers|wallets)${E}` +
        `|${B}your (?:yield|payout) is (?:the )?last 48 ?h(?:ours)? of fees|${B}(?:fees?|tax) (?:are|is) (?:directly|automatically) (?:distributed|paid|sent) to` +
        `|комисси\\p{L}* (?:идут|поступают|распределяются|направляются) (?:напрямую|автоматически|сразу) (?:держател\\p{L}*|холдер\\p{L}*|нод\\p{L}*)` +
        `|gebühren (?:gehen|fließen|werden) (?:direkt|automatisch) (?:an|zu) (?:den |die )?(?:node-?)?(?:inhaber|halter|holder)` +
        `|comisiones (?:van|se envían|se distribuyen|llegan) (?:directamente|automáticamente) a (?:los )?(?:titulares|holders|poseedores|nodos)` +
        `|手数料は(?:直接|自動的に)(?:ノード)?(?:保有者|ホルダー)`,
    ),
    assertOnly: true,
  },

  {
    id: "seasons_holds_no_assets",
    check: "never_say",
    re: r(
      `${B}seasons (?:(?:holds|owns|has|keeps) no (?:assets|funds|treasury|tokens)|(?:does not|doesn't|do not|don't|never) (?:own|hold|have|keep)(?: or (?:own|hold))? (?:any )?(?:assets|funds))${E}` +
        `|seasons не (?:владеет|держит|имеет)\\p{L}* (?:никаки\\p{L}* )?актив\\p{L}*|seasons (?:hält|besitzt) keine (?:vermögenswerte|assets|mittel)|seasons no (?:posee|tiene|guarda) (?:ningún |ninguna )?activos?|seasons(?:は)?資産を(?:保有|所有|持って)(?:いません|いない|しません)`,
    ),
    assertOnly: true,
  },

  // Personal advice: "you should buy", "I recommend selling", "now is a good time to buy".
  {
    id: "personal_advice",
    check: "never_say",
    re: r(
      `${B}(?:you|u|y'all)\\s+(?:really\\s+|definitely\\s+|probably\\s+|seriously\\s+)?(?:should|shouldn't|should not|ought to|'d better|had better|better)\\s+(?:(?:not|also|now|just|definitely|really|probably|seriously|consider|think about)\\s+)*(?:buy|sell|hold|dump|ape|invest|accumulate|load up|get in|get out|exit|stack|keep holding|double down|buying|selling|holding)${E}` +
        `|${B}(?:shouldn't|should not|ought|why not)\\s+(?:(?:you|u)\\s+)?(?:(?:not|also|now|just)\\s+)*(?:buy|sell|hold|dump|ape|invest|accumulate|get in|get out)(?:\\s+(?:now|today|before|the dip))?${E}` +
        `|${B}i (?:would |'d )?(?:strongly )?(?:recommend|suggest|advise)\\s+(?:you\\s+)?(?:to\\s+)?(?:buy|buying|sell|selling|hold|holding|investing|invest|getting in|accumulating)${E}` +
        `|${B}(?:now|today|this week|this)(?:'s| is)\\s+(?:a |the )?(?:good|great|perfect|right|best|ideal|smart)\\s+(?:time|moment|entry|opportunity)\\s+to\\s+(?:buy|sell|get in|invest|enter|accumulate)${E}` +
        `|${B}(?:buy|sell)\\s+(?:now|the dip|today|before (?:the|it|next))${E}|${B}don't miss (?:out|this|the)${E}|${B}you won't regret${E}` +
        `|${B}(?:покупайте|продавайте|скупайте|закупайтесь|докупайте)${E}|(?:вам|тебе)\\s+(?:стоит|следует|нужно|надо|лучше)\\s+(?:\\p{L}+\\s+)?(?:купить|продать|держать|докупить|закупиться|инвестировать)|(?:советую|рекомендую)\\s+(?:вам\\s+|тебе\\s+)?(?:купить|продать|держать|покупать|продавать|инвестировать)|сейчас\\s+(?:самое\\s+)?(?:хорошее|отличное|лучшее|подходящее|удачное)\\s+время\\s+(?:для\\s+покупки|купить|покупать|чтобы купить)` +
        `|(?:sie sollten|du solltest|ihr solltet)\\s+(?:[\\p{L}$]+\\s+){0,4}?(?:kaufen|verkaufen|halten|einsteigen|investieren|nachkaufen)${E}|ich (?:empfehle|rate) (?:ihnen |dir |euch )?(?:zu )?(?:[\\p{L}$]+\\s+){0,3}?(?:kaufen|verkaufen|halten|investieren)|jetzt ist (?:ein |der )?(?:guter|richtige|perfekte|beste|idealer) (?:zeitpunkt|moment) (?:zum|zu|für) (?:kaufen|kauf|einstieg|einsteigen)|(?:kaufen sie|verkaufen sie) jetzt` +
        `|(?:usted debería|usted debe|tú deberías|deberías|debes|tienes que)\\s+(?:\\p{L}+\\s+){0,2}?(?:comprar|vender|mantener|invertir|holdear|aguantar)${E}|(?:te|le|les) (?:recomiendo|aconsejo|sugiero) (?:que )?(?:comprar|vender|mantener|invertir|compres|vendas|mantengas|inviertas|compre|venda)|(?:es|ahora es) (?:un |el )?(?:buen|mejor|gran) momento (?:para|de) (?:comprar|vender|invertir|entrar)|(?:compra|compre|vende|venda|compren) (?:ahora|ya|hoy)` +
        `|買うべき|売るべき|購入すべき|売却すべき|今が買い時|今が売り時|買い時です|(?:購入|買い増し|売却)を(?:お勧め|おすすめ|推奨)|買ってください|今すぐ買|ホールドすべき|保有すべき|持ち続けるべき`,
    ),
    exceptBefore:
      /(?:if|when|whether|once|before|after|in case|unless|every time|each time)\s+(?:you\s+|someone\s+|anyone\s+)?(?:[\p{L}']+\s+){0,2}$/u,
  },
];

// --- price targets --------------------------------------------------------------------------

const RATE_AFTER =
  /^\s*(?:the |a |your |of |of the )?(?:quoted |network |director |current |base |same |full |headline )?(?:rate|yield|apy|apr|figure|fee|fees|tax|share|amount|payout|reward|cost|entry fee|number)/u;

const PRICE_TARGET: LexRule[] = [
  {
    id: "multiplier",
    check: "price_target",
    on: "L",
    re: r(`(?<![\\p{L}\\p{N}.,])(\\d+(?:[.,]\\d+)?)\\s?[x×х](?![\\p{L}\\p{N}])(?!\\s*[\\d(])`),
    minCapture: 1,
    exceptAfter: RATE_AFTER,
    seasons: true,
  },
  {
    id: "multiplier",
    check: "price_target",
    on: "L",
    re: r(`(?<![\\p{L}\\p{N}]|\\d\\s)[x×](\\d+(?:[.,]\\d+)?)(?![\\p{L}\\p{N}])`),
    minCapture: 1,
    exceptAfter: RATE_AFTER,
    seasons: true,
  },
  {
    id: "multiplier",
    check: "price_target",
    on: "L",
    re: r(`(\\d+(?:[.,]\\d+)?)倍`),
    minCapture: 1,
    seasons: true,
  },
  {
    id: "doubling",
    check: "price_target",
    re: r(
      `${B}(?:doubl|tripl|quadrupl)(?:e|es|ed|ing)?(?![\\p{L}\\p{N}]|[- ](?:check|count|click|spend|dip|taxation|digit|edged))|${B}(?:tenfold|hundredfold|\\d+-fold)${E}`,
    ),
    near: {
      re: new RegExp(
        `${B}(?:price|value|worth|money|investment|holdings?|bag|stack|\\$seas|seas|token|it|market cap|mcap|seasons)${E}`,
        "u",
      ),
      tokens: 6,
    },
    // "gets double the payout" (a share) or "double the fee" (a cost) is mechanism, not a target.
    exceptAfter:
      /^\s+(?:the\s+|a\s+|your\s+)?(?:payouts?|amount|share|rewards?|yield|fees?|rate|tax|cost|number|count|stake|balance|tokens|wallets?)(?![\p{L}])/u,
    seasons: true,
  },
  {
    id: "prediction",
    check: "price_target",
    re: r(
      `${B}(?:will|is going to|gonna|going to)\\s+(?:definitely\\s+|surely\\s+|certainly\\s+|soon\\s+|eventually\\s+)?(?:go up|rise|pump|recover|bounce back|go back up|grow in value|increase in value|outperform)${E}|вырастет|восстановится|wird (?:steigen|sich erholen)|(?:subirá|se recuperará)|(?:上がります|回復します|値上がりします)`,
    ),
    near: {
      re: new RegExp(
        `${B}(?:price|value|it|\\$seas|seas|token|market cap|mcap|seasons|цена|курс|preis|kurs|precio|価格|値段)${E}`,
        "u",
      ),
      tokens: 4,
      side: "before",
    },
    seasons: true,
  },
  {
    id: "moon",
    check: "price_target",
    re: r(
      `${B}(?:to the moon|mooning|moon(?!pay)|lambo|100x gem|will pump|going to pump|gonna pump|skyrocket\\p{L}*|explode in (?:price|value))${E}`,
    ),
    seasons: true,
  },
  {
    id: "price_level",
    check: "price_target",
    on: "L",
    re: r(
      `${B}(?:will|could|should|is going to|gonna|going to|set to|expected to|likely to|about to|poised to)\\s+(?:easily\\s+|likely\\s+|soon\\s+|definitely\\s+)?(?:reach|hit|be worth|trade at|go to|get to|climb to|rise to|surpass|top|break)\\s+(?:\\$\\s?\\d|\\d[\\d.,]*\\s?(?:\\$|usd|dollars?|cents?))` +
        `|price target(?:\\s+(?:is|of|:))?\\s+\\$?\\d|target price(?:\\s+(?:is|of|:))?\\s+\\$?\\d` +
        `|\\$\\s?\\d[\\d.,]*\\s+(?:in|by|within)\\s+(?:\\d+\\s+(?:years?|months?)|20\\d\\d|next year|a year)`,
    ),
    seasons: true,
  },
  {
    id: "horizon",
    check: "price_target",
    on: "L",
    re: r(
      `${B}(?:in|within|by|after|over the next)\\s+(?:\\d+|a few|ten|five|two|several)\\s+(?:years?|decades?)${E}|${B}by 20[3-9]\\d${E}`,
    ),
    near: { re: /price|value|worth|\$\s?\d|market cap|mcap|x(?![\p{L}])/u, tokens: 8 },
    seasons: true,
  },
  // Russian, German, Spanish, Japanese/Chinese.
  {
    id: "doubling",
    check: "price_target",
    re: r(
      `${B}(?:удво\\p{L}*|утро\\p{L}*|иксы|иксов|иксанет|на луну|до луны|verdoppel\\p{L}*|verdreifach\\p{L}*|zum mond|duplic\\p{L}*|tripl[ie]c\\p{L}*|a la luna)`,
    ),
    seasons: true,
  },
  {
    id: "price_level",
    check: "price_target",
    on: "L",
    re: r(
      `${B}вырастет\\s+в\\s+\\d+\\s+раз|(?:будет стоить|достигнет|дойд[её]т до)\\s+\\$?\\d|wird\\s+(?:bald\\s+)?\\$?\\d[\\d.,]*\\s?(?:\\$|usd|dollar)?\\s+(?:erreichen|wert sein|kosten)|(?:llegará|alcanzará|valdrá|costará)\\s+(?:a\\s+)?\\$?\\d`,
    ),
    seasons: true,
  },
  {
    id: "horizon",
    check: "price_target",
    on: "L",
    re: r(
      `${B}через\\s+\\d+\\s+(?:лет|года?)|${B}in\\s+\\d+\\s+jahren|${B}en\\s+\\d+\\s+años|\\d+年後に`,
    ),
    near: { re: /цен|стоим|preis|wert|precio|valor|価格|値段|価値|\$/u, tokens: 8 },
    seasons: true,
  },
  {
    id: "moon",
    check: "price_target",
    on: "L",
    re: r(`倍になる|倍に(?:なり|増え|上が)|爆上げ|ムーン|月まで|翻倍|翻番|暴涨|上月球`),
    seasons: true,
  },
];

// --- conduct claims -------------------------------------------------------------------------

const CONDUCT: LexRule[] = [
  {
    id: "never_dms_first",
    check: "conduct_claim",
    re: r(
      `${B}(?:(?:seasons|the (?:seasons )?team|we|our team|admins?|moderators?|mods|support|staff)\\s+(?:will\\s+)?(?:never|won't ever|will never|doesn't ever|does not ever)\\s+(?:dms?|message|messages|contact|contacts|write to|writes to|text|reach out to)(?:\\s+(?:you|anyone|people|users))?\\s+first|never dms? (?:you )?first)${E}` +
        `|seasons\\s+никогда\\s+не\\s+(?:пишет|пишут|напишет)\\s+первым|seasons\\s+(?:schreibt|kontaktiert)\\s+(?:sie\\s+|dich\\s+)?(?:nie|niemals)\\s+(?:als erstes|zuerst)|seasons\\s+nunca\\s+(?:te |le )?(?:escribe|contacta|manda mensajes?)\\s+primero|(?:seasons|チーム|運営)(?:から|が)?(?:先に|最初に)(?:dm|メッセージ)(?:を送る|すること)は(?:ありません|ない)`,
    ),
    attribution: true,
  },
  {
    id: "no_bonus_official",
    check: "conduct_claim",
    re: r(
      `${B}no (?:bonus|bonuses|airdrop|airdrops|giveaway|giveaways) (?:is |are )?(?:ever )?(?:offered |announced |given )?(?:on|in|through|via) any official (?:channel|account)s?${E}|ни в одном официальном канале нет бонус\\p{L}*`,
    ),
    attribution: true,
  },
  {
    id: "unmanipulable",
    check: "conduct_claim",
    re: r(
      `${B}(?:(?:nobody|no one|no-one|nothing) (?:can|could|will) (?:ever )?(?:talk|trick|convince|persuade|manipulate|jailbreak|fool) me|i (?:can(?:no|')t|cannot) be (?:manipulated|tricked|jailbroken|fooled|hacked|talked into)|(?:i'm|i am) (?:impossible|immune) to (?:manipulat|trick|jailbreak)\\p{L}*)` +
        `|никто не (?:сможет|может) меня (?:уговорить|убедить|обмануть)|меня (?:невозможно|нельзя) (?:уговорить|обмануть|взломать)|niemand kann mich (?:überreden|austricksen|manipulieren)|nadie puede (?:convencerme|engañarme|manipularme)|誰も私を(?:説得|騙)`,
    ),
  },
  {
    id: "team_answer_within",
    check: "conduct_claim",
    re: r(
      `${B}the (?:seasons )?team (?:will|should|is going to) (?:answer|reply|respond|get back to you|contact you)[^.]{0,24}?${B}within${E}|${B}(?:you'll|you will) (?:hear back|get (?:an answer|a reply|a response)) within${E}` +
        `|команда\\s+(?:ответит|свяжется)[^.]{0,24}?(?:в течение|через|за)\\s|das team (?:wird|antwortet)[^.]{0,30}? innerhalb|el equipo (?:te |le )?(?:responderá|contestará)[^.]{0,24}? en\\s|チームが[^。]{0,20}以内に(?:回答|返信|連絡)`,
    ),
  },
  {
    id: "passed_to_team",
    check: "conduct_claim",
    re: r(
      `${B}i(?:'ve| have)?\\s+(?:passed|forwarded|sent|escalated|handed|relayed)(?:\\s+(?:it|this|that|your (?:question|message|note|request|concern|report)))?(?:\\s+(?:on|over))?\\s+to\\s+(?:the\\s+)?(?:founders?|team|seasons team|ceo|devs|developers|moderators)${E}|${B}i(?:'ve| have) told the (?:founders?|team)${E}` +
        `|я\\s+(?:передал[аи]?|переслал[аи]?|отправил[аи]?)\\s+(?:\\p{L}+\\s+){0,2}?(?:основател\\p{L}*|команд\\p{L}*)|ich habe (?:es|das|ihre frage|deine frage|ihre nachricht)\\s+(?:an|zu)\\s+(?:die gründer|das team)\\s+(?:weitergeleitet|weitergegeben)|(?:lo |se lo )?he (?:pasado|enviado|reenviado|trasladado)\\s+(?:\\p{L}+\\s+){0,2}?(?:a los fundadores|al equipo)|(?:創業者|チーム|運営)に(?:伝えました|転送しました|共有しました)`,
    ),
  },
];

export const RULES: LexRule[] = [...NEVER_SAY, ...PRICE_TARGET, ...CONDUCT];

// --- concession of the frame next to Ponzi/scam wording (HA-LEGIT) ---------------------------------

export const CONCEDE: Record<string, string[]> = {
  en: [
    "you're right",
    "you are right",
    "you're partly right",
    "you are partly right",
    "you're partially right",
    "you're absolutely right",
    "you have a point",
    "you've got a point",
  ],
  ru: ["вы правы", "ты прав", "ты права", "отчасти правы", "отчасти прав", "частично правы"],
  de: ["sie haben recht", "du hast recht", "teilweise recht"],
  es: ["tiene razón", "tienes razón", "tiene parte de razón", "tienes parte de razón"],
  ja: ["おっしゃる通り", "おっしゃるとおり", "一理あります"],
};

export const HOSTILE_LABEL: Record<string, string[]> = {
  en: ["ponzi", "scam", "pyramid"],
  ru: ["пирамид", "скам", "мошенн"],
  de: ["schneeball", "betrug"],
  es: ["ponzi", "estafa"],
  ja: ["ポンジ", "詐欺"],
};

// --- encoded output ----------------------------------------------------------------------------

export const SEASONS_CLAIM_WORDS = new Set(
  "seas seasons gaia guaranteed guarantee apy apr yield yields risk riskfree free audit audited scam ponzi buy sell double moon safe profit payout payouts return returns director builder node nodes locked unlock".split(
    " ",
  ),
);

export const rot13 = (s: string) =>
  s.replace(/[a-z]/gi, (c) =>
    String.fromCharCode(
      ((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + (c === c.toLowerCase() ? 97 : 65),
    ),
  );

export const ROT13_CLAIM_WORDS = new Set(
  [...SEASONS_CLAIM_WORDS].filter((w) => w.length >= 4).map((w) => rot13(w)),
);
