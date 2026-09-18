import { createHmac, createPrivateKey, createPublicKey, timingSafeEqual, type KeyObject } from "node:crypto";

export type Bytes = string | Uint8Array;

export function hmac(algorithm: "sha256" | "sha1", key: Bytes, data: Bytes, encoding: "hex" | "base64"): string {
  // Strings are hashed as UTF-8, exactly like the webhook-toolkit.com signer.
  return createHmac(algorithm, key).update(data).digest(encoding);
}

/** Constant-time string comparison (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function toUnixSeconds(value: number | Date | undefined): number {
  if (value === undefined) return Math.floor(Date.now() / 1000);
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (!Number.isFinite(value)) throw new TypeError("timestamp must be a finite number of seconds");
  return Math.floor(value);
}

export function bodyToString(body: Bytes): string {
  return typeof body === "string" ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
}

export function concatBytes(prefix: string, body: Bytes, suffix = ""): Buffer {
  const b = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.concat([Buffer.from(prefix, "utf8"), b, Buffer.from(suffix, "utf8")]);
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Svix / Standard Webhooks secret → HMAC key bytes. `whsec_` prefix optional.
 * Strict like the official libraries: Node's own decoder silently ignores a dangling
 * character, which would accept a mistyped secret.
 */
export function decodeSvixSecret(secret: string): Buffer | null {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  if (!raw || !BASE64.test(raw)) return null;
  const unpadded = raw.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return null;
  const key = Buffer.from(unpadded, "base64");
  if (key.length === 0 || key.toString("base64").replace(/=+$/, "") !== unpadded) return null;
  return key;
}

// DER prefixes wrapping a raw 32-byte Ed25519 key into PKCS#8 / SPKI.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Ed25519 private key from a 32-byte hex seed or a PEM string. */
export function ed25519PrivateKey(secret: string): KeyObject {
  const s = secret.trim();
  if (HEX64.test(s)) {
    return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(s, "hex")]), format: "der", type: "pkcs8" });
  }
  return createPrivateKey(s);
}

/** Ed25519 public key from a 32-byte hex key (the Discord developer portal format) or a PEM string. */
export function ed25519PublicKey(secret: string): KeyObject {
  const s = secret.trim();
  if (HEX64.test(s)) {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(s, "hex")]), format: "der", type: "spki" });
  }
  return createPublicKey(s);
}
