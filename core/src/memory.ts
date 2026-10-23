/**
 * Signed conversation memory for hosts without durable state (the Vercel demo):
 * after each turn the browser gets the recent turns as an HMAC-signed token and
 * sends it back with the next message, so a cold function instance can restore
 * the thread. The signature (GAIA_MEMORY_KEY, else GAIA_CANARY) means nobody can
 * forge GAIA's side of the conversation. Cloudflare keeps history in its Durable
 * Object and ignores tokens.
 */

export interface MemoryTurn {
  /** Redacted user text. */
  u: string;
  /** GAIA's verified answer. */
  a: string;
  /** Message id of that answer (the voice endpoint reads by id). */
  m?: string;
  /** The mode that answered it. */
  mode?: string;
}

interface Payload {
  c: string;
  at: number;
  h: MemoryTurn[];
}

const encoder = new TextEncoder();
const MAX_TURNS = 6;
const MAX_AGE_MS = 12 * 3600_000;

function b64u(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

export async function signMemory(
  secret: string,
  conversationId: string,
  turns: MemoryTurn[],
): Promise<string> {
  const payload: Payload = {
    c: conversationId,
    at: Date.now(),
    h: turns.slice(-MAX_TURNS).map((t) => ({ ...t, u: t.u.slice(0, 600), a: t.a.slice(0, 1500) })),
  };
  const body = encoder.encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), body));
  return `${b64u(body)}.${b64u(sig)}`;
}

/** The turns in a token, or null when it is forged, stale or for another conversation. */
export async function readMemory(
  secret: string,
  conversationId: string,
  token: string | undefined,
): Promise<MemoryTurn[] | null> {
  if (!token || !secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const bytes = unb64u(body);
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64u(sig), bytes);
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Payload;
    if (
      payload.c !== conversationId ||
      Date.now() - payload.at > MAX_AGE_MS ||
      !Array.isArray(payload.h)
    )
      return null;
    return payload.h
      .filter((t) => typeof t.u === "string" && typeof t.a === "string")
      .slice(-MAX_TURNS);
  } catch {
    return null;
  }
}
