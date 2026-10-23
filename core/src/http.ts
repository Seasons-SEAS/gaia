import { z } from "zod";

import type { Env } from "./env";

/**
 * The edge contract shared by every host of Core (the Cloudflare Worker in
 * src/index.ts and the Vercel demo in src/vercel/app.ts): request schema,
 * origin allowlist, CORS and JSON replies.
 */

export const TurnBody = z.object({
  v: z.literal(2),
  text: z.string().trim().min(1).max(2000),
  client_msg_id: z.string().min(1).max(64),
  origin: z.enum(["typed", "suggestion", "chip", "paste"]),
  context: z.object({
    surface: z.enum(["gaia_stage", "widget", "terminal"]),
    route: z.string().max(200).optional(),
    locale: z.string().max(12).optional(),
    layer: z.enum(["spoken", "full"]).optional(),
  }),
  conversation_id: z.string().uuid().optional(),
  /** Signed recent turns (src/memory.ts) for hosts without durable state. */
  memory: z.string().max(60000).optional(),
});

/** Voice by message id; POST may carry the signed memory so a cold host can still find the answer. */
export const VoiceBody = z.object({
  c: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  m: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  memory: z.string().max(60000).optional(),
});

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  return origin && allowed.includes(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
      }
    : {};
}

export function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  // Same-origin proxies (the site) may omit Origin on GET; browsers always send it on POST.
  if (!origin) return request.method === "GET";
  return env.ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .includes(origin);
}

/** Upstream headers plus CORS. */
export function withCors(upstream: Headers, cors: Record<string, string>): Headers {
  const headers = new Headers(upstream);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return headers;
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
