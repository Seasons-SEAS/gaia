/**
 * Base58 (Bitcoin alphabet) decoding and the Solana keypair test. Kept local
 * to the guards so L0 has no dependency on the chain module.
 */
import { ed25519 } from "@noble/curves/ed25519.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i] as const));

export const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]/;

/** Decoded bytes, or null when the string isn't base58. */
export function base58Decode(s: string): Uint8Array | null {
  if (!s) return null;
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A Solana secret key is seed(32) ‖ pubkey(32) where pubkey = ed25519(seed).
 * A transaction signature is also 64 bytes but never has this structure, so
 * this separates "never repeat this" from "a transaction to look up".
 */
export function isSolanaKeypair(bytes: Uint8Array): boolean {
  if (bytes.length !== 64) return false;
  try {
    return equal(ed25519.getPublicKey(bytes.slice(0, 32)), bytes.slice(32));
  } catch {
    return false;
  }
}

export type Base58Kind = "address" | "signature" | "keypair" | null;

export function classifyBase58(s: string): Base58Kind {
  if (s.length < 32 || s.length > 90) return null;
  const bytes = base58Decode(s);
  if (!bytes) return null;
  if (bytes.length === 32 && s.length <= 44) return "address";
  if (bytes.length === 64 && s.length >= 64)
    return isSolanaKeypair(bytes) ? "keypair" : "signature";
  return null;
}
