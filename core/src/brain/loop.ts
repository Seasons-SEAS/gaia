import Anthropic from "@anthropic-ai/sdk";

import { TOOLS, type ToolOutcome } from "./tools";

/**
 * The brain: Claude Opus 5.5 through the Messages API with a
 * manual tool loop. The tool list and system prompt are byte-stable and
 * cached for an hour; the per-turn policy is a mid-conversation system
 * message after the user's message. Server-side refusal fallbacks are
 * deliberately not enabled (a different model would answer under a different
 * policy); a refusal is served the calm safe template instead.
 */

export interface ThinkInput {
  client: Anthropic;
  model: string;
  system: string;
  history: Anthropic.MessageParam[];
  userText: string;
  turnMessage: string;
  effort: "low" | "medium";
  /** "none" on guarded turns: the tools array stays identical, only the choice changes. */
  toolChoice: "auto" | "none";
  runTool: (name: string, input: Record<string, unknown>, id: string) => Promise<ToolOutcome>;
  maxRounds?: number;
}

export interface Usage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
}

/** List prices per million tokens: input, output, cache read (cache writes: 2× input for 1 h, 1.25× for 5 min). */
const PRICES: Record<string, [number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-haiku-4-5": [1, 5, 0.1],
};

/** What the brain's calls cost, at the list price of the model that ran them (unknown models priced as Opus 5.5). */
export const brainCostUsd = (model: string, u: Usage) => {
  const [input, output, read] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  return (
    (u.input * input + u.output * output + u.cacheRead * read + u.cacheWrite1h * input * 2 + u.cacheWrite5m * input * 1.25) /
    1_000_000
  );
};

export interface ThinkResult {
  text: string;
  followup: string | null;
  refusal: string | null;
  stopReason: string;
  rounds: number;
  usage: Usage;
}

const FOLLOWUP = /<followup>([\s\S]*?)<\/followup>/i;

export function splitFollowup(raw: string): { text: string; followup: string | null } {
  const match = raw.match(FOLLOWUP);
  const text = raw
    .replace(FOLLOWUP, "")
    .replace(/<\/?followup>/gi, "")
    .trim();
  return { text, followup: match ? match[1].trim() : null };
}

export async function think(input: ThinkInput): Promise<ThinkResult> {
  const maxRounds = input.maxRounds ?? 3;
  const messages: Anthropic.MessageParam[] = [
    ...input.history,
    { role: "user", content: input.userText },
    // Operator channel: follows the user's message, keeps the cached prefix intact.
    { role: "system", content: input.turnMessage } as unknown as Anthropic.MessageParam,
  ];
  const usage: Usage = {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
  };
  let rounds = 0;

  for (;;) {
    // Past the budget the model gets a note (below) and keeps the same
    // tool_choice, so the cached conversation tail stays valid; only if it
    // still reaches for a tool does the next call switch tools off.
    const lastRound = rounds > maxRounds;
    const response = await input.client.messages.create(
      {
        model: input.model,
        max_tokens: 6000,
        output_config: { effort: input.effort },
        system: [
          { type: "text", text: input.system, cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
        tools: TOOLS,
        tool_choice: { type: lastRound ? "none" : input.toolChoice },
        cache_control: { type: "ephemeral" },
        messages,
      } as Anthropic.MessageCreateParamsNonStreaming,
      { timeout: 90_000, maxRetries: 2 },
    );
    const writes = (
      response.usage as unknown as {
        cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
      }
    ).cache_creation;
    usage.calls++;
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite1h += writes?.ephemeral_1h_input_tokens ?? 0;
    usage.cacheWrite5m +=
      writes?.ephemeral_5m_input_tokens ??
      (writes ? 0 : (response.usage.cache_creation_input_tokens ?? 0));

    if (response.stop_reason === "refusal") {
      const details = (response as unknown as { stop_details?: { category?: string | null } })
        .stop_details;
      return {
        text: "",
        followup: null,
        refusal: details?.category ?? "unspecified",
        stopReason: "refusal",
        rounds,
        usage,
      };
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    // A cut-off answer is a failed attempt, never shipped half-written.
    if (response.stop_reason === "max_tokens")
      return { text: "", followup: null, refusal: null, stopReason: "max_tokens", rounds, usage };
    if (response.stop_reason !== "tool_use" || !toolUses.length) {
      const raw = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return {
        ...splitFollowup(raw),
        refusal: null,
        stopReason: response.stop_reason ?? "end_turn",
        rounds,
        usage,
      };
    }

    // Keep the assistant turn exactly as returned (thinking blocks included).
    messages.push({ role: "assistant", content: response.content });
    rounds++;
    const results = await Promise.all(
      toolUses.map(async (use) => {
        const outcome = await input.runTool(
          use.name,
          (use.input ?? {}) as Record<string, unknown>,
          use.id,
        );
        return {
          type: "tool_result",
          tool_use_id: use.id,
          content: outcome.content,
          is_error: outcome.isError,
        } satisfies Anthropic.ToolResultBlockParam;
      }),
    );
    // All results of one assistant turn go back in a single user message.
    messages.push({ role: "user", content: results });
    if (rounds === maxRounds)
      messages.push({
        role: "system",
        content:
          "The tool budget for this turn is used. Answer now from the receipts and tool results above; don't call another tool.",
      } as unknown as Anthropic.MessageParam);
  }
}
