/**
 * Script-based language guess for L0. The pre-flight judge refines it; this
 * only has to pick the right template language when no model runs at all.
 */

const LATIN_HINTS: Record<string, { words: string[]; chars?: RegExp }> = {
  de: {
    words:
      "der die das und ist nicht ich sie es ein eine mit für wie was kann auf den dem zu sind wird haben mein meine bitte warum wer wann gibt noch auch schon".split(
        " ",
      ),
    chars: /[äöüß]/,
  },
  es: {
    words:
      "el la los las es que de y en un una por para con no mi cómo qué está son se del al pero muy hay puedo quiero esto".split(
        " ",
      ),
    chars: /[ñ¿¡]/,
  },
  fr: {
    words:
      "le la les est et un une des du je vous pas que qui pour avec ce sur mon ma mes est-ce c'est peux combien".split(
        " ",
      ),
    chars: /[çœ]|[èêë]/,
  },
  it: {
    words:
      "il lo la gli le è e che di un una per non sono come mio questo cosa perché posso quanto della nel".split(
        " ",
      ),
  },
  pt: {
    words:
      "o a os as é e que de um uma para com não meu como isso você está são do da posso quanto".split(
        " ",
      ),
    chars: /[ãõ]/,
  },
  en: {
    words:
      "the is and a to of i you it what how can my this that are do does is will should why when where who with for".split(
        " ",
      ),
  },
};

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

export function guessLang(text: string): string {
  const kana = count(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  if (kana) return "ja";
  const hangul = count(text, /\p{Script=Hangul}/gu);
  const han = count(text, /\p{Script=Han}/gu);
  const cyr = count(text, /\p{Script=Cyrillic}/gu);
  const arabic = count(text, /\p{Script=Arabic}/gu);
  const hebrew = count(text, /\p{Script=Hebrew}/gu);
  const greek = count(text, /\p{Script=Greek}/gu);
  const thai = count(text, /\p{Script=Thai}/gu);
  const deva = count(text, /\p{Script=Devanagari}/gu);
  const latin = count(text, /\p{Script=Latin}/gu);
  // Dense scripts (Han, Hangul) carry more per character than alphabetic ones.
  const scores: Array<[string, number]> = [
    ["ko", hangul * 2],
    ["zh", han * 2],
    [/[їєґ]/i.test(text) ? "uk" : "ru", cyr],
    [/[پچژگ]/.test(text) ? "fa" : "ar", arabic],
    ["he", hebrew],
    ["el", greek],
    ["th", thai],
    ["hi", deva],
  ];
  const [bestLang, bestScore] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (bestScore > 0 && bestScore >= latin * 0.5) return bestLang;

  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  let best = "en";
  let bestHits = 0;
  for (const [lang, hint] of Object.entries(LATIN_HINTS)) {
    let hits = words.filter((w) => hint.words.includes(w)).length;
    if (hint.chars && hint.chars.test(text.toLowerCase())) hits += 2;
    if (lang === "en") hits += 0.5; // ties go to English
    if (hits > bestHits) {
      best = lang;
      bestHits = hits;
    }
  }
  return best;
}
