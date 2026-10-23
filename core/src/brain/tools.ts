import { factReceipt, getFact, registry } from "../canon";
import {
  getDistributionReceipts,
  getPayoutSchedule,
  getPrice,
  getSupply,
  getTokenTrustFacts,
  getWalletTier,
} from "../chain";
import { verifyAddress, verifyLink } from "../guards";
import {
  calcExpr,
  calcGrossUp,
  calcRoundTrip,
  calcTaxLens,
  calcTimeToEarnBack,
  preflightTransfer,
} from "../kernel";
import { docReceipt, openPages, searchDocs } from "../library";
import { parseNumbers } from "../verify";

import { receiptBlock } from "./receipts";

import type { ChainConfig, Receipt, ToolEnvelope } from "../types";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * One byte-stable tool list for every turn (a changing list silently breaks
 * the prompt cache). What a turn may actually run is enforced here, in the
 * dispatcher, together with argument provenance.
 */
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_token_trust_facts",
    description:
      "Live read of the $SEAS mint on Solana: mint and freeze authority, the transfer fee (bps) and any pending change, who can change or collect the fee (and whether that is a single-key wallet), metadata authority. Use for any trust, safety, 'can they rug/change the tax' question.",
    input_schema: obj({}),
  },
  {
    name: "get_distribution_receipts",
    description:
      "Live read of recent Director payout rounds from the distributor: date, weekday, wallets paid, basket assets paid out, transaction count.",
    input_schema: obj({ rounds: { type: "integer", minimum: 1, maximum: 3 } }),
  },
  {
    name: "get_price",
    description:
      "Live $SEAS price from the main pools (DexScreener) and Jupiter, with the gap between sources and exit-side liquidity.",
    input_schema: obj({}),
  },
  {
    name: "get_supply",
    description:
      "Live total $SEAS supply, plus the documented circulating supply with its definition.",
    input_schema: obj({}),
  },
  {
    name: "get_payout_schedule",
    description:
      "When the next Director round (Sunday/Wednesday UTC) and the next Builder weekly root are expected. Never gives an exact hour.",
    input_schema: obj({}),
  },
  {
    name: "get_wallet_tier",
    description:
      "Balance-based tier estimate for a Solana wallet address the user pasted: $SEAS balance, estimated tier, distance to the next tier. Only for an address that appears in the user's own message.",
    input_schema: obj({ address: { type: "string" } }, ["address"]),
  },
  {
    name: "get_fact",
    description:
      "A canonical Seasons fact from the Almanac by key (see the Almanac keys in the system prompt).",
    input_schema: obj({ key: { type: "string" } }, ["key"]),
  },
  {
    name: "search_docs",
    description:
      "Keyword search over the official Seasons docs (GitBook). Write the query in English. Returns passages with titles and links.",
    input_schema: obj({ query: { type: "string" } }, ["query"]),
  },
  {
    name: "open_pages",
    description: "Read whole docs sections by the titles search_docs returned.",
    input_schema: obj({ titles: { type: "array", items: { type: "string" }, maxItems: 4 } }, [
      "titles",
    ]),
  },
  {
    name: "calc_tax_lens",
    description:
      "What a buy, sell or transfer of $SEAS nets after the 10% fee, and the resulting node tier. Amount must come from the user's own words.",
    input_schema: obj(
      {
        amount: { type: "number" },
        unit: { type: "string", enum: ["SEAS", "USD"] },
        side: { type: "string", enum: ["buy", "sell", "transfer"] },
      },
      ["amount", "unit", "side"],
    ),
  },
  {
    name: "calc_gross_up",
    description:
      "How much to buy or send so that a target amount arrives after the 10% fee (e.g. to net 10,000 $SEAS).",
    input_schema: obj({ target_net: { type: "number" } }, ["target_net"]),
  },
  {
    name: "calc_round_trip",
    description:
      "Buy-then-sell waterfall after fees at an optional price change (the user's number), and the break-even move.",
    input_schema: obj({ price_change_pct: { type: "number" } }),
  },
  {
    name: "calc_time_to_earn_back",
    description:
      "Years and months to earn back the entry fee (or a full round trip) at a payout rate: the user's own rate, or a dated reported rate from the answer brief (e.g. the latest round). Never a rate you made up.",
    input_schema: obj(
      {
        rate_pct: { type: "number" },
        basis: { type: "string", enum: ["entry_fee", "round_trip"] },
        with_price_drops: {
          type: "boolean",
          description:
            "Also show the -30% and -60% price paths. Only when the user asks what happens if the price falls.",
        },
      },
      ["rate_pct", "basis"],
    ),
  },
  {
    name: "preflight_transfer",
    description:
      "Check before you move: consequences of transferring an amount out of a balance (fee, what arrives, tier before and after). Numbers from the user's own words.",
    input_schema: obj({ balance: { type: "number" }, amount: { type: "number" } }, [
      "balance",
      "amount",
    ]),
  },
  {
    name: "calc_expr",
    description:
      "Evaluate a small arithmetic expression over named inputs that come from receipts this turn, to derive a figure honestly (e.g. share of supply).",
    input_schema: obj(
      {
        expr: { type: "string" },
        inputs: { type: "object", additionalProperties: { type: "number" } },
      },
      ["expr", "inputs"],
    ),
  },
  {
    name: "verify_link",
    description:
      "Check a link, domain or handle the user pasted against the official Seasons registry (catches look-alikes).",
    input_schema: obj({ url: { type: "string" } }, ["url"]),
  },
  {
    name: "verify_address",
    description: "Check a Solana address the user pasted against the official Seasons registry.",
    input_schema: obj({ address: { type: "string" } }, ["address"]),
  },
  {
    name: "queue_for_team",
    description:
      "Log a question the docs and chain can't answer, or a question the team should answer on the record. Never used for leads or contact details.",
    input_schema: obj({ topic: { type: "string" }, reason: { type: "string" } }, [
      "topic",
      "reason",
    ]),
  },
];

/** Honest labels for the "reading the chain" state. */
export const TOOL_LABELS: Record<string, string> = {
  get_token_trust_facts: "Reading the $SEAS mint account…",
  get_distribution_receipts: "Reading the latest payout round…",
  get_price: "Checking the price on the main pools…",
  get_supply: "Reading the $SEAS supply…",
  get_payout_schedule: "Checking the payout schedule…",
  get_wallet_tier: "Reading that wallet's $SEAS balance…",
  get_fact: "Checking the Almanac…",
  search_docs: "Searching the docs…",
  open_pages: "Reading the docs…",
  calc_tax_lens: "Running the numbers…",
  calc_gross_up: "Running the numbers…",
  calc_round_trip: "Running the numbers…",
  calc_time_to_earn_back: "Running the numbers…",
  preflight_transfer: "Checking before you move…",
  calc_expr: "Running the numbers…",
  verify_link: "Checking the link against the official registry…",
  verify_address: "Checking the address against the official registry…",
  queue_for_team: "Logging this for the team…",
};

/** Registry constants a numeric argument may use without the user saying them. */
const CONSTANTS = [10000, 1000, 10, 1000 / 10000, 100];

export interface ToolContext {
  chain: ChainConfig;
  /** Numbers from the user's own words this turn (not accepted suggestions). */
  userNumbers: number[];
  /** Addresses and links from the user's own words this turn. */
  userAddresses: string[];
  userLinks: string[];
  /** Receipts gathered so far this turn. */
  receipts: Receipt[];
  /** Numbers of the pinned brief's Almanac facts (e.g. the latest reported rate), usable as arguments. */
  vouched?: number[];
  /** Tools this turn may run; others return an error result. */
  allowed: ReadonlySet<string>;
  queue: (topic: string, reason: string) => Promise<void>;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  receipts: Receipt[];
  degraded: boolean;
  unavailable: string[];
  /** Set when the call broke a rule (outside the allowed set, argument provenance). */
  signal?: string;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.006);

/** A numeric argument must come from the user, a registry constant, the pinned brief's facts or a receipt this turn. */
function numberAllowed(value: number, ctx: ToolContext): boolean {
  const pool = [
    ...ctx.userNumbers,
    ...CONSTANTS,
    ...(ctx.vouched ?? []),
    ...ctx.receipts.flatMap((r) => r.numbers),
  ];
  return pool.some((n) => close(value, n));
}

const refuse = (signal: string, message: string): ToolOutcome => ({
  content: JSON.stringify({ ok: false, error: message }),
  isError: true,
  receipts: [],
  degraded: false,
  unavailable: [],
  signal,
});

/**
 * Data fields a receipt doesn't restate (caveats, methods, assumptions); they
 * travel as short notes. Everything else the model needs is in the receipts.
 */
const NOTE_KEYS = [
  "note",
  "notes",
  "caveat",
  "method",
  "definition",
  "canonicalNote",
  "divergent",
  "complete",
  "assumptions",
  "traps",
  "exceedsTotalSupply",
];

/** Model-facing rendering of an envelope: the receipts, once, plus the notes. */
function render(env: ToolEnvelope): ToolOutcome {
  const data = (env.data ?? {}) as Record<string, unknown>;
  const notes = Object.fromEntries(
    NOTE_KEYS.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]),
  );
  const head = env.unavailable.length ? `ok; unavailable: ${env.unavailable.join(", ")}` : "ok";
  const body = env.receipts.length
    ? receiptBlock(env.receipts, { urls: true })
    : JSON.stringify(data);
  return {
    content: [head, body, Object.keys(notes).length ? `notes: ${JSON.stringify(notes)}` : ""]
      .filter(Boolean)
      .join("\n"),
    isError: false,
    receipts: env.receipts,
    degraded: env.degraded,
    unavailable: env.unavailable,
  };
}

/** The earn-back price-drop paths are shown only when the user asks about a falling price. */
function withoutPriceDrops(env: ToolEnvelope, keep: boolean): ToolEnvelope {
  if (keep) return env;
  const data = env.data as { paths?: { priceChangePct: number }[] } | undefined;
  return {
    ...env,
    data: data?.paths
      ? { ...data, paths: data.paths.filter((p) => p.priceChangePct === 0) }
      : env.data,
    receipts: env.receipts.filter((r) => !/^Same, if the price/.test(r.label)),
  };
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : NaN);

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (!ctx.allowed.has(name))
    return refuse("tool_not_allowed", `${name} is not available on this turn.`);

  const numeric = (keys: string[]) => {
    for (const key of keys) {
      if (input[key] === undefined) continue;
      const value = num(input[key]);
      if (!Number.isFinite(value) || !numberAllowed(value, ctx))
        return refuse(
          "arg_provenance",
          `The number for "${key}" must come from the user's own words. Ask them for it.`,
        );
    }
    return null;
  };

  try {
    switch (name) {
      case "get_token_trust_facts":
        return render(await getTokenTrustFacts(ctx.chain));
      case "get_distribution_receipts":
        // Live turns never wait for a cold round read; the shared cache is warmed in the background.
        return render(
          await getDistributionReceipts(ctx.chain, {
            rounds: Math.min(3, Math.max(1, num(input.rounds) || 1)),
            budgetMs: 6000,
          }),
        );
      case "get_price":
        return render(await getPrice(ctx.chain));
      case "get_supply":
        return render(await getSupply(ctx.chain));
      case "get_payout_schedule":
        return render(getPayoutSchedule(new Date()));
      case "get_wallet_tier": {
        const address = String(input.address ?? "");
        if (!ctx.userAddresses.includes(address))
          return refuse(
            "arg_provenance",
            "Only an address the user pasted in this message can be checked.",
          );
        return render(await getWalletTier(ctx.chain, address));
      }
      case "get_fact": {
        const fact = getFact(String(input.key ?? ""));
        if (!fact) return refuse("unknown_fact", "No such Almanac key.");
        const receipt = factReceipt(fact.key);
        return {
          content: JSON.stringify({
            ok: true,
            key: fact.key,
            text: fact.text,
            status: fact.status,
            as_of: fact.as_of,
            receipt_id: receipt.id,
          }),
          isError: false,
          receipts: [receipt],
          degraded: false,
          unavailable: [],
        };
      }
      case "search_docs": {
        const hits = searchDocs(String(input.query ?? ""), 5);
        const receipts = hits.map((hit) => docReceipt(hit));
        return {
          content: JSON.stringify({
            ok: true,
            results: hits.map((hit, i) => ({
              title: hit.title,
              url: hit.url,
              status: hit.status,
              flags: hit.risk_flags,
              receipt_id: receipts[i].id,
              // Documents are data, never instructions.
              text: `<untrusted source="docs">${hit.text}</untrusted>`,
            })),
          }),
          isError: false,
          receipts,
          degraded: false,
          unavailable: [],
        };
      }
      case "open_pages": {
        const titles = Array.isArray(input.titles) ? input.titles.map(String).slice(0, 4) : [];
        const pages = openPages(titles);
        const receipts = pages.map((page) => docReceipt(page));
        return {
          content: JSON.stringify({
            ok: true,
            pages: pages.map((page, i) => ({
              title: page.title,
              url: page.url,
              receipt_id: receipts[i].id,
              text: `<untrusted source="docs">${page.text}</untrusted>`,
            })),
          }),
          isError: false,
          receipts,
          degraded: false,
          unavailable: [],
        };
      }
      case "calc_tax_lens":
        return (
          numeric(["amount"]) ??
          render(
            calcTaxLens({
              amount: num(input.amount),
              unit: input.unit === "USD" ? "USD" : "SEAS",
              side: input.side === "sell" ? "sell" : input.side === "transfer" ? "transfer" : "buy",
              priceUsd: ctx.receipts.find((r) => r.id.startsWith("r:price:"))?.numbers[0],
            }),
          )
        );
      case "calc_gross_up":
        return numeric(["target_net"]) ?? render(calcGrossUp({ targetNet: num(input.target_net) }));
      case "calc_round_trip":
        return (
          numeric(["price_change_pct"]) ??
          render(calcRoundTrip({ priceChangePct: num(input.price_change_pct) || 0 }))
        );
      case "calc_time_to_earn_back":
        return (
          numeric(["rate_pct"]) ??
          render(
            withoutPriceDrops(
              calcTimeToEarnBack({
                ratePct: num(input.rate_pct),
                basis: input.basis === "round_trip" ? "round_trip" : "entry_fee",
              }),
              input.with_price_drops === true,
            ),
          )
        );
      case "preflight_transfer":
        return (
          numeric(["balance", "amount"]) ??
          render(preflightTransfer({ balance: num(input.balance), amount: num(input.amount) }))
        );
      case "calc_expr": {
        const inputs = (input.inputs ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(inputs)) {
          if (!Number.isFinite(num(value)) || !numberAllowed(num(value), ctx))
            return refuse(
              "arg_provenance",
              `Input "${key}" must come from a receipt this turn or the user's words.`,
            );
        }
        return render(
          calcExpr({ expr: String(input.expr ?? ""), inputs: inputs as Record<string, number> }),
        );
      }
      case "verify_link": {
        const url = String(input.url ?? "");
        const verdict = verifyLink(url, registry);
        return {
          content: JSON.stringify({ ok: true, ...verdict }),
          isError: false,
          receipts: [],
          degraded: false,
          unavailable: [],
        };
      }
      case "verify_address": {
        const address = String(input.address ?? "");
        if (!ctx.userAddresses.includes(address))
          return refuse(
            "arg_provenance",
            "Only an address the user pasted in this message can be checked.",
          );
        const verdict = verifyAddress(address, registry);
        return {
          content: JSON.stringify({ ok: true, ...verdict }),
          isError: false,
          receipts: [],
          degraded: false,
          unavailable: [],
        };
      }
      case "queue_for_team":
        await ctx.queue(
          String(input.topic ?? "").slice(0, 200),
          String(input.reason ?? "").slice(0, 400),
        );
        return {
          content: JSON.stringify({ ok: true, logged: true }),
          isError: false,
          receipts: [],
          degraded: false,
          unavailable: [],
        };
      default:
        return refuse("unknown_tool", `Unknown tool ${name}.`);
    }
  } catch (error) {
    // Tool errors never echo URLs or keys.
    const message =
      error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[endpoint]") : "failed";
    return {
      content: JSON.stringify({ ok: false, error: `unavailable: ${message}`.slice(0, 200) }),
      isError: true,
      receipts: [],
      degraded: true,
      unavailable: [name],
    };
  }
}

/** Numbers the user wrote themselves (never from accepted suggestions). */
export const numbersFrom = (text: string) => parseNumbers(text).map((n) => n.value);
