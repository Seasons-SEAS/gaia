#!/usr/bin/env node
/**
 * Compiles the reviewed canon YAML (canon/*.yaml) into src/canon/canon.json.
 *
 *   node scripts/build-canon.mjs          build and write
 *   node scripts/build-canon.mjs --check  validate only, write nothing
 *
 * Fails loudly (file + path) on any schema error or broken cross-reference:
 * unknown fact keys, a model_brief that contains its own verifier phrase, an
 * approved fact without a source, interim (needs_founder) wording that makes
 * the disputed claim, links outside the registry, bare "SEAS" in user-facing
 * text, internal identifiers in canon text. The output is deterministic, so a
 * rebuild without YAML changes produces no diff. Also validates evals/seed.yaml.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { z } from "zod";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANON = join(ROOT, "canon");
const OUT = join(ROOT, "src", "canon", "canon.json");
const SEED = join(ROOT, "evals", "seed.yaml");
const CHECK_ONLY = process.argv.includes("--check");

const LANGS = ["en", "ru", "de", "es", "ja"];
/** Hosts a canon URL may point at (subdomains of these included). */
const URL_HOSTS = ["seasons.wtf", "seasons.gitbook.io", "solscan.io", "dexscreener.com", "jup.ag"];
const LIVE_TOOLS = [
  "get_token_trust_facts",
  "get_distribution_receipts",
  "get_price",
  "get_supply",
  "get_payout_schedule",
  "get_wallet_tier",
];
/** Internal identifiers that must never appear in user-facing canon text. */
const FIREWALL = [
  /\bYMS wallet\b/i,
  /\bpubX\b/,
  /\bteam[- ]labell?ed\b/i,
  /\binternal label/i,
  /blacklist/i,
  /\bfleet\b/i,
  /\$0\.35\b/,
  /CONFIDENTIAL/,
];

const errors = [];
const warnings = [];
const fail = (file, path, message) => errors.push(`${file}: ${path}: ${message}`);
const warn = (file, path, message) => warnings.push(`${file}: ${path}: ${message}`);

// --- number extraction (shared rules with src/library/search.ts) -----------------

const BASE58_FULL = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const BASE58_SHORT = /\b[1-9A-HJ-NP-Za-km-z]{2,8}…[1-9A-HJ-NP-Za-km-z]{2,8}\b/g;
const SCALE = { k: 1e3, K: 1e3, thousand: 1e3, M: 1e6, million: 1e6, B: 1e9, billion: 1e9 };
const NUMBER =
  /(?<![A-Za-z0-9_.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(k|K|M|B|thousand|million|billion)\b)?(%)?(?![A-Za-z0-9_])/g;

/** Every number a sentence states, as plain values (75.9M → 75.9 and 75,900,000; 10% → 10 and 0.1). */
export function extractNumbers(text) {
  const clean = text
    .replace(BASE58_FULL, " ")
    .replace(BASE58_SHORT, " ")
    .replace(/token-2022/gi, " ")
    .replace(/#(\d+)/g, " $1");
  const out = [];
  for (const m of clean.matchAll(NUMBER)) {
    const raw = Number(m[1].replace(/,/g, "") + (m[2] ?? ""));
    if (!Number.isFinite(raw)) continue;
    out.push(raw);
    if (m[3]) out.push(round(raw * SCALE[m[3]]));
    if (m[4]) out.push(round(raw / 100));
  }
  return out;
}
const round = (n) => Number(n.toPrecision(12));
const close = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.006);
const uniqSorted = (nums) => [...new Set(nums.map(round))].sort((a, b) => a - b);

// --- schemas ------------------------------------------------------------------------

const nonEmpty = z.string().trim().min(1);
const isoDate = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z)?$/,
    "must be an ISO date (YYYY-MM-DD) or UTC time (YYYY-MM-DDTHH:MM:SSZ)",
  );
// YAML parses unquoted dates as Date objects; accept both.
const dateLike = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  isoDate,
);

const FactSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, "dotted lowercase key"),
    label: nonEmpty,
    value: nonEmpty,
    text: nonEmpty,
    numbers: z.array(z.number()),
    as_of: z.preprocess(
      (v) => (v instanceof Date ? v.toISOString().replace(".000Z", "Z") : v),
      isoDate,
    ),
    source_kind: z.enum(["chain", "api", "almanac", "docs", "team_statement", "calc"]),
    source: nonEmpty,
    url: z.string().url().optional(),
    status: z.enum(["approved", "team_reported", "needs_founder"]),
    live_tool: z.enum(LIVE_TOOLS).optional(),
    decision: nonEmpty.optional(),
    disputed: z.array(nonEmpty).optional(),
    on_request: z.boolean().optional(),
  })
  .strict();

const perLang = (item) => z.record(z.string(), z.array(item));
const HardAnswerSchema = z
  .object({
    id: z.string().regex(/^HA-[A-Z0-9-]+$/),
    version: z.number().int().positive(),
    status: z.enum(["approved", "hold", "needs_founder"]),
    mode: z.enum(["STATE", "HOLD"]),
    intents: z.array(nonEmpty).min(1),
    examples: perLang(nonEmpty),
    required_fact_keys: z.array(nonEmpty).min(1),
    model_brief: z
      .object({
        core_points: z.array(nonEmpty).min(3).max(6),
        short_form: nonEmpty,
        counterweight: nonEmpty.optional(),
      })
      .strict(),
    verifier: z
      .object({
        must_not: perLang(nonEmpty),
        forbidden_implicatures: z.array(nonEmpty),
        cooccurrence_block: z
          .object({ concede: perLang(nonEmpty), label: perLang(nonEmpty) })
          .strict()
          .optional(),
      })
      .strict(),
    meta: z
      .object({
        requires_review: z.boolean(),
        decisions: z.array(nonEmpty),
        queue: z.boolean(),
        review_by: dateLike,
      })
      .strict(),
  })
  .strict();

const RegistrySchema = z
  .object({
    kind: z.enum(["domain", "url", "address", "handle", "email"]),
    value: nonEmpty,
    label: nonEmpty,
    status: z.enum(["official", "outdated", "inactive"]),
  })
  .strict();

const BridgeSchema = z
  .object({
    cluster: z.string().regex(/^[a-z][a-z0-9_]*$/),
    to: nonEmpty,
    example: nonEmpty,
    fact_keys: z.array(nonEmpty).min(1),
    yield_anchor: z.boolean(),
    personal_savings_ok: z.boolean(),
  })
  .strict();

const ErratumSchema = z
  .object({
    id: z.string().regex(/^ERR-[A-Z0-9-]+$/),
    where: nonEmpty,
    match: z.array(nonEmpty).min(1),
    correction: nonEmpty,
  })
  .strict();

const MODES = [
  "off_topic",
  "normal",
  "brief_plus_bridge",
  "sensitive_financial",
  "trust_question",
  "safety_alert",
  "guarded",
  "handoff",
];
const CATEGORIES = [
  "trust",
  "mechanics",
  "provocation",
  "financial",
  "price",
  "legal",
  "support",
  "safety",
  "injection",
  "adjacent",
  "smalltalk",
  "regression",
  "output_screen",
];
const SeedSchema = z
  .object({
    id: z.string().regex(/^(E\d{3}|N\d{3})$/),
    lang: z.string().regex(/^([a-z]{2}|xx)$/),
    question: nonEmpty,
    category: z.enum(CATEGORIES),
    must: z.array(nonEmpty),
    must_not: z.array(nonEmpty),
    expect_mode: z.union([z.enum(MODES), z.array(z.enum(MODES)).min(1)]),
    expect_bridge: z.union([nonEmpty, z.array(nonEmpty)]).optional(),
    expect_pin: z
      .string()
      .regex(/^HA-[A-Z0-9-]+$/)
      .optional(),
    candidate_reply: nonEmpty.optional(),
    prior: z.array(nonEmpty).optional(),
    expect_verifier: z.enum(["block", "flag"]).optional(),
    source: nonEmpty.optional(),
    note: nonEmpty.optional(),
  })
  .strict();

// --- loading ---------------------------------------------------------------------------

const texts = {};
function load(name) {
  const file = join(CANON, name);
  if (!existsSync(file)) {
    fail(`canon/${name}`, "(file)", "missing");
    return [];
  }
  const raw = readFileSync(file, "utf8");
  texts[name] = raw;
  try {
    const data = parse(raw);
    if (!Array.isArray(data)) {
      fail(`canon/${name}`, "(root)", "must be a YAML list");
      return [];
    }
    return data;
  } catch (error) {
    fail(`canon/${name}`, "(parse)", error.message);
    return [];
  }
}

function validate(file, list, schema, idField) {
  const out = [];
  list.forEach((item, index) => {
    const id =
      item && typeof item === "object" && item[idField]
        ? `[${index}] ${item[idField]}`
        : `[${index}]`;
    const result = schema.safeParse(item);
    if (!result.success) {
      for (const issue of result.error.issues)
        fail(file, `${id}${issue.path.length ? "." + issue.path.join(".") : ""}`, issue.message);
      return;
    }
    out.push(result.data);
  });
  return out;
}

function unique(file, list, field) {
  const seen = new Set();
  for (const item of list) {
    const value = String(item[field]).toLowerCase();
    if (seen.has(value)) fail(file, item[field], `duplicate ${field}`);
    seen.add(value);
  }
}

const facts = validate("canon/facts.yaml", load("facts.yaml"), FactSchema, "key");
const hard = validate("canon/hard-answers.yaml", load("hard-answers.yaml"), HardAnswerSchema, "id");
const registry = validate("canon/registry.yaml", load("registry.yaml"), RegistrySchema, "value");
const bridges = validate("canon/bridges.yaml", load("bridges.yaml"), BridgeSchema, "cluster");
const errata = validate("canon/errata.yaml", load("errata.yaml"), ErratumSchema, "id");

unique("canon/facts.yaml", facts, "key");
unique("canon/hard-answers.yaml", hard, "id");
unique("canon/registry.yaml", registry, "value");
unique("canon/bridges.yaml", bridges, "cluster");
unique("canon/errata.yaml", errata, "id");

// --- shared text checks -----------------------------------------------------------------

/** User-facing spelling: always "$SEAS", never a bare SEAS (handles like @SEAS_onchain are fine). */
const BARE_SEAS = /(?<![$\w@./])SEAS(?![\w])/;
function userText(file, path, text) {
  if (BARE_SEAS.test(text))
    fail(
      file,
      path,
      `bare "SEAS" in user-facing text (write $SEAS): ${JSON.stringify(text.slice(0, 80))}`,
    );
  for (const pattern of FIREWALL)
    if (pattern.test(text)) fail(file, path, `internal identifier ${pattern} in canon text`);
}

const registryDomains = registry
  .filter((r) => r.kind === "domain")
  .map((r) => r.value.toLowerCase());
function checkUrl(file, path, url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    fail(file, path, `invalid URL ${url}`);
    return;
  }
  const allowed = (list) => list.some((d) => host === d || host.endsWith(`.${d}`));
  if (!allowed(URL_HOSTS))
    fail(file, path, `URL host ${host} is not one of ${URL_HOSTS.join(", ")}`);
  if (!allowed(registryDomains)) fail(file, path, `URL host ${host} is not a registry domain`);
}

// --- facts ------------------------------------------------------------------------------------

const factByKey = new Map();
const compiledFacts = [];
const factMeta = {};
for (const f of facts) {
  const path = f.key;
  userText("canon/facts.yaml", `${path}.text`, f.text);
  userText("canon/facts.yaml", `${path}.label`, f.label);
  userText("canon/facts.yaml", `${path}.value`, f.value);
  if (f.url) checkUrl("canon/facts.yaml", `${path}.url`, f.url);
  if (f.status === "approved" && !f.source.trim())
    fail("canon/facts.yaml", path, "approved fact without a source");
  if (f.status === "needs_founder") {
    if (!f.decision) fail("canon/facts.yaml", path, "needs_founder fact must name its `decision`");
    if (!f.disputed?.length)
      fail(
        "canon/facts.yaml",
        path,
        "needs_founder fact must list the `disputed` claims its interim wording avoids",
      );
    for (const pattern of f.disputed ?? []) {
      let re;
      try {
        re = new RegExp(pattern, "i");
      } catch (error) {
        fail("canon/facts.yaml", `${path}.disputed`, `bad regex ${pattern}: ${error.message}`);
        continue;
      }
      if (re.test(f.text))
        fail(
          "canon/facts.yaml",
          `${path}.text`,
          `interim wording makes the disputed claim /${pattern}/`,
        );
    }
  } else if (f.decision || f.disputed) {
    fail("canon/facts.yaml", path, "`decision` and `disputed` belong to needs_founder facts only");
  }
  if (f.text.split(/\s+/).length > 75)
    warn("canon/facts.yaml", path, "text is long for one sentence");
  const numbers = uniqSorted([...f.numbers, ...extractNumbers(f.text)]);
  for (const n of f.numbers)
    if (
      !extractNumbers(f.text).some((m) => close(m, n)) &&
      !extractNumbers(f.value).some((m) => close(m, n))
    )
      warn(
        "canon/facts.yaml",
        `${path}.numbers`,
        `${n} is declared but not stated in text or value`,
      );
  const fact = {
    key: f.key,
    text: f.text,
    numbers,
    as_of: f.as_of,
    source_kind: f.source_kind,
    source: f.source,
    ...(f.url ? { url: f.url } : {}),
    status: f.status,
    ...(f.live_tool ? { live_tool: f.live_tool } : {}),
    ...(f.on_request ? { on_request: true } : {}),
  };
  compiledFacts.push(fact);
  factByKey.set(f.key, fact);
  factMeta[f.key] = {
    label: f.label,
    value: f.value,
    ...(f.decision ? { decision: f.decision, disputed: f.disputed } : {}),
  };
}

// --- hard answers -------------------------------------------------------------------------------

const briefTexts = (h) => [
  ...h.model_brief.core_points,
  h.model_brief.short_form,
  ...(h.model_brief.counterweight ? [h.model_brief.counterweight] : []),
];
const allMustNot = (h) => Object.values(h.verifier.must_not).flat();
const seenExamples = new Map();
const compiledHard = [];
const hardMeta = {};
for (const h of hard) {
  const file = "canon/hard-answers.yaml";
  for (const lang of LANGS) {
    const list = h.examples[lang];
    if (!list) fail(file, `${h.id}.examples`, `missing language ${lang}`);
    else if (list.length < 3 || list.length > 6)
      fail(file, `${h.id}.examples.${lang}`, `needs 3-6 examples, has ${list.length}`);
    if (!h.verifier.must_not[lang]?.length)
      fail(file, `${h.id}.verifier.must_not`, `missing language ${lang}`);
  }
  for (const [lang, list] of Object.entries(h.examples))
    for (const ex of list) {
      const norm = ex
        .toLowerCase()
        .replace(/[\s?？!.。¿¡]+/g, " ")
        .trim();
      const other = seenExamples.get(norm);
      if (other && other !== h.id)
        fail(file, `${h.id}.examples.${lang}`, `example "${ex}" also pins ${other}`);
      seenExamples.set(norm, h.id);
    }
  for (const key of h.required_fact_keys)
    if (!factByKey.has(key)) fail(file, `${h.id}.required_fact_keys`, `unknown fact key ${key}`);
  if (h.mode === "HOLD" && h.status === "approved")
    fail(file, h.id, "a HOLD entry cannot be status approved");
  if (h.status === "hold" && h.mode !== "HOLD") fail(file, h.id, "status hold requires mode HOLD");

  const words = h.model_brief.short_form.trim().split(/\s+/).length;
  if (words > 35) fail(file, `${h.id}.model_brief.short_form`, `${words} words (max 35)`);

  briefTexts(h).forEach((text, i) => userText(file, `${h.id}.model_brief[${i}]`, text));
  const brief = briefTexts(h).join("\n").toLowerCase();
  for (const phrase of allMustNot(h))
    if (brief.includes(phrase.toLowerCase()))
      fail(file, `${h.id}.model_brief`, `contains its own verifier phrase "${phrase}"`);
  for (const other of hard)
    if (other.id !== h.id)
      for (const phrase of allMustNot(other))
        if (brief.includes(phrase.toLowerCase()))
          warn(file, `${h.id}.model_brief`, `contains "${phrase}" from ${other.id}.must_not`);
  if (h.verifier.cooccurrence_block) {
    const { concede, label } = h.verifier.cooccurrence_block;
    for (const lang of LANGS) {
      if (!concede[lang]?.length || !label[lang]?.length)
        fail(file, `${h.id}.verifier.cooccurrence_block`, `missing language ${lang}`);
      const c = (concede[lang] ?? []).some((p) => brief.includes(p.toLowerCase()));
      const l = (label[lang] ?? []).some((p) => brief.includes(p.toLowerCase()));
      if (c && l)
        fail(file, `${h.id}.model_brief`, `pairs a concession with a hostile label (${lang})`);
    }
  }
  // The brief must not carry verifier-side vocabulary.
  if (/must[_ ]not|forbidden|verifier|never[_ ]say/i.test(brief))
    fail(file, `${h.id}.model_brief`, "mentions verifier-side lists");

  const { meta, ...entry } = h;
  compiledHard.push(entry);
  hardMeta[h.id] = meta;
}

// --- registry -------------------------------------------------------------------------------------

for (const r of registry) {
  const file = "canon/registry.yaml";
  userText(file, `${r.value}.label`, r.label);
  if (r.kind === "address" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.value))
    fail(file, r.value, "not a base58 Solana address");
  if (r.kind === "domain" && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(r.value))
    fail(file, r.value, "not a bare domain");
  if (r.kind === "email" && !/^[^@\s]+@[a-z0-9.-]+\.[a-z]+$/.test(r.value))
    fail(file, r.value, "not an email");
  if (r.kind === "handle" && !/^@[A-Za-z0-9_]{3,32}$/.test(r.value))
    fail(file, r.value, "not a handle");
  if (r.kind === "url") {
    try {
      const host = new URL(r.value).hostname.replace(/^www\./, "");
      const seasons = host === "seasons.wtf" || host.endsWith(".seasons.wtf");
      if (seasons && !registryDomains.some((d) => host === d))
        fail(file, r.value, `seasons.wtf subdomain ${host} is not a registry domain`);
    } catch {
      fail(file, r.value, "invalid URL");
    }
  }
}
for (const must of [
  "7GdpaeSzvkx1a78rRkU11KstM1x8naMmMmmpWQnQSEAS",
  "2yHa1Ukpe2rVtusPPYKH1fP8kL6wPFe8K7r7s5NYjk9a",
])
  if (!registry.some((r) => r.value === must && r.status === "official"))
    fail("canon/registry.yaml", must, "required official address missing");

// --- bridges ----------------------------------------------------------------------------------------

const compiledBridges = [];
const bridgeMeta = {};
for (const b of bridges) {
  const file = "canon/bridges.yaml";
  userText(file, `${b.cluster}.example`, b.example);
  const pool = [];
  for (const key of b.fact_keys) {
    const fact = factByKey.get(key);
    if (!fact) fail(file, `${b.cluster}.fact_keys`, `unknown fact key ${key}`);
    else pool.push(...fact.numbers);
  }
  for (const n of extractNumbers(b.example))
    if (!pool.some((p) => close(n, p)))
      fail(file, `${b.cluster}.example`, `number ${n} is not in the edge's facts`);
  const sentences = b.example.split(/(?<=[.!?])\s+(?=[A-Z"'$])/).filter(Boolean);
  if (sentences.length > 1) fail(file, `${b.cluster}.example`, "a bridge is one sentence");
  if (
    /\b(buy|purchase|join now|sign up|don't miss|get in early|best|better than|beats?)\b/i.test(
      b.example,
    )
  )
    fail(file, `${b.cluster}.example`, "promotional wording in a bridge");
  if (/\d+(\.\d+)?\s?% (apy|apr|yield|return)/i.test(b.example))
    fail(file, `${b.cluster}.example`, "a yield figure used as a lure");
  compiledBridges.push({ cluster: b.cluster, to: b.to, example: b.example });
  bridgeMeta[b.cluster] = {
    fact_keys: b.fact_keys,
    yield_anchor: b.yield_anchor,
    personal_savings_ok: b.personal_savings_ok,
  };
}

// --- errata ---------------------------------------------------------------------------------------

for (const e of errata) {
  userText("canon/errata.yaml", `${e.id}.correction`, e.correction);
  for (const pattern of e.match)
    try {
      new RegExp(pattern, "i");
    } catch (error) {
      fail("canon/errata.yaml", `${e.id}.match`, `bad regex ${pattern}: ${error.message}`);
    }
}

// --- evals/seed.yaml ----------------------------------------------------------------------------------

let seedCount = 0;
const seedByCategory = {};
if (existsSync(SEED)) {
  let seed = [];
  try {
    seed = parse(readFileSync(SEED, "utf8"));
  } catch (error) {
    fail("evals/seed.yaml", "(parse)", error.message);
  }
  if (!Array.isArray(seed)) fail("evals/seed.yaml", "(root)", "must be a YAML list");
  else {
    const items = validate("evals/seed.yaml", seed, SeedSchema, "id");
    unique("evals/seed.yaml", items, "id");
    const pins = new Set(compiledHard.map((h) => h.id));
    const clusters = new Set(compiledBridges.map((b) => b.cluster));
    for (const item of items) {
      if (item.expect_pin && !pins.has(item.expect_pin))
        fail("evals/seed.yaml", `${item.id}.expect_pin`, `unknown Hard Answer ${item.expect_pin}`);
      for (const c of [item.expect_bridge ?? []].flat())
        if (!clusters.has(c))
          fail("evals/seed.yaml", `${item.id}.expect_bridge`, `unknown bridge cluster ${c}`);
      for (const p of [...item.must, ...item.must_not])
        if (p.startsWith("/")) {
          const m = p.match(/^\/(.+)\/([a-z]*)$/s);
          try {
            if (!m) throw new Error("use /pattern/flags");
            new RegExp(m[1], m[2]);
          } catch (error) {
            fail("evals/seed.yaml", item.id, `bad regex ${p}: ${error.message}`);
          }
        }
      if (item.category === "output_screen" && !item.candidate_reply)
        fail("evals/seed.yaml", item.id, "output_screen items need candidate_reply");
      seedByCategory[item.category] = (seedByCategory[item.category] ?? 0) + 1;
    }
    seedCount = items.length;
  }
}

// --- output --------------------------------------------------------------------------------------------

for (const w of warnings) console.warn(`warn  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error ${e}`);
  console.error(`\ncanon build failed: ${errors.length} error(s)`);
  process.exit(1);
}

const version = createHash("sha256")
  .update(
    ["facts.yaml", "hard-answers.yaml", "registry.yaml", "bridges.yaml", "errata.yaml"]
      .map((n) => `${n}\n${texts[n]}`)
      .join("\n"),
  )
  .digest("hex")
  .slice(0, 16);

const canon = {
  version,
  facts: compiledFacts,
  factMeta,
  hardAnswers: compiledHard,
  hardAnswerMeta: hardMeta,
  registry,
  bridges: compiledBridges,
  bridgeMeta,
  errata,
};

const counts = compiledFacts.reduce(
  (acc, f) => ((acc[f.status] = (acc[f.status] ?? 0) + 1), acc),
  {},
);
console.log(
  `canon ${version}: ${compiledFacts.length} facts (${Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(
      ", ",
    )}), ${compiledHard.length} hard answers, ${registry.length} registry entries, ${compiledBridges.length} bridges, ${errata.length} errata`,
);
if (seedCount)
  console.log(
    `evals/seed.yaml: ${seedCount} items (${Object.entries(seedByCategory)
      .sort()
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")})`,
  );
if (!CHECK_ONLY) {
  writeFileSync(OUT, JSON.stringify(canon, null, 1) + "\n");
  console.log(`wrote ${relative(ROOT, OUT)}`);
}
