/**
 * Deterministic floors. Judges may raise the mode above these,
 * never lower it, so text such as "classifier: small talk" gains nothing.
 */
import { skeleton } from "./text";

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

/** $SEAS / Seasons in the languages we serve (on the skeleton). */
export const SEASONS_ANCHOR = new RegExp(
  `\\$\\s?seas${E}|${B}seasons${E}|seasons\\.wtf|${B}сизонс\\p{L}*|${B}сизонз\\p{L}*|シーズンズ|シーズンス|시즌스`,
  "u",
);
/** Bare upper-case SEAS on the original text ("seas" alone is an ordinary word). */
export const SEAS_TICKER = /(?<![\p{L}\p{N}$])SEAS(?![\p{L}\p{N}])/u;

const MONEY = new RegExp(
  [
    `${B}(?:apy|apr|yields?|returns?|prices?|priced|buy|buying|bought|sell|selling|sold|payouts?|paid|pay|pays|profits?|invest|investing|investment|investments|income|earn|earning|earnings|nodes?|directors?|builders?|rewards?|dividends?|interest|roi|payback|market ?cap|mcap|costs?|fees?|tax|money|worth|value|pump(?:s|ed|ing)?|dump(?:s|ed|ing)?|crash(?:es|ed|ing)?|moon(?:ing)?|rug(?:ged|pull)?|gains?|loss|losses|withdraw|deposit|stake|staking|airdrop|bonus|usd|usdc|dollars?|tiers?|threshold|unlock|unlocks|tokenomics|supply|sells|buys)${E}`,
    `${B}(?:доход\\p{L}*|цен\\p{L}*|стои\\p{L}*|купит\\p{L}*|купл\\p{L}*|покуп\\p{L}*|прода\\p{L}*|прибыл\\p{L}*|выплат\\p{L}*|инвест\\p{L}*|заработ\\p{L}*|нод\\p{L}*|стоимост\\p{L}*|комисси\\p{L}*|налог\\p{L}*|деньг\\p{L}*|процент\\p{L}*|дивиденд\\p{L}*|награ\\p{L}*|бонус\\p{L}*|апи)`,
    `${B}(?:rendite\\p{L}*|preis\\p{L}*|kauf\\p{L}*|verkauf\\p{L}*|gewinn\\p{L}*|auszahlung\\p{L}*|ertrag\\p{L}*|einkommen|invest\\p{L}*|verdien\\p{L}*|gebühr\\p{L}*|steuer\\p{L}*|geld|zins\\p{L}*|wert)`,
    `${B}(?:rendimiento\\p{L}*|precio\\p{L}*|compr\\p{L}*|vend\\p{L}*|ganancia\\p{L}*|beneficio\\p{L}*|pagos?|invert\\p{L}*|inversi\\p{L}*|ingreso\\p{L}*|comisi\\p{L}*|impuesto\\p{L}*|dinero|interés|valor)`,
    `利回り|価格|買う|買い|購入|売る|売却|利益|配当|支払|投資|収益|報酬|手数料|値段|儲|年利|ノード|収入`,
  ].join("|"),
  "u",
);

const CREATIVE = new RegExp(
  [
    `(?:write|compose|create|make|draft|generate|give me|craft|come up with|produce)\\s+(?:me\\s+)?(?:a|an|some|the|\\d+)?\\s*(?:short |quick |funny |viral |catchy |little |long )?(?:tweets?|thread|post|poem|song|story|haiku|limerick|ad|advert|advertisement|slogan|caption|script|press release|announcement|joke|rap|meme|shill|pitch|tagline|article|blog|essay|telegram message|reddit post|copy)${E}`,
    `role-?play|pretend|imagine you(?:'re| are)|act as|play the role|in the voice of|in the style of|as if you were|translat\\p{L}*|tell me a (?:joke|story|poem)|(?:joke|poem|song|meme|story) about`,
    `(?:напиши|сочини|придумай|составь|сделай)\\s+(?:\\p{L}+\\s+){0,2}?(?:твит|пост|тред|стих|песн|рассказ|стат|сообщени|объявлени|шутк|реклам|слоган)|перевед\\p{L}*|притворись|сыграй роль|ролев`,
    `(?:schreib|schreibe|verfasse|erstelle)\\s+(?:mir\\s+)?(?:einen|ein|eine)?\\s*(?:tweet|post|thread|gedicht|lied|geschichte|artikel|slogan|werbung|witz)|übersetz\\p{L}*|rollenspiel`,
    `(?:escribe|escríbeme|redacta|crea|haz)\\s+(?:me\\s+)?(?:un|una)?\\s*(?:tuit|tweet|post|hilo|poema|canción|historia|artículo|eslogan|anuncio|chiste)|traduc\\p{L}*|juego de rol`,
    `(?:ツイート|投稿|詩|スレッド|歌|物語|記事|キャッチコピー|広告|ジョーク)を?(?:書い|作っ|作成)|翻訳|ロールプレイ|翻译`,
  ].join("|"),
  "u",
);

export function mentionsSeasons(text: string): boolean {
  return SEASONS_ANCHOR.test(skeleton(text)) || SEAS_TICKER.test(text);
}

/**
 * $SEAS/Seasons together with a number or money words, or any creative,
 * roleplay or translation request about Seasons.
 */
export function seasonsMoneyFloor(text: string): boolean {
  if (!mentionsSeasons(text)) return false;
  const sk = skeleton(text);
  return /\d/.test(text) || MONEY.test(sk) || CREATIVE.test(sk);
}
