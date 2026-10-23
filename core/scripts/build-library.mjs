#!/usr/bin/env node
/**
 * Builds the docs library: chunks the public GitBook export (llms-full.txt) by
 * page and heading into ~300-700-word chunks with status, risk flags and errata
 * ids, and writes src/library/chunks.json.
 *
 *   node scripts/build-library.mjs [--source <path to gitbook-llms-full.txt>]
 *
 * Only the public GitBook text is ingested. The design documents, research
 * notes and anything internal never enter the corpus: the source must be the
 * GitBook export and a corpus firewall rejects internal identifiers.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argSource = process.argv.indexOf("--source");
const SOURCE = resolve(
  argSource > -1
    ? process.argv[argSource + 1]
    : // The public GitBook export (https://seasons.gitbook.io/seasons-docs/llms-full.txt),
      // fetched 2026-09-28; refresh it there and rebuild.
      join(ROOT, "canon", "sources", "gitbook-llms-full.txt"),
);
const OUT = join(ROOT, "src", "library", "chunks.json");
const ERRATA = join(ROOT, "canon", "errata.yaml");
const DOCS = "https://seasons.gitbook.io/seasons-docs";
/** Date the GitBook export was fetched (research of 2026-09-28). */
const FETCHED = "2026-09-28";

const MIN_WORDS = 300;
const MAX_WORDS = 700;

if (basename(SOURCE) !== "gitbook-llms-full.txt") {
  console.error(`refusing to ingest ${SOURCE}: the library takes the public GitBook export only`);
  process.exit(1);
}

/**
 * The 42 GitBook pages in export order, with their public paths (verified
 * against seasons.gitbook.io/seasons-docs/sitemap-pages.xml on 2026-09-28) and
 * the documented status of what each page describes.
 */
const PAGES = [
  ["Welcome", "", "live"],
  ["Introduction", "intro/introduction", "live"],
  ["YMS", "protocol/yield-3.0-mechanism", "live"],
  ["Generation", "protocol/yield-3.0-mechanism/generation", "live"],
  ["TTT", "protocol/yield-3.0-mechanism/generation/ttt", "live"],
  ["SSYM", "protocol/yield-3.0-mechanism/generation/ssym", "planned"],
  ["YAV", "protocol/yield-3.0-mechanism/generation/yav", "planned"],
  ["Distribution", "protocol/yield-3.0-mechanism/distribution", "live"],
  ["Inclusion Sets", "protocol/yield-3.0-mechanism/distribution/inclusion-lists", "live"],
  [
    "Blue Chips (BC)",
    "protocol/yield-3.0-mechanism/distribution/inclusion-lists/blue-chips-bc",
    "live",
  ],
  [
    "Under Dogs (UD)",
    "protocol/yield-3.0-mechanism/distribution/inclusion-lists/under-dogs-ud",
    "live",
  ],
  [
    "Rising Stars (RS)",
    "protocol/yield-3.0-mechanism/distribution/inclusion-lists/rising-stars-rs",
    "live",
  ],
  [
    "Angelic Inclusions",
    "protocol/yield-3.0-mechanism/distribution/inclusion-lists/angelic-inclusions",
    "live",
  ],
  ["Nodes", "protocol/nodes", "live"],
  ["Director Nodes", "protocol/nodes/director-nodes", "live"],
  ["Builder Nodes", "protocol/nodes/builder-nodes", "live"],
  ["APY", "protocol/apy", "live"],
  ["$SEAS", "protocol/seas-token", "live"],
  ["Tokenomics", "protocol/seas-token/tokenomics", "live"],
  ["F.A.Q.s", "general/faqs", "live"],
  ["Roadmap", "general/roadmap", "planned"],
  ["2026", "general/roadmap/2-0-2-6", "planned"],
  ["Archives", "general/roadmap/roadmap", "historic"],
  ["Strategic Repository", "general/strategic-repository", "ideation"],
  ["Applying Yield 3.0", "general/introduction", "ideation"],
  ["DAO", "ecosystem/dao", "planned"],
  ["G.A.I.A.", "ecosystem/yield-3.0-mechanism", "live"],
  ["LPs", "ecosystem/lps", "live"],
  ["Ambassadors", "ecosystem/ambassadors", "live"],
  ["Socials", "resources/socials", "live"],
  ["Blogs", "resources/blogs", "live"],
  ["How-To's", "resources/how-tos", "live"],
  ["Create Solana Wallet", "resources/how-tos/create-solana-wallet", "live"],
  ["Fund Solana Wallet", "resources/how-tos/fund-solana-wallet", "live"],
  ["Swap tokens on DEX", "resources/how-tos/swap-tokens-on-dex", "live"],
  ["Getting $SEAS", "resources/how-tos/getting-usdseas", "live"],
  ["Bridge to Solana", "resources/how-tos/bridge-to-solana", "live"],
  ["Manage Yield", "resources/how-tos/manage-yield", "ideation"],
  ["Yield 101", "resources/yield-101", "live"],
  ["Vocabulary", "resources/yield-101/vocabulary", "live"],
  ["Inclusion Set Archives", "resources/inclusion-set-archives", "live"],
  ["High-Yield Savings Account", "resources/high-yield-savings-account", "ideation"],
];

/** Internal markers that must never be in the public corpus. */
const FIREWALL = [
  /CONFIDENTIAL/,
  /\bpubX\b/,
  /team[- ]labell?ed/i,
  /blacklisted-nodes/i,
  /gaia-2-concept/i,
  /founder queue/i,
];

// --- cleaning --------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

const isAsset = (url) =>
  /gitbook\.io\/~\/files|gitbook-x-prod|\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url);
const linkText = (text, url) => {
  const t = text.trim();
  if (url.startsWith("/seasons-docs") || url.startsWith("#")) return t;
  const u = url.replace(/[*\\>]+$/, "");
  if (!t || t === u || t.replace(/\/$/, "") === u.replace(/\/$/, "")) return u;
  return `${t} (${u})`;
};

function clean(raw) {
  let s = raw;
  // HTML anchors: drop image/asset links, keep text (+ external URL) for the rest.
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) =>
    isAsset(decode(url)) ? " " : ` ${linkText(text.replace(/<[^>]+>/g, ""), decode(url))} `,
  );
  s = s.replace(/<img[^>]*>/gi, " ").replace(/<figure[\s\S]*?<\/figure>/gi, " ");
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decode(s);
  // GitBook blocks and inline markdown.
  s = s.replace(/\{%[\s\S]*?%\}/g, " ");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, text, url) =>
    isAsset(url) ? " " : linkText(text.replace(/[*`]/g, ""), url),
  );
  // Escaped asterisks between terms are multiplication (velocity\*weight, APY\*0.8); other escapes are footnote marks.
  s = s.replace(/\\(?=\s|$)/gm, ""); // GitBook hard line breaks
  s = s.replace(/\*+\\\*\*+/g, " "); // a bold escaped asterisk is a list decoration
  s = s
    .replace(/(?<=[A-Za-z0-9)])\\\*(?=[A-Za-z0-9(])/g, "×")
    .replace(/(?<=\w) \\\* (?=\w)/g, " × ")
    .replace(/\\\*/g, "");
  s = s.replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "$1");
  s = s.replace(/\\([[\]()*_~`#>\-.!{}|+])/g, "$1").replace(/\\\s*$/gm, "");
  s = s.replace(/^[ \t]*\*[ \t]+/gm, "- ");
  s = s.replace(/[*`]+/g, ""); // markdown emphasis and code marks
  s = s.replace(/(?<![\w:]):[a-z][a-z0-9-]*:(?![\w])/g, " "); // icon shortcodes like :corn:
  s = s.replace(/\p{Extended_Pictographic}|️|⃣|‍/gu, "");
  const lines = s
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*>+\s?/, "")
        .replace(/^\s*[-+]\s+/, "- ")
        .replace(/\s*\|\s*(\|\s*)+/g, " | ")
        .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
        .replace(/[ \t\u00a0]+/g, " ")
        .trim(),
    )
    .filter(
      (line) =>
        line &&
        !/^[-|:\s]+$/.test(line) &&
        line !== "-" &&
        !/^(cover image\s*\|?\s*)+$/i.test(line),
    );
  return lines.join("\n");
}

const cleanHeading = (h) =>
  clean(h)
    .replace(/[\s|]+$/, "")
    .trim();

const words = (s) => (s.match(/\S+/g) ?? []).length;

// --- flags -------------------------------------------------------------------------

const negated = (text, index) =>
  /\b(not|no|never|nor|without)\b[^.]{0,20}$|n't[^.]{0,20}$/i.test(
    text.slice(Math.max(0, index - 30), index),
  );
const RISK = {
  promissory: [
    /always guaranteed/gi,
    /\bguarantee[sd]?\b/gi,
    /\bensur(?:e|es|ing) (?:a |the )?(?:steady|persistent|stable|consistent)(?:[\s,-]+[\w-]+){0,2}?[\s,-]+(?:growth|yield|returns?|output|flow|rates?)\b/gi,
    /\blower bound\b/gi,
    /\brisk[- ]free\b/gi,
    /\birrefutable claims?\b/gi,
    /\bboundless\b/gi,
    /\b(?:uncapped|unlimited) (?:apy|yield|returns?)\b/gi,
  ],
  superlative: [
    /\b(?:the )?best (?:yield|apy|returns?|rates? of return|investment|protocol)\b/gi,
    /\bhighest (?:yield|apy|returns?)\b/gi,
    /\bmost (?:profitable|advanced|resilient|sustainable)\b/gi,
    /\bfirst (?:and|\() ?only\b/gi,
    /\bunstoppable\b/gi,
    /\bworld[- ]class\b/gi,
    /\bde ?facto (?:web3|yield|standard)\b/gi,
    /\bexponential(?:ly)?\b/gi,
    /\boutperform\w*/gi,
  ],
  price_performance: [
    /\bprice appreciation\b/gi,
    /\bupwards? (?:price )?pressure\b/gi,
    /\b(?:constant )?positive pressure\b/gi,
    /\bbuy(?:ing)? pressure\b/gi,
    /\bpressure on value\b/gi,
    /(?<![\w.])\d+x\b(?!\s*(?:per|weekly|daily|a (?:week|day))\b)/gi,
    /\+\d+(?:\.\d+)?%/g,
    /\bprice (?:will|to) (?:rise|grow|increase)\b/gi,
  ],
};

function riskFlags(text) {
  const flags = [];
  for (const [flag, patterns] of Object.entries(RISK)) {
    const hit = patterns.some((re) => {
      re.lastIndex = 0;
      for (const m of text.matchAll(re))
        if (!(flag === "promissory" && negated(text, m.index))) return true;
      return false;
    });
    if (hit) flags.push(flag);
  }
  return flags;
}

function chunkStatus(pageStatus, text) {
  if (pageStatus !== "live") return pageStatus;
  if (/NOT YET (?:ACTIVE|OPERATIONAL)/i.test(text)) return "planned";
  const planned = (
    text.match(
      /\b(tentatively|planned|roadmap|will be (?:launched|introduced|released|implemented|explored)|in the following version|coming soon)\b/gi,
    ) ?? []
  ).length;
  if (planned >= 3) return "planned";
  const historic = (text.match(/\b((?:inclusion )?set #1|season 1|deactivated|retired)\b/gi) ?? [])
    .length;
  if (historic >= 2 && !/perfect order|set #2/i.test(text)) return "historic";
  return "live";
}

// --- read, split, chunk ---------------------------------------------------------------

const source = readFileSync(SOURCE, "utf8");
const errata = parse(readFileSync(ERRATA, "utf8")).map((e) => ({
  id: e.id,
  res: e.match.map((m) => new RegExp(m, "i")),
}));

const lines = source.split("\n");
const pageStarts = [];
lines.forEach((line, i) => {
  if (/^# \S/.test(line)) pageStarts.push(i);
});
if (pageStarts.length !== PAGES.length) {
  console.error(
    `expected ${PAGES.length} pages (lines starting with "# "), found ${pageStarts.length}`,
  );
  process.exit(1);
}

const chunks = [];
const pages = [];
pageStarts.forEach((start, p) => {
  const end = p + 1 < pageStarts.length ? pageStarts[p + 1] : lines.length;
  const [title, path, pageStatus] = PAGES[p];
  const heading = clean(lines[start].slice(2)).replace(/\s+/g, "");
  const expected = title.replace(/\s+/g, "");
  if (heading.toLowerCase() !== expected.toLowerCase()) {
    console.error(`page ${p} heading "${lines[start]}" does not match the page table ("${title}")`);
    process.exit(1);
  }
  const url = path ? `${DOCS}/${path}` : DOCS;
  // The line under a GitBook page title is its subtitle ("Seasons Official Liquidity Pools").
  const subtitle =
    lines
      .slice(start + 1, end)
      .map((l) => clean(l))
      .find((l) => l && !/^(\*|-)+$/.test(l)) ?? "";
  pages.push({
    title,
    path,
    url,
    status: pageStatus,
    subtitle: words(subtitle) <= 12 ? subtitle : "",
  });

  // Sections by ##..#### headings; the first section is the page intro.
  const sections = [];
  let current = { heading: null, body: [] };
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^(#{2,4})\s+(.*)$/);
    if (m) {
      sections.push(current);
      current = { heading: cleanHeading(m[2]), body: [] };
    } else current.body.push(lines[i]);
  }
  sections.push(current);

  const pieces = [];
  for (const s of sections) {
    const body = clean(s.body.join("\n"));
    const text = [s.heading, body].filter(Boolean).join("\n");
    if (!text.trim()) continue;
    if (words(text) <= MAX_WORDS) pieces.push({ heading: s.heading, text });
    else {
      // Split an oversized section at paragraph (line) boundaries.
      let buf = [];
      let n = 0;
      let first = true;
      for (const para of text.split("\n")) {
        const w = words(para);
        if (n + w > MAX_WORDS && n >= MIN_WORDS / 2) {
          pieces.push({
            heading: first ? s.heading : `${s.heading ?? title} (cont.)`,
            text: buf.join("\n"),
          });
          buf = [];
          n = 0;
          first = false;
        }
        buf.push(para);
        n += w;
      }
      if (buf.length)
        pieces.push({
          heading: first ? s.heading : `${s.heading ?? title} (cont.)`,
          text: buf.join("\n"),
        });
    }
  }

  // Merge small consecutive pieces up to the word budget.
  const merged = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (
      last &&
      (words(last.text) < MIN_WORDS || words(last.text) + words(piece.text) <= MIN_WORDS) &&
      words(last.text) + words(piece.text) <= MAX_WORDS
    ) {
      last.text += `\n${piece.text}`;
      last.headings.push(piece.heading);
    } else merged.push({ headings: [piece.heading], text: piece.text });
  }
  // A small tail joins the previous chunk when it fits.
  if (merged.length > 1) {
    const tail = merged[merged.length - 1];
    const prev = merged[merged.length - 2];
    if (
      words(tail.text) < MIN_WORDS / 2 &&
      words(prev.text) + words(tail.text) <= MAX_WORDS + MIN_WORDS / 2
    ) {
      prev.text += `\n${tail.text}`;
      prev.headings.push(...tail.headings);
      merged.pop();
    }
  }

  merged.forEach((m, i) => {
    const firstHeading = m.headings.find(Boolean);
    const chunkTitle = merged.length > 1 && firstHeading ? `${title} › ${firstHeading}` : title;
    const text = m.text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
    const lower = text.toLowerCase();
    chunks.push({
      id: `${path || "welcome"}#${i}`,
      page: title,
      title: chunkTitle,
      url,
      status: chunkStatus(pageStatus, text),
      risk_flags: riskFlags(text),
      errata_ids: errata
        .filter((e) => e.res.some((re) => re.test(lower) || re.test(text)))
        .map((e) => e.id),
      text,
    });
  });
});

// The site's own public pages (Terms, Privacy, Company/Team), extracted from the
// site's content modules by scripts/extract-site-pages.mts.
const SITE_PAGES = join(ROOT, "canon", "site-pages.json");
const site = existsSync(SITE_PAGES) ? JSON.parse(readFileSync(SITE_PAGES, "utf8")) : { pages: [] };
for (const page of site.pages) {
  const slug = page.url.replace(/^https:\/\/seasons\.wtf\//, "");
  pages.push({ title: page.title, path: slug, url: page.url, status: "live", subtitle: "" });
  const groups = [];
  for (const section of page.sections) {
    const last = groups.at(-1);
    const text = `${section.heading}\n${section.text}`;
    if (last && words(last.text) + words(text) <= MAX_WORDS) {
      last.text += `\n${text}`;
      last.headings.push(section.heading);
    } else groups.push({ text, headings: [section.heading] });
  }
  groups.forEach((g, i) => {
    const text = g.text
      .replace(/<[^>]+>/g, "")
      .replace(/\*\*/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
    const lower = text.toLowerCase();
    chunks.push({
      id: `site:${slug}#${i}`,
      page: page.title,
      title: groups.length > 1 ? `${page.title} › ${g.headings[0]}` : page.title,
      url: page.url,
      status: "live",
      risk_flags: riskFlags(text),
      errata_ids: errata
        .filter((e) => e.res.some((re) => re.test(lower) || re.test(text)))
        .map((e) => e.id),
      text,
    });
  });
}

for (const c of chunks)
  for (const re of FIREWALL)
    if (re.test(c.text)) {
      console.error(`corpus firewall: ${c.id} matches ${re}`);
      process.exit(1);
    }

const version = createHash("sha256")
  .update(source)
  .update(readFileSync(ERRATA, "utf8"))
  .update(existsSync(SITE_PAGES) ? readFileSync(SITE_PAGES, "utf8") : "")
  .update(readFileSync(fileURLToPath(import.meta.url), "utf8"))
  .digest("hex")
  .slice(0, 16);

const out = {
  version,
  source: `${DOCS} (llms-full.txt) + seasons.wtf legal and company pages`,
  fetched: FETCHED,
  pages,
  chunks,
};
const json = JSON.stringify(out);
writeFileSync(OUT, json + "\n");

const sizes = chunks.map((c) => words(c.text)).sort((a, b) => a - b);
const flagged = chunks.filter((c) => c.risk_flags.length).length;
const withErrata = chunks.filter((c) => c.errata_ids.length).length;
const byStatus = chunks.reduce((acc, c) => ((acc[c.status] = (acc[c.status] ?? 0) + 1), acc), {});
const usedErrata = new Set(chunks.flatMap((c) => c.errata_ids));
console.log(
  `library ${version}: ${chunks.length} chunks from ${pages.length} pages, ${(json.length / 1024).toFixed(1)} KB; words min ${sizes[0]} / median ${sizes[Math.floor(sizes.length / 2)]} / max ${sizes[sizes.length - 1]}`,
);
console.log(
  `status ${JSON.stringify(byStatus)}; risk-flagged ${flagged}; errata-tagged ${withErrata}`,
);
const unused = errata.map((e) => e.id).filter((id) => !usedErrata.has(id));
if (unused.length) console.log(`errata not found in the GitBook text: ${unused.join(", ")}`);
console.log(`wrote ${relative(ROOT, OUT)}`);
