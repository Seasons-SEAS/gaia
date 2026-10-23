export interface Env {
  CONVERSATIONS: DurableObjectNamespace;
  LIMITER: DurableObjectNamespace;
  CHAIN_CACHE: DurableObjectNamespace;
  ANTHROPIC_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  /** Vercel AI Gateway, used only for the Jev shadow judge on eval sets. */
  AI_GATEWAY_API_KEY?: string;
  SOLANA_RPC_URL: string;
  /** "1" when SOLANA_RPC_URL is rate-limited like public RPC (the dev relay). */
  SOLANA_RPC_GENTLE?: string;
  /** Comma-separated origins allowed to call Core from a browser. */
  ALLOWED_ORIGINS: string;
  GAIA_MODEL: string;
  JUDGE_MODEL: string;
  /** Comma-separated languages GAIA answers in; the first is the default. Empty = all. */
  GAIA_LANGUAGES?: string;
  /** Rotated per deploy; placed in the system prompt and blocked in any output. */
  GAIA_CANARY?: string;
  /** HMAC key for signed conversation memory (defaults to GAIA_CANARY). */
  GAIA_MEMORY_KEY?: string;
  /** Per-IP turn budget (defaults 8 per minute, 60 per hour). */
  LIMIT_PER_MINUTE?: string;
  LIMIT_PER_HOUR?: string;
  /** Local/eval only: requests carrying this token in X-Gaia-Eval get a debug event and the Jev shadow. */
  EVAL_TOKEN?: string;
}
