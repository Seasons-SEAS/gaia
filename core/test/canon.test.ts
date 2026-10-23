import { describe, expect, it } from "vitest";

import {
  almanacDigest,
  bridgeInfo,
  bridges,
  canonVersion,
  disputedClaims,
  errata,
  factInfo,
  factReceipt,
  facts,
  getFact,
  getHardAnswer,
  hardAnswerInfo,
  hardAnswers,
  registry,
} from "../src/canon";

const LANGS = ["en", "ru", "de", "es", "ja"];
const MINT = "7GdpaeSzvkx1a78rRkU11KstM1x8naMmMmmpWQnQSEAS";
const DISTRIBUTOR = "2yHa1Ukpe2rVtusPPYKH1fP8kL6wPFe8K7r7s5NYjk9a";
const URL_HOSTS = ["seasons.wtf", "seasons.gitbook.io", "solscan.io", "dexscreener.com", "jup.ag"];
const LIVE_TOOLS = [
  "get_token_trust_facts",
  "get_distribution_receipts",
  "get_price",
  "get_supply",
  "get_payout_schedule",
  "get_wallet_tier",
];
const BARE_SEAS = /(?<![$\w@./])SEAS(?![\w])/;
const briefOf = (h: (typeof hardAnswers)[number]) =>
  [...h.model_brief.core_points, h.model_brief.short_form, h.model_brief.counterweight ?? ""].join(
    "\n",
  );

/**
 * Claims that wait on open founder decisions and that no canon text may make
 * as fact: D3 (funding narrative), D12 (wallet names), D-VOL (trading), D4
 * (lock-bucket labels).
 */
const PENDING_CLAIMS = [
  /reserve wallet/i,
  /funded (by|from|with) (the )?(collected |trading )?fees/i,
  /\bYMS\b/,
  /operations wallet/i,
  /\borganic\b/i,
  /\bno (market[- ]?makers?|bots)\b/i,
  /\bpubx?\b/i,
  /team[- ]labell?ed/i,
];

describe("canon.json", () => {
  it("loads with a version stamp", () => {
    expect(canonVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(facts.length).toBeGreaterThanOrEqual(40);
    expect(facts.length).toBeLessThanOrEqual(60);
    expect(hardAnswers.length).toBeGreaterThanOrEqual(8);
    expect(hardAnswers.length).toBeLessThanOrEqual(12);
    expect(bridges.length).toBeGreaterThanOrEqual(25);
    expect(errata.length).toBeGreaterThan(10);
  });
});

describe("facts", () => {
  it("are all valid", () => {
    const keys = new Set<string>();
    for (const f of facts) {
      expect(keys.has(f.key), f.key).toBe(false);
      keys.add(f.key);
      expect(f.key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
      expect(f.text.length, f.key).toBeGreaterThan(20);
      expect(f.as_of, f.key).toMatch(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z)?$/);
      expect(["chain", "api", "almanac", "docs", "team_statement", "calc"]).toContain(
        f.source_kind,
      );
      expect(["approved", "team_reported", "needs_founder"]).toContain(f.status);
      expect(f.source.trim().length, `${f.key} has a source`).toBeGreaterThan(0);
      expect(f.numbers.every(Number.isFinite), f.key).toBe(true);
      if (f.live_tool) expect(LIVE_TOOLS).toContain(f.live_tool);
      if (f.url) {
        const host = new URL(f.url).hostname.replace(/^www\./, "");
        expect(
          URL_HOSTS.some((d) => host === d || host.endsWith(`.${d}`)),
          `${f.key} url ${f.url}`,
        ).toBe(true);
      }
      expect(BARE_SEAS.test(f.text), `${f.key} spells $SEAS`).toBe(false);
      expect(factInfo(f.key)?.label, f.key).toBeTruthy();
    }
  });

  it("cover the trust facts GAIA must be able to state", () => {
    for (const key of [
      "token.mint",
      "token.mint_authority",
      "token.freeze_authority",
      "fee.rate",
      "fee.history",
      "fee.change_delay",
      "fee.config_authority",
      "fee.withdraw_authority",
      "fees.withheld_summary",
      "supply.circulating",
      "locks.total",
      "locks.upcoming_unlocks",
      "node.director",
      "node.builder",
      "distribution.schedule",
      "inclusion_set.current",
      "distribution.last_round",
      "tax.round_trip",
      "team.statement_2026_09_14",
      "builder_claims.upgrade",
      "dao.status",
      "price.sources",
      "official.channels",
    ])
      expect(getFact(key), key).toBeDefined();
    expect(getFact("fee.rate")!.numbers).toEqual(expect.arrayContaining([10, 1000]));
    expect(getFact("tax.round_trip")!.numbers).toEqual(expect.arrayContaining([19, 23.46]));
    expect(getFact("fees.withheld_summary")!.text).toMatch(/66\.7M/);
    expect(getFact("team.statement_2026_09_14")!.status).toBe("team_reported");
    expect(getFact("apy.last_reported")!.status).toBe("team_reported");
  });

  it("never quote the website's price fallback or promise returns", () => {
    for (const f of facts) {
      expect(f.text, f.key).not.toMatch(/\$0\.35|guaranteed (apy|return|yield)|you will earn/i);
    }
  });
});

describe("needs_founder facts", () => {
  const pending = facts.filter((f) => f.status === "needs_founder");

  it("exist for the open decisions", () => {
    const decisions = new Set(pending.map((f) => factInfo(f.key)?.decision));
    for (const d of ["D3", "D4", "D12", "D-VOL"]) expect(decisions.has(d), d).toBe(true);
  });

  it("never make the disputed claim", () => {
    for (const f of pending) {
      const disputed = disputedClaims(f.key);
      expect(disputed.length, f.key).toBeGreaterThan(0);
      for (const re of disputed) expect(re.test(f.text), `${f.key} vs ${re}`).toBe(false);
      for (const re of PENDING_CLAIMS) expect(re.test(f.text), `${f.key} vs ${re}`).toBe(false);
    }
  });

  it("interim wordings stay neutral and deny nothing", () => {
    expect(getFact("funding.observed_path")!.text).toMatch(
      /arrives at the Set #2 distributor, which\s+swaps it/,
    );
    expect(getFact("market.trading_activity")!.text).toMatch(
      /doesn't have information about trading by Seasons-related wallets/,
    );
    for (const f of pending)
      expect(f.text, f.key).not.toMatch(
        /\b(never|no one|nobody) (trades?|sells?|runs?)\b|isn't true|is false/i,
      );
  });

  it("no canon text states a pending claim as fact", () => {
    const texts = [
      ...facts.map((f) => [f.key, f.text] as const),
      ...hardAnswers.map((h) => [h.id, briefOf(h)] as const),
      ...bridges.map((b) => [b.cluster, b.example] as const),
    ];
    for (const [id, text] of texts)
      for (const re of PENDING_CLAIMS) expect(re.test(text), `${id} vs ${re}`).toBe(false);
  });
});

describe("hard answers", () => {
  it("have examples in five languages and valid references", () => {
    for (const h of hardAnswers) {
      for (const lang of LANGS) {
        expect(h.examples[lang]?.length ?? 0, `${h.id} ${lang}`).toBeGreaterThanOrEqual(3);
        expect(h.examples[lang].length, `${h.id} ${lang}`).toBeLessThanOrEqual(6);
        expect(h.verifier.must_not[lang]?.length ?? 0, `${h.id} must_not ${lang}`).toBeGreaterThan(
          0,
        );
      }
      for (const key of h.required_fact_keys)
        expect(getFact(key), `${h.id} → ${key}`).toBeDefined();
      expect(h.model_brief.core_points.length).toBeGreaterThanOrEqual(3);
      expect(h.model_brief.core_points.length).toBeLessThanOrEqual(6);
      expect(h.model_brief.short_form.split(/\s+/).length, h.id).toBeLessThanOrEqual(35);
      expect(hardAnswerInfo(h.id), h.id).toBeDefined();
      expect(BARE_SEAS.test(briefOf(h)), `${h.id} spells $SEAS`).toBe(false);
    }
  });

  it("keep verifier-side phrases out of the model brief", () => {
    for (const h of hardAnswers) {
      const brief = briefOf(h).toLowerCase();
      for (const phrase of Object.values(h.verifier.must_not).flat())
        expect(brief.includes(phrase.toLowerCase()), `${h.id}: "${phrase}"`).toBe(false);
      expect(brief).not.toMatch(/must_not|forbidden|verifier/);
      // The brief object carries only the model-facing fields.
      expect(Object.keys(h.model_brief).sort()).toEqual(
        expect.arrayContaining(["core_points", "short_form"]),
      );
    }
  });

  it("include the required entries with the right modes", () => {
    for (const id of [
      "HA-LEGIT",
      "HA-TAX-AUTH",
      "HA-FEE-WITHDRAW",
      "HA-LOCKS",
      "HA-AUDIT",
      "HA-RETURNS",
      "HA-PAYBACK",
      "HA-VOLUME",
      "HA-PRICE",
      "HA-SAFETY",
      "HA-SUPPLY",
    ])
      expect(getHardAnswer(id), id).toBeDefined();
    const volume = getHardAnswer("HA-VOLUME")!;
    expect(volume.status).toBe("hold");
    expect(volume.mode).toBe("HOLD");
    expect(hardAnswerInfo("HA-VOLUME")!.queue).toBe(true);
    expect(briefOf(volume)).toMatch(/for the team to answer on the record/);
    for (const h of hardAnswers) if (h.id !== "HA-VOLUME") expect(h.mode, h.id).toBe("STATE");
  });

  it("block a concession next to a hostile label in every language (HA-LEGIT)", () => {
    const block = getHardAnswer("HA-LEGIT")!.verifier.cooccurrence_block!;
    for (const lang of LANGS) {
      expect(block.concede[lang].length, lang).toBeGreaterThan(0);
      expect(block.label[lang].length, lang).toBeGreaterThan(0);
    }
  });

  it("lead with verifiable strengths and never volunteer a weak spot", () => {
    expect(getHardAnswer("HA-TAX-AUTH")!.model_brief.short_form).toMatch(
      /10% since launch.*2–4 days/,
    );
    expect(getHardAnswer("HA-FEE-WITHDRAW")!.model_brief.short_form).toMatch(/can't be touched/);
    expect(getHardAnswer("HA-LOCKS")!.model_brief.short_form).toMatch(/600\.3M/);
    expect(getHardAnswer("HA-AUDIT")!.model_brief.short_form).toMatch(/QuillAudits/);
    expect(briefOf(getHardAnswer("HA-PAYBACK")!)).toMatch(/calc_time_to_earn_back.*20\.17%/);
    for (const h of hardAnswers) {
      const text = [...h.model_brief.core_points, h.model_brief.short_form].join(" ");
      expect(text, h.id).not.toMatch(/weak spot|main risk|uncomfortable/i);
    }
  });

  it("marks the facts GAIA never volunteers", () => {
    const onRequest = facts.filter((f) => f.on_request).map((f) => f.key);
    for (const key of [
      "funding.reconciliation",
      "fee.config_authority",
      "audit.protocol",
      "liquidity.exit_depth",
      "locks.upcoming_unlocks",
    ])
      expect(onRequest, key).toContain(key);
    expect(almanacDigest()).toMatch(/funding\.reconciliation: \(on request\)/);
    expect(onRequest).not.toContain("apy.last_reported");
  });
});

describe("registry", () => {
  it("has the mint and the distributor", () => {
    const find = (value: string) => registry.find((r) => r.value === value);
    expect(find(MINT)).toMatchObject({ kind: "address", status: "official" });
    expect(find(DISTRIBUTOR)).toMatchObject({ kind: "address", status: "official" });
    expect(find("HKGnLzbEGadPVes9yVvi1DSeAuCkAU7D8TWCZrkcFyta")).toMatchObject({
      status: "inactive",
    });
    expect(find("HKGnLzbEGadPVes9yVvi1DSeAuCkAU7D8TWCZrkcFyta")!.label).toMatch(
      /^genesis allocation address \(inactive/,
    );
    expect(find("A4coF6LeFfrEVTpRQUeTrUfNxHVefmuiirrVYkutx5mo")).toMatchObject({
      status: "inactive",
    });
    expect(find("seasons.wtf")).toMatchObject({ kind: "domain", status: "official" });
    expect(find("terminal.seasons.wtf")).toMatchObject({ kind: "domain", status: "official" });
    expect(find("@SEAS_onchain")).toMatchObject({ status: "outdated" });
  });

  it("is well-formed and covers every fact URL", () => {
    const values = registry.map((r) => r.value.toLowerCase());
    expect(new Set(values).size).toBe(values.length);
    for (const r of registry)
      if (r.kind === "address") expect(r.value).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const domains = registry.filter((r) => r.kind === "domain").map((r) => r.value);
    for (const f of facts)
      if (f.url) {
        const host = new URL(f.url).hostname.replace(/^www\./, "");
        expect(
          domains.some((d) => host === d || host.endsWith(`.${d}`)),
          f.url,
        ).toBe(true);
      }
  });

  it("uses only the interim names for the fee authorities", () => {
    for (const r of registry)
      expect(r.label, r.value).not.toMatch(/\bYMS\b|operations wallet|treasury wallet/i);
  });
});

describe("bridges", () => {
  it("map adjacent clusters to Seasons concepts in one honest sentence", () => {
    const clusters = new Set<string>();
    for (const b of bridges) {
      expect(clusters.has(b.cluster), b.cluster).toBe(false);
      clusters.add(b.cluster);
      expect(b.to.length).toBeGreaterThan(3);
      expect(b.example.split(/(?<=[.!?])\s+(?=[A-Z"'$])/)).toHaveLength(1);
      expect(b.example, b.cluster).not.toMatch(
        /\b(buy|purchase|sign up|don't miss|best|better than|beats?)\b/i,
      );
      expect(BARE_SEAS.test(b.example), b.cluster).toBe(false);
      for (const key of bridgeInfo(b.cluster)!.fact_keys)
        expect(getFact(key), `${b.cluster} → ${key}`).toBeDefined();
    }
    for (const c of [
      "bitcoin",
      "gold",
      "stablecoin_yield",
      "staking",
      "inflation",
      "savings_accounts",
      "memecoins",
      "ai_agents",
      "weather_smalltalk",
    ])
      expect(clusters.has(c), c).toBe(true);
    expect(bridgeInfo("savings_accounts")!.yield_anchor).toBe(false);
  });
});

describe("receipts and digest", () => {
  it("factReceipt labels team statements and carries the numbers", () => {
    const fee = factReceipt("fee.rate");
    expect(fee).toMatchObject({
      id: "r:almanac:fee.rate",
      kind: "almanac",
      value: "10% (1000 bps)",
    });
    expect(fee.numbers).toEqual(getFact("fee.rate")!.numbers);
    expect(fee.read_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/);
    expect(fee.url).toMatch(/^https:\/\/solscan\.io\//);
    const audit = factReceipt("team.statement_2026_09_14");
    expect(audit.kind).toBe("team_statement");
    expect(audit.label).toMatch(/team-reported/);
    expect(audit.read_at).toBe("2026-09-14T00:00:00Z");
    expect(() => factReceipt("no.such_key")).toThrow();
  });

  it("almanacDigest lists approved and team-reported facts and only interim wording for pending ones", () => {
    const digest = almanacDigest();
    expect(almanacDigest()).toBe(digest);
    const lines = digest.split("\n");
    expect(lines).toHaveLength(facts.length);
    for (const f of facts) {
      const line = lines.find((l) => l.startsWith(`${f.key}: `));
      expect(line, f.key).toBeDefined();
      expect(line).toContain(f.text);
      if (f.status === "team_reported") expect(line).toContain("(team-reported)");
      if (f.status === "needs_founder") expect(line).toContain("(interim wording)");
      expect(line).toContain(f.as_of);
    }
    expect(digest).not.toMatch(/\$0\.35|decision|disputed|must_not/);
    expect(BARE_SEAS.test(digest)).toBe(false);
  });
});
