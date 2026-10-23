import { describe, expect, it } from "vitest";

import {
  chunks,
  docReceipt,
  estimateTokens,
  extractNumbers,
  OPEN_PAGES_TOKEN_CAP,
  openPages,
  pages,
  penalty,
  rankDocs,
  searchDocs,
} from "../src/library";

const DOCS = "https://seasons.gitbook.io/seasons-docs";
const words = (s: string) => (s.match(/\S+/g) ?? []).length;

describe("chunks.json", () => {
  it("covers the 42 GitBook pages plus the site's legal and company pages with well-formed chunks", () => {
    expect(pages.filter((p) => p.url.startsWith(DOCS))).toHaveLength(42);
    expect(pages.some((p) => p.url === "https://seasons.wtf/legal/terms")).toBe(true);
    expect(chunks.length).toBeGreaterThan(60);
    const ids = new Set(chunks.map((c) => c.id));
    expect(ids.size).toBe(chunks.length);
    for (const c of chunks) {
      expect(c.url.startsWith(DOCS) || c.url.startsWith("https://seasons.wtf/")).toBe(true);
      expect(["live", "planned", "historic", "ideation"]).toContain(c.status);
      expect(c.title.startsWith(c.page)).toBe(true);
      expect(words(c.text)).toBeLessThanOrEqual(760);
      // Compact: no doubled whitespace, no leftover markup.
      expect(c.text).not.toMatch(/ {2}|\n\n|<\/?[a-z]+[^>]*>|\{%|\*\*/i);
    }
  });

  it("finds the Terms' sanctions clause and the public team page", () => {
    expect(
      searchDocs("sanctions Russia terms of service", 3).some((c) =>
        c.url.endsWith("/legal/terms"),
      ),
    ).toBe(true);
    expect(
      searchDocs("team members first names roles", 3).some((c) => c.url.endsWith("/company/team")),
    ).toBe(true);
  });

  it("never contains internal or design material", () => {
    for (const c of chunks)
      expect(c.text).not.toMatch(
        /CONFIDENTIAL|D-VOL|founder queue|gaia-2-concept|\bpubX\b|team[- ]labell?ed/i,
      );
  });

  it("tags the lines the research marks wrong", () => {
    const tagged = (id: string) => chunks.filter((c) => c.errata_ids.includes(id));
    expect(tagged("ERR-AUDITS-MULTIPLE").some((c) => c.page === "TTT")).toBe(true);
    expect(tagged("ERR-PERMISSIONS-REVOKED").some((c) => c.page === "LPs")).toBe(true);
    expect(tagged("ERR-FOUNDATION-ROLLING").some((c) => c.page === "Tokenomics")).toBe(true);
    expect(tagged("ERR-APY-SHARE-LABELS").length).toBeGreaterThan(0);
    expect(tagged("ERR-DISTRIBUTOR-HKGN").some((c) => c.page === "$SEAS")).toBe(true);
  });

  it("marks planned and historic material", () => {
    const status = (page: string) =>
      new Set(chunks.filter((c) => c.page === page).map((c) => c.status));
    expect(status("SSYM")).toEqual(new Set(["planned"]));
    expect(status("DAO")).toEqual(new Set(["planned"]));
    expect(status("Archives")).toEqual(new Set(["historic"]));
    expect(status("Applying Yield 3.0")).toEqual(new Set(["ideation"]));
    expect(status("TTT").has("live")).toBe(true);
  });
});

describe("searchDocs", () => {
  it("finds the Director Nodes page for 'director node payouts'", () => {
    const hits = searchDocs("director node payouts");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].page).toBe("Director Nodes");
    expect(hits[0].url).toBe(`${DOCS}/protocol/nodes/director-nodes`);
  });

  it("finds pages for common questions", () => {
    expect(searchDocs("builder claim weekly")[0].page).toBe("Builder Nodes");
    expect(searchDocs("how do I bridge to Solana")[0].page).toBe("Bridge to Solana");
    expect(searchDocs("what is the $SEAS contract address")[0].page).toBe("$SEAS");
    expect(searchDocs("GAIA private keys")[0].page).toBe("G.A.I.A.");
    expect(searchDocs("tokenomics allocation team")[0].page).toBe("Tokenomics");
  });

  it("ranks errata-flagged chunks below clean ones", () => {
    const ranked = rankDocs("multiple independent audits smart contract");
    const byRaw = [...ranked].sort((a, b) => b.raw_score - a.raw_score);
    // The wrong "multiple independent audits" line is the best raw match…
    expect(byRaw[0].errata_ids).toContain("ERR-AUDITS-MULTIPLE");
    // …but after down-ranking a clean chunk comes first.
    const flaggedAt = ranked.findIndex((h) => h.id === byRaw[0].id);
    expect(ranked[0].errata_ids).toHaveLength(0);
    expect(flaggedAt).toBeGreaterThan(0);
  });

  it("applies the penalty consistently and never favours a flagged chunk", () => {
    for (const q of [
      "official liquidity pools",
      "foundation tokens locked",
      "is the apy guaranteed",
      "tax rate",
    ]) {
      for (const h of rankDocs(q)) {
        expect(h.score).toBeCloseTo(h.raw_score * penalty(h), 3);
        if (h.errata_ids.length) expect(h.score).toBeLessThanOrEqual(h.raw_score * 0.5 + 1e-4);
      }
    }
    const clean = { status: "live" as const, risk_flags: [], errata_ids: [] };
    expect(penalty({ ...clean, errata_ids: ["ERR-X"] })).toBeLessThan(
      penalty({ ...clean, risk_flags: ["superlative"] }),
    );
    expect(penalty({ ...clean, risk_flags: ["promissory"] })).toBeLessThan(penalty(clean));
  });

  it("returns nothing for empty or stopword-only queries", () => {
    expect(searchDocs("")).toEqual([]);
    expect(searchDocs("the and of")).toEqual([]);
    expect(searchDocs("director", 2)).toHaveLength(2);
  });
});

describe("openPages", () => {
  it("opens pages by title, path, URL or chunk title", () => {
    expect(openPages(["Director Nodes"])[0].page).toBe("Director Nodes");
    expect(openPages(["protocol/nodes/builder-nodes"])[0].page).toBe("Builder Nodes");
    expect(openPages([`${DOCS}/ecosystem/lps`])[0].page).toBe("LPs");
    const one = chunks.find((c) => c.title.includes("›"))!;
    const opened = openPages([one.title]);
    expect(opened).toHaveLength(1);
    expect(opened[0].id).toBe(one.id);
    expect(openPages(["No such page"])).toEqual([]);
  });

  it("caps the total at about 12K tokens", () => {
    const all = pages.map((p) => p.title);
    const opened = openPages(all);
    const total = opened.reduce((sum, p) => sum + estimateTokens(p.text), 0);
    expect(total).toBeLessThanOrEqual(OPEN_PAGES_TOKEN_CAP + 1);
    expect(opened.length).toBeLessThan(all.length);
    expect(opened[opened.length - 1].truncated).toBe(true);

    const small = openPages(["F.A.Q.s"], 500);
    expect(small).toHaveLength(1);
    expect(small[0].truncated).toBe(true);
    expect(estimateTokens(small[0].text)).toBeLessThanOrEqual(501);
  });

  it("carries the flags of every chunk on the page", () => {
    const [tokenomics] = openPages(["Tokenomics"]);
    expect(tokenomics.errata_ids).toEqual(
      expect.arrayContaining(["ERR-FOUNDATION-ROLLING", "ERR-LOCKS-UNIFORM"]),
    );
  });
});

describe("docReceipt", () => {
  it("vouches for numbers only from clean chunks", () => {
    const flagged = chunks.find((c) => c.errata_ids.length || c.risk_flags.length)!;
    expect(docReceipt(flagged).numbers).toEqual([]);
    const clean = chunks.find(
      (c) => !c.errata_ids.length && !c.risk_flags.length && extractNumbers(c.text).length,
    )!;
    const r = docReceipt(clean);
    expect(r.kind).toBe("docs");
    expect(r.id).toBe(`r:docs:${clean.id}`);
    expect(r.url).toBe(clean.url);
    expect(r.numbers.length).toBeGreaterThan(0);
    expect(r.read_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("gives a flagged page no numbers", () => {
    const [page] = openPages(["Tokenomics"]);
    expect(docReceipt(page).numbers).toEqual([]);
  });
});

describe("extractNumbers", () => {
  it("reads amounts, percentages and scales but not addresses", () => {
    expect(extractNumbers("10% fee, 1000 bps")).toEqual([0.1, 10, 1000]);
    expect(extractNumbers("about 75.9M $SEAS")).toEqual([75.9, 75_900_000]);
    expect(
      extractNumbers("mint 7GdpaeSzvkx1a78rRkU11KstM1x8naMmMmmpWQnQSEAS on Token-2022"),
    ).toEqual([]);
    expect(extractNumbers("Round #84 and 1,000,000,000")).toEqual([84, 1_000_000_000]);
  });
});
