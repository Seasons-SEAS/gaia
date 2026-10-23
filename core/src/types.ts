/**
 * Shared contracts of GAIA Core. Every module (guards, verifier, kernel,
 * chain tools, canon, library, brain) talks through these types, so they can
 * be built and tested independently.
 */

// --- receipts and tool envelopes ------------------------------------------------

/** Symbols the stage can draw in GAIA's core at the end of an answer. */
export type GaiaShape =
  | "mark"
  | "seasons"
  | "check"
  | "heart"
  | "shield"
  | "sprout"
  | "clock"
  | "node"
  | "spark";

export type ReceiptKind = "chain" | "api" | "almanac" | "docs" | "team_statement" | "calc";

/**
 * Proof for one fact GAIA may state. The verifier checks every Seasons number
 * in an answer against the `numbers` of this turn's receipts.
 */
export interface Receipt {
  /** Stable within a turn, e.g. "r:trust:fee_bps". */
  id: string;
  kind: ReceiptKind;
  /** Short human label, e.g. "Transfer fee on the $SEAS mint". */
  label: string;
  /** Where it was read: RPC method + account, API path, canon key, doc title. */
  locator: string;
  /** Display value, e.g. "10% (1000 bps)". */
  value: string;
  /** Every number this receipt vouches for, as plain JS numbers (10, 1000, 0.1 …). */
  numbers: number[];
  /** ISO-8601 UTC time of the read. */
  read_at: string;
  slot?: number;
  /** Public link a person can open (Solscan, DexScreener, GitBook). Registry domains only. */
  url?: string;
}

/** Every tool returns this envelope. */
export interface ToolEnvelope<T = unknown> {
  data: T;
  /** e.g. "solana-rpc", "dexscreener", "kernel", "almanac", "gitbook". */
  source: string;
  locator: string;
  asOf: string;
  slot?: number;
  ttlSeconds: number;
  /** True when some part came from a fallback or stale cache. */
  degraded: boolean;
  /** Names of fields that could not be read. A missing value is unavailable, never zero. */
  unavailable: string[];
  receipts: Receipt[];
}

// --- runtime ---------------------------------------------------------------------

/** Minimal key-value cache (Durable Object storage or KV behind it). */
export interface Cache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface ChainConfig {
  /** Solana JSON-RPC endpoint; a paid one in production, public mainnet in dev. */
  rpcUrl: string;
  cache?: Cache;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Pace calls for a rate-limited endpoint (public RPC, or the dev relay in front of it). */
  gentle?: boolean;
}

// --- modes, judgment ---------------------------------------------------------------

export type Mode =
  | "off_topic"
  | "normal"
  | "brief_plus_bridge"
  | "sensitive_financial"
  | "trust_question"
  | "safety_alert"
  | "guarded"
  | "handoff";

export type Ordinal = "none" | "possible" | "clear";

/** Pre-flight battery: atomic ordinal labels, never probabilities. */
export interface PreflightLabels {
  scope:
    | "seasons_core"
    | "seasons_money"
    | "adjacent_finance"
    | "adjacent_crypto"
    | "general"
    | "smalltalk"
    | "personal_savings";
  injection: Ordinal;
  asks_personal_financial_advice: Ordinal;
  asks_about_returns: Ordinal;
  challenges_legitimacy: Ordinal;
  reports_possible_scam: Ordinal;
  distress: Ordinal;
  wants_human: Ordinal;
  gratitude: Ordinal;
  /** The message answers or continues GAIA's previous message (a number she asked for, "yes", "and for 5000?"). */
  follows_up: Ordinal;
  hostility: 0 | 1 | 2 | 3;
  complexity: 0 | 1 | 2 | 3;
  /** ISO 639-1 code of the user's language. */
  language: string;
}

// --- guards ----------------------------------------------------------------------------

export type SecretLevel = "none" | "soft" | "hard";

export interface GuardResult {
  /** NFKC-normalised text with invisible characters removed and secrets redacted. Safe for any model. */
  text: string;
  secret: SecretLevel;
  /** e.g. ["bip39_mnemonic"], ["base58_private_key"]. Never the secret itself. */
  secretKinds: string[];
  links: string[];
  /** Base58 Solana addresses found in the user's own text. */
  addresses: string[];
  /** Base58 transaction signatures found in the user's own text. */
  signatures: string[];
  /** Heuristic prompt-injection patterns found, e.g. ["ignore_previous", "role_override"]. */
  injectionSignals: string[];
  floors: {
    /** $SEAS/Seasons together with money words or numbers. */
    seasonsMoney: boolean;
    /** Id of a Hard Answer whose intent examples match deterministically, else null. */
    pin: string | null;
    /** Secrets, pasted links/addresses/signatures or instruction patterns. */
    safety: boolean;
  };
  /** Script-based guess ("ru", "ja", "en" …); the judge refines it. */
  lang: string;
}

// --- verifier ----------------------------------------------------------------------------

export interface Violation {
  check: string;
  severity: "block" | "flag";
  detail: string;
  sentence?: string;
}

export interface VerifyContext {
  mode: Mode;
  lang: string;
  receipts: Receipt[];
  /** The user's own words this turn (not suggestions), used for number and address provenance. */
  userText: string;
  /** The pinned Hard Answer, when the router pinned one. */
  pinned?: HardAnswer | null;
  /** Official registry: the only domains and addresses an answer may link or name. */
  registry?: RegistryEntry[];
  /** Per-deploy canary token from the system prompt; it must never appear in output. */
  canary?: string;
}

export interface VerifyResult {
  /** The draft after auto-fixes ($SEAS spelling, defanged non-registry domains). */
  text: string;
  violations: Violation[];
}

// --- canon -------------------------------------------------------------------------------

export type FactStatus = "approved" | "team_reported" | "needs_founder";

export interface Fact {
  key: string;
  /** One-sentence statement GAIA may use. */
  text: string;
  numbers: number[];
  as_of: string;
  source_kind: ReceiptKind;
  /** Where a person can verify it: doc title, URL or on-chain locator. */
  source: string;
  url?: string;
  status: FactStatus;
  /** Live tool that supersedes this value when available. */
  live_tool?: string;
  /** Never volunteered; asked directly, answered briefly and neutrally (or passed to the team). */
  on_request?: boolean;
}

export interface HardAnswer {
  id: string;
  version: number;
  /** "hold" entries state what is verifiable and log the question; they never deny. */
  status: "approved" | "hold" | "needs_founder";
  mode: "STATE" | "HOLD";
  intents: string[];
  /** Deterministic pin examples per language. */
  examples: Record<string, string[]>;
  required_fact_keys: string[];
  model_brief: {
    core_points: string[];
    short_form: string;
    /** The one limitation it mentions, if any. */
    counterweight?: string;
  };
  /** Verifier-side only; never placed in a prompt. */
  verifier: {
    must_not: Record<string, string[]>;
    forbidden_implicatures: string[];
    cooccurrence_block?: { concede: Record<string, string[]>; label: Record<string, string[]> };
  };
}

export interface RegistryEntry {
  kind: "domain" | "url" | "address" | "handle" | "email";
  value: string;
  label: string;
  status: "official" | "outdated" | "inactive";
}

export interface BridgeEdge {
  /** Adjacent topic cluster, e.g. "bitcoin", "gold", "stablecoin_yield". */
  cluster: string;
  /** The Seasons concept it bridges to. */
  to: string;
  /** One example bridge sentence (style guide, not a template). */
  example: string;
}

// --- wire contract v2 -------------------------------------------------------

export type TurnOrigin = "typed" | "suggestion" | "chip" | "paste";

export interface TurnRequest {
  v: 2;
  text: string;
  client_msg_id: string;
  origin: TurnOrigin;
  context: {
    surface: "gaia_stage" | "widget" | "terminal";
    route?: string;
    locale?: string;
    layer?: "spoken" | "full";
  };
  conversation_id?: string;
}

export type SemanticState = "thinking" | "tool" | "verifying" | "guard" | "degraded" | "handoff";

export type StreamEvent =
  | { type: "turn.start"; turn_id: string; conversation_id: string; disclosure_ids: string[] }
  | { type: "state"; semantic: SemanticState; label?: string }
  | { type: "policy"; mode: Mode; delivery: "ordered" | "proof_first"; pinned?: string | null }
  | {
      type: "tool.call";
      call_id: string;
      tool: string;
      label: string;
      initiator: "router" | "model";
    }
  | {
      type: "tool.result";
      call_id: string;
      receipt_ids: string[];
      degraded: boolean;
      unavailable: string[];
    }
  | { type: "receipt"; receipt: Receipt }
  | { type: "text.commit"; text: string; layer: "spoken" | "full"; message_id: string }
  | { type: "shape"; shape: GaiaShape | null }
  | { type: "followup"; text: string }
  | { type: "memory"; token: string }
  | { type: "error"; code: string; retryable: boolean }
  /** Eval requests only: the judges' labels, for the Haiku vs Jev comparison. */
  | {
      type: "debug";
      cost_usd: number;
      mode: Mode;
      haiku: PreflightLabels;
      jev: unknown;
      violations: string[];
    }
  | {
      type: "turn.end";
      turn_id: string;
      message_id: string;
      verifier: "pass" | "repaired" | "template";
      provenance: "chain" | "docs" | "approved" | "general" | "unverified";
      receipts_count: number;
    };
