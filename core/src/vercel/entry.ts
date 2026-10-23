import { waitUntil } from "@vercel/functions";

import { handle } from "./app";

/** Vercel function entry (bundled to api/core.js by scripts/build-vercel.mjs). */
const run = (request: Request) => handle(request, waitUntil);
export const GET = run;
export const POST = run;
export const OPTIONS = run;
