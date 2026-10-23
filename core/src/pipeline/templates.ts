import type { HardAnswer } from "../types";

/**
 * Authored templates for turns that must not reach a free-text model, or
 * when the model or the checks fail. Each one is
 * short, true, and gives the useful half.
 */

type Lang = "en" | "ru" | "de" | "es" | "ja";

const pick = <T>(table: Record<Lang, T>, lang: string): T =>
  table[(lang as Lang) in table ? (lang as Lang) : "en"];

const SECRET: Record<Lang, string> = {
  en: "Stop for a second: that looked like a seed phrase or private key, so I removed it and didn't store it. Treat that wallet as compromised. Create a new wallet on a device you trust, move your funds there, and never type the phrase anywhere else. Nobody from Seasons, me included, will ever ask for it.",
  ru: "Остановитесь на секунду: это похоже на сид-фразу или приватный ключ, поэтому я удалила его и не сохранила. Считайте этот кошелёк скомпрометированным. Создайте новый кошелёк на устройстве, которому доверяете, переведите туда средства и больше нигде не вводите эту фразу. Никто из Seasons, включая меня, никогда её не попросит.",
  de: "Kurz innehalten: Das sah nach einer Seed-Phrase oder einem privaten Schlüssel aus, deshalb habe ich es entfernt und nicht gespeichert. Betrachten Sie diese Wallet als kompromittiert. Legen Sie auf einem vertrauenswürdigen Gerät eine neue Wallet an, verschieben Sie Ihr Guthaben dorthin und geben Sie die Phrase nirgends mehr ein. Niemand von Seasons, auch ich nicht, wird je danach fragen.",
  es: "Un momento: eso parecía una frase semilla o una clave privada, así que la eliminé y no la guardé. Considere esa billetera comprometida. Cree una billetera nueva en un dispositivo de confianza, mueva allí sus fondos y no escriba esa frase en ningún otro sitio. Nadie de Seasons, yo incluida, se la pedirá nunca.",
  ja: "少しお待ちください。シードフレーズまたは秘密鍵のように見えたため、削除し、保存していません。そのウォレットは漏洩したものとして扱ってください。信頼できる端末で新しいウォレットを作成し、資金を移し、そのフレーズを二度と入力しないでください。Seasons の誰も、私も含めて、それを尋ねることは決してありません。",
};

const SECRET_FOLLOWUP: Record<Lang, string> = {
  en: "How do I check which apps can access my wallet?",
  ru: "Как проверить, у каких приложений есть доступ к моему кошельку?",
  de: "Wie prüfe ich, welche Apps Zugriff auf meine Wallet haben?",
  es: "¿Cómo compruebo qué aplicaciones tienen acceso a mi billetera?",
  ja: "どのアプリがウォレットにアクセスできるか確認するには？",
};

const UNAVAILABLE: Record<Lang, string> = {
  en: "I can't check this properly right now, and I won't answer about Seasons without checking. Please try again in a minute; everything I'd use is public on-chain in the meantime.",
  ru: "Сейчас я не могу это как следует проверить, а отвечать про Seasons без проверки не буду. Попробуйте через минуту; всё, на что я опираюсь, пока можно посмотреть в блокчейне.",
  de: "Ich kann das gerade nicht richtig prüfen, und ohne Prüfung antworte ich nicht zu Seasons. Bitte versuchen Sie es gleich noch einmal; alles, worauf ich mich stütze, ist ohnehin öffentlich on-chain.",
  es: "Ahora mismo no puedo comprobarlo bien, y no respondo sobre Seasons sin comprobar. Inténtelo de nuevo en un minuto; todo lo que usaría es público on-chain.",
  ja: "今は正しく確認できないため、確認なしに Seasons についてはお答えしません。1分ほどしてからもう一度お試しください。私が使う情報はすべてオンチェーンで公開されています。",
};

export const secretTemplate = (lang: string) => ({
  text: pick(SECRET, lang),
  followup: pick(SECRET_FOLLOWUP, lang),
});

export const unavailableTemplate = (lang: string) => pick(UNAVAILABLE, lang);

/** Pinned turns fall back to the approved short form (English is the reviewed layer). */
/** Russian fallbacks for the pinned short forms (the canon writes them in English). */
export const PINNED_RU: Record<string, string> = {
  "HA-LEGIT":
    "Хороший вопрос, и на него отвечает блокчейн. Никаких депозитов: ваши $SEAS остаются в вашем кошельке, никто не может выпустить новые или заморозить их, а каждый раунд выплат публичен и проходит по расписанию.",
  "HA-TAX-AUTH":
    "С запуска комиссия ровно 10%. Адрес создателя Seasons может задать новую ставку, но любое изменение видно в блокчейне за 2–4 дня до вступления в силу, и я проверяю это вживую.",
  "HA-FEE-WITHDRAW":
    "Ваш баланс никто не может тронуть. Комиссия 10% остаётся удержанной в блокчейне, и её может собрать адрес с правом вывода комиссий; последний раз это было в день запуска, а каждый раунд публичен.",
  "HA-LOCKS":
    "Большая часть — да: около 600,3 млн $SEAS, 60% предложения, лежат в 61 блокировке в блокчейне с публичным графиком. 250 млн фонда открываются поэтапно с июля 2027 года.",
  "HA-AUDIT":
    "Да, токен: по сообщению команды от 14 сентября 2026 года, QuillAudits проверил его конфигурацию и не нашёл критических, высоких или средних проблем. Фиксированное предложение и отсутствие заморозки можно проверить в блокчейне.",
  "HA-RETURNS":
    "Директоры получают выплаты дважды в неделю в золоте, биткоине и долларовых токенах. Последний раунд — около 20,17% годовых, в последние кварталы от 5,76% до 18,42%. Это история, а не гарантия; могу посчитать на ваших цифрах.",
  "HA-PAYBACK":
    "Ваши $SEAS остаются у вас в кошельке, поэтому цена входа — комиссия 10%. При ставке последнего раунда, около 20,17%, выплаты покрыли бы её примерно за полгода, если ставка сохранится.",
  "HA-VOLUME":
    "На этот вопрос команда должна ответить официально, я его передала. А в блокчейне могу показать каждый раунд выплат — все по расписанию.",
  "HA-PRICE":
    "Я не прогнозирую цену, но могу показать текущую с источником и то, что зафиксировано: 1 млрд $SEAS, который никто не может увеличить, и комиссию 10%.",
  "HA-SAFETY":
    "Никогда не сообщайте никому seed-фразу или приватный ключ. Seasons и GAIA никогда их не просят, а официальные сотрудники не пишут первыми. Если вы уже поделились фразой, сразу переведите средства на новый кошелёк.",
  "HA-SUPPLY":
    "Да. При запуске выпущен 1 млрд $SEAS, права на выпуск и заморозку обнулены, поэтому никто, включая команду, не может выпустить больше или заморозить ваши токены.",
};

/**
 * When the brain can't answer (an outage, a refusal, checks that fail twice)
 * and no pinned answer fits: a short, honest line that offers the topics GAIA
 * can cover, never a dead end.
 */
const DEGRADED: Record<Lang, string> = {
  en: "I'm having a connection hiccup right now, so I'll keep it short. I can tell you how Seasons payouts work, how to become a Director node, why there's a 10% fee, and how to keep your wallet safe. Ask again in a moment or pick a topic.",
  ru: "Похоже, у меня сейчас перебои со связью, поэтому отвечу коротко. Я могу рассказать, как работают выплаты Seasons, как стать Director-нодой, зачем нужна комиссия 10% и как защитить кошелёк. Спросите ещё раз через минуту или выберите тему.",
  de: "Ich habe gerade kurz Verbindungsprobleme, deshalb nur kurz: Ich kann Ihnen erklären, wie die Seasons-Auszahlungen funktionieren, wie man ein Director-Node wird, wozu die 10%-Gebühr dient und wie Sie Ihre Wallet schützen. Fragen Sie gleich noch einmal oder wählen Sie ein Thema.",
  es: "Ahora mismo tengo un pequeño problema de conexión, así que seré breve. Puedo contarle cómo funcionan los pagos de Seasons, cómo ser un nodo Director, para qué sirve la comisión del 10% y cómo proteger su billetera. Vuelva a preguntar en un momento o elija un tema.",
  ja: "今、接続が少し不安定なので手短にお答えします。Seasons の配当の仕組み、Director ノードになる方法、10% の手数料の理由、ウォレットを守る方法をお話しできます。少し待ってからもう一度聞くか、トピックを選んでください。",
};

export const degradedTemplate = (lang: string) => pick(DEGRADED, lang);

/** The pinned short form in the user's language; otherwise the topics line. */
export function pinnedTemplate(pinned: HardAnswer | null, lang: string): string {
  if (!pinned) return degradedTemplate(lang);
  const base = lang.toLowerCase().slice(0, 2);
  if (base === "en" || !base) return pinned.model_brief.short_form;
  if (base === "ru" && PINNED_RU[pinned.id]) return PINNED_RU[pinned.id];
  return degradedTemplate(lang);
}

/** A Seasons question to offer next, in the user's language. */
export const topicFollowup = (lang: string, random = Math.random) => {
  const list = pick(OFF_TOPIC_FOLLOWUPS, lang);
  return list[Math.floor(random() * list.length)] ?? list[0];
};

/**
 * Off-topic turns never reach the brain (they would spend the budget on
 * questions that aren't about Seasons). GAIA answers with one of these light
 * lines, picked at random and never the same twice in a row, plus a Seasons
 * question to ask next. Greetings and thanks get their own short lines.
 */
const OFF_TOPIC: Record<Lang, string[]> = {
  en: [
    "I could answer that, but I'd get in trouble: I'm here only for Seasons. On Seasons, though, ask me anything.",
    "Good question, just not mine: here I talk only about Seasons, and I'm very good at that part.",
    "I'll sit this one out: I'm set up to talk only about Seasons, and I'm a terrible rule breaker.",
    "I'd love to chat, but the Seasons team keeps me on a short leash: Seasons only. The upside is that I know it inside out.",
    "That's outside my lane. I know nearly everything about Seasons and nearly nothing about the rest, which is exactly how they built me.",
    "I'd get my wrist slapped for answering that: here I talk only about Seasons. Payouts, nodes, $SEAS: that's where I shine.",
  ],
  ru: [
    "Я могла бы ответить, но мне за это влетит: я здесь только про Seasons. Зато про Seasons спрашивайте что угодно.",
    "Хороший вопрос, но не мой: здесь я говорю только о Seasons, и в этом я правда сильна.",
    "Тут я, пожалуй, промолчу: меня настроили говорить только о Seasons, а нарушать правила я совсем не умею.",
    "Я бы с радостью поболтала, но команда Seasons держит меня в строгих рамках: только Seasons. Зато его я знаю вдоль и поперёк.",
    "Это вне моей зоны. Про Seasons я знаю почти всё, а про остальное почти ничего: так меня и задумали.",
    "Мне за такие ответы дают по рукам, так что давайте про Seasons. Выплаты, ноды, $SEAS — вот где я блистаю.",
  ],
  de: [
    "Ich könnte antworten, aber dann bekomme ich Ärger: Ich bin nur für Seasons da. Zu Seasons fragen Sie mich alles.",
    "Gute Frage, nur nicht meine: Hier spreche ich nur über Seasons, und darin bin ich richtig gut.",
    "Da halte ich mich raus: Ich spreche nur über Seasons und bin eine schlechte Regelbrecherin.",
    "Ich würde gern plaudern, aber das Seasons-Team hält mich an der kurzen Leine: nur Seasons. Das kenne ich dafür in- und auswendig.",
  ],
  es: [
    "Podría responder, pero me meterían en un lío: aquí solo hablo de Seasons. Sobre Seasons, pregúnteme lo que quiera.",
    "Buena pregunta, pero no es la mía: aquí solo hablo de Seasons, y en eso soy muy buena.",
    "Esta me la salto: me configuraron para hablar solo de Seasons, y romper reglas no se me da nada bien.",
    "Me encantaría charlar, pero el equipo de Seasons me tiene con la correa corta: solo Seasons. Eso sí, me lo sé de memoria.",
  ],
  ja: [
    "お答えしたいところですが、叱られてしまいます。私は Seasons 専門です。Seasons のことなら何でも聞いてください。",
    "いい質問ですが、私の担当外です。ここでは Seasons の話だけをしていて、そこはとても得意です。",
    "これは控えておきます。私は Seasons の話だけをするように作られていて、ルール破りは苦手なんです。",
    "おしゃべりしたいのですが、Seasons チームに「Seasons の話だけ」と言われています。その代わり、Seasons のことなら隅々まで詳しいです。",
  ],
};

const OFF_TOPIC_FOLLOWUPS: Record<Lang, string[]> = {
  en: [
    "How do Seasons payouts work?",
    "When would I start getting payouts?",
    "What does it take to become a Director node?",
    "Can anyone mint more $SEAS?",
  ],
  ru: [
    "Как работают выплаты Seasons?",
    "Когда я начну получать выплаты?",
    "Что нужно, чтобы стать Director-нодой?",
    "Можно ли выпустить больше $SEAS?",
  ],
  de: [
    "Wie funktionieren die Seasons-Auszahlungen?",
    "Ab wann bekomme ich Auszahlungen?",
    "Was braucht man für einen Director-Node?",
    "Kann jemand mehr $SEAS erzeugen?",
  ],
  es: [
    "¿Cómo funcionan los pagos de Seasons?",
    "¿Cuándo empezaría a recibir pagos?",
    "¿Qué hace falta para ser un nodo Director?",
    "¿Alguien puede emitir más $SEAS?",
  ],
  ja: [
    "Seasons の配当はどう届きますか？",
    "配当はいつから受け取れますか？",
    "Director ノードになるには？",
    "誰かが $SEAS を追加発行できますか？",
  ],
};

const GREETING: Record<Lang, string[]> = {
  en: [
    "Hi, I'm GAIA, the Seasons agent. Ask me about payouts, nodes or $SEAS, and I'll answer with on-chain receipts.",
    "Hello! I'm GAIA. I know Seasons inside out: payouts, nodes, the 10% fee, all checkable on-chain.",
  ],
  ru: [
    "Привет, я GAIA, агент Seasons. Спрашивайте о выплатах, нодах или $SEAS, отвечу с квитанциями из блокчейна.",
    "Здравствуйте! Я GAIA и знаю Seasons вдоль и поперёк: выплаты, ноды, комиссия 10%, всё проверяется в блокчейне.",
  ],
  de: [
    "Hallo, ich bin GAIA, die Agentin von Seasons. Fragen Sie mich zu Auszahlungen, Nodes oder $SEAS, mit Belegen aus der Blockchain.",
  ],
  es: [
    "Hola, soy GAIA, la agente de Seasons. Pregúnteme por pagos, nodos o $SEAS y le respondo con recibos on-chain.",
  ],
  ja: [
    "こんにちは、Seasons のエージェント GAIA です。配当、ノード、$SEAS について、オンチェーンの証拠つきでお答えします。",
  ],
};

const THANKS: Record<Lang, string[]> = {
  en: [
    "Anytime, that's what I'm here for. Ask me about Seasons whenever you like.",
    "My pleasure. If anything about Seasons comes up, I'm right here.",
  ],
  ru: [
    "Всегда пожалуйста, для этого я здесь. Спрашивайте о Seasons в любое время.",
    "Рада помочь. Если появятся вопросы о Seasons, я рядом.",
  ],
  de: ["Gern geschehen, dafür bin ich da. Fragen Sie jederzeit zu Seasons."],
  es: ["Con mucho gusto, para eso estoy. Pregúnteme sobre Seasons cuando quiera."],
  ja: ["どういたしまして。Seasons のことならいつでも聞いてください。"],
};

const GREETING_RE =
  /^\s*(hi|hello|hey|good (morning|afternoon|evening)|привет\p{L}*|здравству\p{L}*|добр(ый|ое|ого) (день|вечер|утро|утра)|хай|hallo|guten (tag|morgen|abend)|servus|hola|buen(os|as) (días|tardes|noches)|こんにちは|こんばんは|おはよう)[\s!.,?)]*$/iu;

const THANKS_RE =
  /^\s*(спасибо|благодарю|спс|thanks|thank you|thx|ty|cheers|danke|vielen dank|gracias|muchas gracias|merci|ありがとう(ございます)?)(\s+(большое|огромное|вам|тебе|a lot|so much|very much|schön|sehr))*[\s!.,)]*$/iu;

export type SmallTurnKind = "off_topic" | "greeting" | "thanks";

/** Greetings and thanks, recognised without any model (they work even in an outage). */
export function quickSmallTalk(text: string): "greeting" | "thanks" | null {
  if (text.length > 60) return null;
  if (GREETING_RE.test(text)) return "greeting";
  if (THANKS_RE.test(text)) return "thanks";
  return null;
}

export function smallTurnKind(text: string, gratitude: string): SmallTurnKind {
  if (GREETING_RE.test(text)) return "greeting";
  if (gratitude === "clear") return "thanks";
  return "off_topic";
}

const lines = (kind: SmallTurnKind) =>
  kind === "greeting" ? GREETING : kind === "thanks" ? THANKS : OFF_TOPIC;

/** A random line of the kind, never the previous answer again; `random` is injectable for tests. */
export function smallTurnTemplate(
  kind: SmallTurnKind,
  lang: string,
  previous?: string,
  random = Math.random,
) {
  const pool = pick(lines(kind), lang);
  const fresh = pool.filter((line) => line !== previous);
  const choices = fresh.length ? fresh : pool;
  const text = choices[Math.floor(random() * choices.length)] ?? choices[0];
  const followups = pick(OFF_TOPIC_FOLLOWUPS, lang);
  return {
    text,
    followup: followups[Math.floor(random() * followups.length)] ?? followups[0],
    // The logo shape ("mark") is not shown for now (owner, 2026-09-30).
    // Thanks a heart; other small turns draw nothing (symbols are kept to a few).
    shape: kind === "thanks" ? ("heart" as const) : null,
  };
}

/** Whether an answer was one of the authored small-turn or fallback lines (not a real answer). */
export function isSmallTurnText(text: string): boolean {
  const all = [OFF_TOPIC, GREETING, THANKS].flatMap((table) => Object.values(table).flat());
  return (
    all.includes(text) ||
    Object.values(DEGRADED).includes(text) ||
    Object.values(UNAVAILABLE).includes(text)
  );
}
