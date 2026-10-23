/**
 * Base58 (Bitcoin alphabet) and ed25519 on-curve checks for Solana addresses.
 * Kept dependency-light: only @noble/curves for point decoding.
 */
import { ed25519 } from "@noble/curves/ed25519.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let n = 0n;
  for (const c of s) {
    const v = INDEX[c];
    if (v === undefined) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  // Leading '1's encode leading zero bytes.
  for (const c of s) {
    if (c !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** A syntactically valid Solana address: base58 that decodes to exactly 32 bytes. */
export function isValidAddress(s: string): boolean {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

/**
 * True when the 32 bytes decode to an ed25519 point. On-curve addresses have a
 * private key (single-signature wallets); PDAs are off-curve by construction.
 * Same test Solana uses for `PublicKey.isOnCurve`.
 */
export function isOnCurveBytes(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

export function isOnCurve(address: string): boolean {
  if (!isValidAddress(address)) return false;
  return isOnCurveBytes(base58Decode(address));
}

export type AuthorityType = "none" | "single_key_wallet" | "pda";

/** On-curve = one private key controls it; off-curve = a program (PDA, possibly a multisig vault). */
export function classifyAuthority(address: string | null | undefined): AuthorityType {
  if (!address) return "none";
  return isOnCurve(address) ? "single_key_wallet" : "pda";
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.length); // plain ArrayBuffer-backed view for WebCrypto typings
  copy.set(data);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
}

/** Solana findProgramAddress (async because Workers expose SHA-256 only via WebCrypto). */
export async function findProgramAddress(
  seeds: Uint8Array[],
  programId: string,
): Promise<{ address: string; bump: number }> {
  const program = base58Decode(programId);
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, marker];
    const len = parts.reduce((a, p) => a + p.length, 0);
    const buf = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const hash = await sha256(buf);
    if (!isOnCurveBytes(hash)) return { address: base58Encode(hash), bump };
  }
  throw new Error("no viable bump for program address");
}
