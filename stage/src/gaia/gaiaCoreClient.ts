/**
 * Client for GAIA Core's v2 stream (`POST /api/gaia/v2/turn`, server-sent
 * events, one JSON object per event). The server emits only semantic states;
 * the stage derives what the core shows from them.
 */
export type CoreReceipt = {
  id: string;
  kind: "chain" | "api" | "almanac" | "docs" | "team_statement" | "calc";
  label: string;
  value: string;
  read_at: string;
  url?: string;
};

export type CoreEvent =
  | { type: "turn.start"; conversation_id: string }
  | {
      type: "state";
      semantic: "thinking" | "tool" | "verifying" | "guard" | "degraded" | "handoff";
      label?: string;
    }
  | { type: "policy"; mode: string }
  | { type: "tool.call"; label: string }
  | { type: "receipt"; receipt: CoreReceipt }
  | { type: "text.commit"; text: string; message_id: string }
  | { type: "shape"; shape: "mark" | "check" | "heart" | null }
  | { type: "followup"; text: string }
  | { type: "memory"; token: string }
  | { type: "error"; code: string }
  | { type: "turn.end"; verifier: "pass" | "repaired" | "template"; provenance: string };

const CID_KEY = "gaia.cid";
const MEMORY_KEY = "gaia.memory";

export const conversationId = (): string | undefined => {
  try {
    return sessionStorage.getItem(CID_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const remember = (id: string) => {
  try {
    sessionStorage.setItem(CID_KEY, id);
  } catch {
    /* private mode: the conversation lasts for this page only */
  }
};

/**
 * The signed recent turns Core hands back after each answer (hosts without
 * durable state restore the thread from it). Opaque to the page.
 */
export const coreMemory = (): string | undefined => {
  try {
    return sessionStorage.getItem(MEMORY_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const keepMemory = (token: string) => {
  try {
    sessionStorage.setItem(MEMORY_KEY, token);
  } catch {
    /* private mode: the host's own memory still holds the thread */
  }
};

/** True when Core is reachable and has a model key. */
export async function coreAvailable(): Promise<boolean> {
  try {
    const response = await fetch("/api/gaia/v2/config", { cache: "no-store" });
    if (!response.ok) return false;
    const config = (await response.json()) as { brain?: boolean };
    return Boolean(config.brain);
  } catch {
    return false;
  }
}

export async function streamTurn(
  text: string,
  origin: "typed" | "suggestion",
  locale: string,
  onEvent: (event: CoreEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/gaia/v2/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      v: 2,
      text,
      client_msg_id: crypto.randomUUID(),
      origin,
      context: { surface: "gaia_stage", locale, layer: "spoken" },
      conversation_id: conversationId(),
      memory: coreMemory(),
    }),
  });
  if (!response.ok || !response.body) throw new Error(`core ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const frames = rest.split("\n\n");
    rest = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as CoreEvent | { type: "keepalive" };
      if (event.type === "keepalive") continue;
      if (event.type === "turn.start") remember(event.conversation_id);
      if (event.type === "memory") {
        keepMemory(event.token);
        continue;
      }
      onEvent(event);
    }
  }
}

/**
 * The receipts worth showing under an answer: the ones whose values or words
 * the answer actually uses, on-chain reads first.
 */
export function rankReceipts(receipts: CoreReceipt[], answer: string, limit = 3): CoreReceipt[] {
  const text = answer.toLowerCase();
  const digits = new Set(answer.match(/\d[\d,.]*/g)?.map((n) => n.replace(/,/g, "")) ?? []);
  const score = (receipt: CoreReceipt) => {
    const values = receipt.value.match(/\d[\d,.]*/g)?.map((n) => n.replace(/,/g, "")) ?? [];
    const numberHits = values.filter((v) => digits.has(v)).length;
    const wordHits = receipt.label
      .toLowerCase()
      .split(/[^a-z$]+/)
      .filter((word) => word.length >= 5 && text.includes(word)).length;
    return numberHits * 3 + wordHits * 2 + (receipt.kind === "chain" ? 1 : 0);
  };
  return receipts
    .map((receipt) => ({ receipt, value: score(receipt) }))
    .filter(({ value }) => value >= 2)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map(({ receipt }) => receipt);
}
