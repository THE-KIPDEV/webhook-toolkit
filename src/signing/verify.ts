import { createHash, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { WebhookToolkitError } from "../errors.js";
import { toHeaderRecord, type HeadersLike } from "../headers.js";
import { bodyToString, concatBytes, decodeSvixSecret, ed25519PublicKey, hmac, safeEqual, type Bytes } from "./crypto.js";
import { getSignatureProvider, SIGNATURE_PROVIDER_IDS, type SignatureProvider } from "./providers.js";
import { buildCanonical, hasRepeatedKeys, parseFormBody, urlVariants, type UrlDelta } from "./twilio.js";

export interface VerifyOptions {
  /** Signing secret. Discord: the application public key (hex). */
  secret: string;
  /** The body exactly as received, before any JSON parsing. */
  rawBody: string | Uint8Array;
  /** Request headers (any casing, Fetch `Headers` or Node `IncomingHttpHeaders`). */
  headers: HeadersLike;
  /** Twilio only (required): the full public URL Twilio called, query string included. */
  url?: string;
  /** Replay window for timestamped schemes (Stripe, Slack, Svix, Paddle, Mailgun). Default 300. `0` disables the check. */
  toleranceSeconds?: number;
  /** Clock override (unix seconds or Date), for tests. */
  now?: number | Date;
}

export type VerifyFailureReason =
  | "missing_signature"
  | "malformed_signature"
  | "missing_timestamp"
  | "missing_url"
  | "invalid_secret"
  | "timestamp_out_of_tolerance"
  | "signature_mismatch"
  | "secret_whitespace"
  | "body_trailing_newline_added"
  | "body_trailing_newline_removed"
  | "body_line_endings_changed"
  | "url_mismatch"
  | "body_hash_mismatch";

export interface VerifyResult {
  valid: boolean;
  provider: SignatureProvider;
  /** Set when `valid` is false: the most likely cause. */
  reason?: VerifyFailureReason;
  /** One or two sentences: verdict and, when invalid, what to fix. */
  message: string;
  /** The signature header value the inputs should have produced (not available for Discord). */
  expected?: string;
  /** The signature value found in the request. */
  received?: string;
  /** Timestamped schemes: the signed timestamp and its age at verification time. */
  timestamp?: { value: number; ageSeconds: number };
}

type Delta = "trimSecret" | "stripNewline" | "addNewline" | "crlf";

const DELTA_REASON: Record<Delta, VerifyFailureReason> = {
  trimSecret: "secret_whitespace",
  stripNewline: "body_trailing_newline_added",
  addNewline: "body_trailing_newline_removed",
  crlf: "body_line_endings_changed",
};

const DELTA_MESSAGE: Record<Delta, string> = {
  trimSecret:
    "The signature matches once the secret is trimmed: your secret has leading/trailing whitespace or a newline (check how it is loaded from .env or your secret manager).",
  stripNewline:
    "The signature matches the body without its trailing newline: a newline was appended after signing (proxy, logger, copy-paste). Verify the raw bytes exactly as received.",
  addNewline:
    "The signature matches the body with a trailing newline: the sender signed a body ending in \\n and something stripped it (trim(), a body parser, copy-paste). Verify the raw bytes exactly as received.",
  crlf: "The signature matches once CRLF line endings become LF: the body was re-encoded after signing (Windows line endings, copy-paste). Verify the raw bytes exactly as received.",
};

const MISMATCH_MESSAGE =
  "Signature mismatch: the secret is wrong (test vs live mode, another endpoint's secret, a rotated secret) or the body changed before verification (JSON parsed then re-serialised by a body parser such as express.json() or request.json()). Verify the raw body bytes.";

const TWILIO_DELTA_MESSAGE: Record<UrlDelta | "arraySort", string> = {
  scheme:
    "The signature matches with the other URL scheme (http vs https): your app sits behind a TLS-terminating proxy. Rebuild the URL from X-Forwarded-Proto, or validate against the public URL configured in Twilio.",
  port: "The signature matches with a different port in the URL: Twilio signs the URL exactly as configured. Do not add or drop :443/:80, and never use your app's internal port.",
  query: "The signature matches without the query string: include (or drop) the query string exactly as configured in the Twilio console.",
  slash: "The signature matches with a different trailing slash: the URL you validate must match the configured webhook URL character for character.",
  arraySort:
    "The signature matches once repeated parameters are sorted: Twilio coerces repeated keys to a comma-joined list (twilio-node issue #722). Sort the array values before validating.",
};

// ─── helpers ────────────────────────────────────────────────────────────────

function nowSeconds(now: number | Date | undefined): number {
  if (now === undefined) return Math.floor(Date.now() / 1000);
  return now instanceof Date ? Math.floor(now.getTime() / 1000) : Math.floor(now);
}

/** Body forms a proxy/framework might feed a verifier, starting with the one given. */
function bodyVariants(body: string): { body: string; delta: Delta | null }[] {
  const out: { body: string; delta: Delta | null }[] = [];
  if (/\r\n/.test(body)) out.push({ body: body.replace(/\r\n/g, "\n"), delta: "crlf" });
  if (/[\r\n]+$/.test(body)) out.push({ body: body.replace(/[\r\n]+$/, ""), delta: "stripNewline" });
  else out.push({ body: body + "\n", delta: "addNewline" });
  return out;
}

interface Scheme {
  /** Signatures found in the request, normalised for comparison. */
  provided: string[];
  /** Raw header value, reported as `received`. */
  received: string;
  /** Signed timestamp, when the scheme has one. */
  ts: number | null;
  /** Comparable signature for (secret, body). */
  compute(secret: string, body: Bytes): string;
  /** Header value the exact inputs should have produced. */
  format(sig: string): string;
}

type Parsed = Scheme | { reason: VerifyFailureReason; message: string; received?: string };

function fail(reason: VerifyFailureReason, message: string, received?: string): Parsed {
  return received === undefined ? { reason, message } : { reason, message, received };
}

function header(h: Record<string, string>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = h[n];
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return undefined;
}

// ─── per-provider parsing ───────────────────────────────────────────────────

function parseScheme(provider: SignatureProvider, h: Record<string, string>, secret: string, rawBody: string): Parsed | "special" {
  switch (provider) {
    case "stripe": {
      const raw = header(h, "stripe-signature");
      if (!raw) return fail("missing_signature", "No Stripe-Signature header in the request.");
      let t: string | null = null;
      const v1: string[] = [];
      for (const part of raw.split(",")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k === "t") t = v;
        else if (k === "v1") v1.push(v.toLowerCase());
      }
      if (!t || !/^\d+$/.test(t) || v1.length === 0)
        return fail("malformed_signature", 'Stripe-Signature should look like "t=<unix>,v1=<hex>".', raw);
      const ts = Number(t);
      return {
        provided: v1,
        received: raw,
        ts,
        compute: (s, b) => hmac("sha256", s, concatBytes(`${ts}.`, b), "hex"),
        format: (sig) => `t=${ts},v1=${sig}`,
      };
    }
    case "github": {
      const raw256 = header(h, "x-hub-signature-256");
      const raw = raw256 ?? header(h, "x-hub-signature");
      if (!raw) return fail("missing_signature", "No X-Hub-Signature-256 (or X-Hub-Signature) header in the request.");
      const algo: "sha256" | "sha1" = raw.startsWith("sha1=") || (!raw256 && !raw.startsWith("sha256=")) ? "sha1" : "sha256";
      const hex = raw.replace(/^sha(256|1)=/, "").trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(hex)) return fail("malformed_signature", 'X-Hub-Signature-256 should look like "sha256=<hex>".', raw);
      return {
        provided: [hex],
        received: raw,
        ts: null,
        compute: (s, b) => hmac(algo, s, b, "hex"),
        format: (sig) => `${algo}=${sig}`,
      };
    }
    case "shopify": {
      const raw = header(h, "x-shopify-hmac-sha256");
      if (!raw) return fail("missing_signature", "No X-Shopify-Hmac-Sha256 header in the request.");
      if (!/^[A-Za-z0-9+/=]+$/.test(raw)) return fail("malformed_signature", "X-Shopify-Hmac-Sha256 should be a base64 HMAC.", raw);
      return { provided: [raw], received: raw, ts: null, compute: (s, b) => hmac("sha256", s, b, "base64"), format: (sig) => sig };
    }
    case "slack": {
      const raw = header(h, "x-slack-signature");
      if (!raw) return fail("missing_signature", "No X-Slack-Signature header in the request.");
      const hex = (raw.startsWith("v0=") ? raw.slice(3) : raw).trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(hex)) return fail("malformed_signature", 'X-Slack-Signature should look like "v0=<hex>".', raw);
      const tsRaw = header(h, "x-slack-request-timestamp");
      if (!tsRaw || !/^\d+$/.test(tsRaw)) return fail("missing_timestamp", "No valid X-Slack-Request-Timestamp header in the request.", raw);
      const ts = Number(tsRaw);
      return {
        provided: [hex],
        received: raw,
        ts,
        compute: (s, b) => hmac("sha256", s, concatBytes(`v0:${ts}:`, b), "hex"),
        format: (sig) => `v0=${sig}`,
      };
    }
    case "paddle": {
      const raw = header(h, "paddle-signature");
      if (!raw) return fail("missing_signature", "No Paddle-Signature header in the request.");
      let t: string | null = null;
      const h1: string[] = [];
      for (const part of raw.split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k === "ts") t = v;
        else if (k === "h1") h1.push(v.toLowerCase());
      }
      if (!t || !/^\d+$/.test(t) || h1.length === 0)
        return fail("malformed_signature", 'Paddle-Signature should look like "ts=<unix>;h1=<hex>".', raw);
      const ts = Number(t);
      return {
        provided: h1,
        received: raw,
        ts,
        compute: (s, b) => hmac("sha256", s, concatBytes(`${ts}:`, b), "hex"),
        format: (sig) => `ts=${ts};h1=${sig}`,
      };
    }
    case "svix": {
      const raw = header(h, "svix-signature", "webhook-signature");
      if (!raw) return fail("missing_signature", "No svix-signature (or webhook-signature) header in the request.");
      const id = header(h, "svix-id", "webhook-id");
      const tsRaw = header(h, "svix-timestamp", "webhook-timestamp");
      if (!id) return fail("malformed_signature", "No svix-id (or webhook-id) header: it is part of the signed content.", raw);
      if (!tsRaw || !/^\d+$/.test(tsRaw)) return fail("missing_timestamp", "No valid svix-timestamp (or webhook-timestamp) header in the request.", raw);
      if (!decodeSvixSecret(secret) && !decodeSvixSecret(secret.trim()))
        return fail("invalid_secret", "The secret is not valid base64: Svix / Standard Webhooks secrets look like whsec_<base64>.", raw);
      const provided = raw
        .split(" ")
        .map((p) => p.trim())
        .filter((p) => p.startsWith("v1,"))
        .map((p) => p.slice(3));
      if (provided.length === 0) return fail("malformed_signature", 'The signature header should contain "v1,<base64>" entries.', raw);
      const ts = Number(tsRaw);
      return {
        provided,
        received: raw,
        ts,
        compute: (s, b) => {
          const key = decodeSvixSecret(s);
          return key ? hmac("sha256", key, concatBytes(`${id}.${ts}.`, b), "base64") : "";
        },
        format: (sig) => `v1,${sig}`,
      };
    }
    case "mailgun": {
      const sig = mailgunSignature(rawBody);
      if (!sig) return fail("missing_signature", "No signature object in the body (Mailgun sends signature.timestamp, .token and .signature).");
      if (!/^\d+$/.test(sig.timestamp)) return fail("missing_timestamp", "signature.timestamp is missing or not a number.", sig.signature);
      const ts = Number(sig.timestamp);
      // The signature covers "<timestamp><token>", not the body.
      return {
        provided: [sig.signature.toLowerCase()],
        received: sig.signature,
        ts,
        compute: (s) => hmac("sha256", s, `${sig.timestamp}${sig.token}`, "hex"),
        format: (s) => s,
      };
    }
    case "twilio":
    case "discord":
      return "special";
  }
}

function mailgunSignature(rawBody: string): { timestamp: string; token: string; signature: string } | null {
  try {
    const parsed = JSON.parse(rawBody) as { signature?: Record<string, unknown> };
    const s = parsed?.signature;
    if (s && typeof s === "object" && typeof s.signature === "string" && typeof s.token === "string") {
      return { timestamp: String(s.timestamp ?? ""), token: s.token, signature: s.signature };
    }
  } catch {
    /* legacy form-encoded webhooks below */
  }
  const params = new URLSearchParams(rawBody);
  const signature = params.get("signature");
  const token = params.get("token");
  if (signature && token) return { timestamp: params.get("timestamp") ?? "", token, signature };
  return null;
}

// ─── main entry ─────────────────────────────────────────────────────────────

/**
 * Verifies a webhook signature and, when it fails, tells you why: the mutation
 * (trimmed secret, added/removed trailing newline, CRLF, Twilio URL form…) that would
 * have made it pass is the diagnosis.
 *
 * ```ts
 * const res = verify("stripe", { secret, rawBody, headers: req.headers });
 * if (!res.valid) console.error(res.reason, res.message);
 * ```
 */
export function verify(provider: SignatureProvider | (string & {}), opts: VerifyOptions): VerifyResult {
  const info = getSignatureProvider(provider);
  if (!info) {
    throw new WebhookToolkitError(`Unknown provider "${provider}". Supported: ${SIGNATURE_PROVIDER_IDS.join(", ")}.`, {
      code: "invalid_input",
    });
  }
  if (typeof opts?.secret !== "string" || opts.secret === "") {
    throw new WebhookToolkitError(`${info.label}: secret is required (${info.secretHint}).`, { code: "invalid_input" });
  }
  const id = info.id;
  const headers = toHeaderRecord(opts.headers);
  const rawBody: Bytes = opts.rawBody ?? "";
  const bodyStr = bodyToString(rawBody);
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = nowSeconds(opts.now);

  if (id === "twilio") return verifyTwilio(opts.secret, bodyStr, headers, opts.url);
  if (id === "discord") return verifyDiscord(opts.secret, rawBody, headers, tolerance, now);

  const parsed = parseScheme(id, headers, opts.secret, bodyStr);
  if (parsed === "special") throw new Error("unreachable");
  if ("reason" in parsed) {
    return { valid: false, provider: id, reason: parsed.reason, message: parsed.message, ...(parsed.received ? { received: parsed.received } : {}) };
  }

  const exact = parsed.compute(opts.secret, rawBody);
  const matches = (sig: string) => sig !== "" && parsed.provided.some((p) => safeEqual(p, sig));
  const base = {
    provider: id,
    expected: parsed.format(exact),
    received: parsed.received,
    ...(parsed.ts !== null ? { timestamp: { value: parsed.ts, ageSeconds: now - parsed.ts } } : {}),
  };

  if (matches(exact)) {
    if (parsed.ts !== null && tolerance > 0 && Math.abs(now - parsed.ts) > tolerance) {
      return {
        ...base,
        valid: false,
        reason: "timestamp_out_of_tolerance",
        message: `The signature is correct but its timestamp is ${now - parsed.ts}s old (tolerance ${tolerance}s): a replayed or delayed delivery. Official SDKs reject it; send a freshly signed copy.`,
      };
    }
    return { ...base, valid: true, message: `Valid ${info.label} signature.` };
  }

  // Diagnosis: which plausible mutation of the body or secret would have matched?
  const secrets: { secret: string; delta: Delta | null }[] = [{ secret: opts.secret, delta: null }];
  if (opts.secret.trim() !== opts.secret) secrets.push({ secret: opts.secret.trim(), delta: "trimSecret" });
  const bodies: { body: Bytes; delta: Delta | null }[] = [{ body: rawBody, delta: null }, ...bodyVariants(bodyStr)];
  const candidates: Delta[][] = [];
  for (const b of bodies) {
    for (const s of secrets) {
      if (!b.delta && !s.delta) continue;
      // Same ordering as the webhook-toolkit.com validator: body delta first, then secret delta.
      if (matches(parsed.compute(s.secret, b.body))) candidates.push([b.delta, s.delta].filter((d): d is Delta => d !== null));
    }
  }
  candidates.sort((a, b) => a.length - b.length);
  const best = candidates[0];
  if (best && best[0]) {
    return { ...base, valid: false, reason: DELTA_REASON[best[0]], message: DELTA_MESSAGE[best[0]] };
  }
  return { ...base, valid: false, reason: "signature_mismatch", message: MISMATCH_MESSAGE };
}

function verifyTwilio(secret: string, body: string, headers: Record<string, string>, url: string | undefined): VerifyResult {
  const provided = header(headers, "x-twilio-signature");
  if (!provided) return { valid: false, provider: "twilio", reason: "missing_signature", message: "No X-Twilio-Signature header in the request." };
  if (!url) {
    return {
      valid: false,
      provider: "twilio",
      reason: "missing_url",
      received: provided,
      message: "Twilio signs the full public URL it called: pass `url` (as configured in the Twilio console, query string included).",
    };
  }
  let variants;
  try {
    variants = urlVariants(url.trim());
  } catch {
    return { valid: false, provider: "twilio", reason: "missing_url", received: provided, message: `"${url}" is not an absolute URL.` };
  }
  // The URL exactly as given always comes first, even if the URL parser would normalise it.
  if (variants[0]?.url !== url.trim()) variants.unshift({ url: url.trim(), deltas: [] });

  // JSON webhooks (Conversations, Studio): Twilio appends bodySHA256 to the URL and signs the URL alone.
  const declaredHash = new URL(url.trim()).searchParams.get("bodySHA256");
  let paramSets: { entries: ReturnType<typeof parseFormBody>; arraySort: boolean }[];
  if (declaredHash !== null) {
    const computedHash = createHash("sha256").update(body, "utf8").digest("hex");
    if (computedHash !== declaredHash) {
      return {
        valid: false,
        provider: "twilio",
        reason: "body_hash_mismatch",
        received: provided,
        expected: computedHash,
        message: `The body does not match the bodySHA256 in the URL (computed ${computedHash}): the body changed after Twilio sent it.`,
      };
    }
    paramSets = [{ entries: [], arraySort: false }];
  } else {
    const entries = parseFormBody(body);
    paramSets = [{ entries, arraySort: false }];
    if (hasRepeatedKeys(entries)) paramSets.push({ entries, arraySort: true });
  }

  const secrets: { secret: string; trimmed: boolean }[] = [{ secret, trimmed: false }];
  if (secret.trim() !== secret) secrets.push({ secret: secret.trim(), trimmed: true });

  let expected = "";
  for (const s of secrets) {
    for (const v of variants) {
      for (const set of paramSets) {
        const sig = hmac("sha1", s.secret, Buffer.from(buildCanonical(v.url, set.entries, set.arraySort), "utf-8"), "base64");
        const deltas: (UrlDelta | "arraySort")[] = set.arraySort ? [...v.deltas, "arraySort"] : [...v.deltas];
        if (!expected) expected = sig;
        if (!safeEqual(sig, provided)) continue;
        if (!s.trimmed && deltas.length === 0) {
          return { valid: true, provider: "twilio", expected: sig, received: provided, message: "Valid Twilio signature." };
        }
        if (s.trimmed) {
          return { valid: false, provider: "twilio", reason: "secret_whitespace", expected, received: provided, message: DELTA_MESSAGE.trimSecret };
        }
        const key =
          (["arraySort", "scheme", "port", "query", "slash"] as const).find((d) => deltas.includes(d)) ?? "slash";
        return {
          valid: false,
          provider: "twilio",
          reason: "url_mismatch",
          expected,
          received: provided,
          message: `${TWILIO_DELTA_MESSAGE[key]} Matching URL: ${v.url}`,
        };
      }
    }
  }
  return {
    valid: false,
    provider: "twilio",
    reason: "signature_mismatch",
    expected,
    received: provided,
    message:
      "Signature mismatch for every URL variant tried (scheme, port, query, trailing slash): the Auth Token is wrong (subaccount, rotated or test credentials) or the params changed before validation.",
  };
}

function verifyDiscord(
  publicKey: string,
  rawBody: Bytes,
  headers: Record<string, string>,
  tolerance: number,
  now: number,
): VerifyResult {
  const sig = header(headers, "x-signature-ed25519");
  const tsRaw = header(headers, "x-signature-timestamp");
  if (!sig) return { valid: false, provider: "discord", reason: "missing_signature", message: "No X-Signature-Ed25519 header in the request." };
  if (!tsRaw) return { valid: false, provider: "discord", reason: "missing_timestamp", received: sig, message: "No X-Signature-Timestamp header in the request." };
  if (!/^[0-9a-fA-F]{128}$/.test(sig)) {
    return { valid: false, provider: "discord", reason: "malformed_signature", received: sig, message: "X-Signature-Ed25519 should be 64 bytes of hex." };
  }
  let key: KeyObject;
  try {
    key = ed25519PublicKey(publicKey);
  } catch {
    return {
      valid: false,
      provider: "discord",
      reason: "invalid_secret",
      received: sig,
      message: "The secret must be the application PUBLIC key: 64 hex chars from the Discord developer portal (General Information).",
    };
  }
  const sigBytes = Buffer.from(sig, "hex");
  const check = (body: Bytes) => cryptoVerify(null, concatBytes(tsRaw, body), key, sigBytes);
  const ts = /^\d+$/.test(tsRaw) ? Number(tsRaw) : null;
  const timestamp = ts !== null ? { timestamp: { value: ts, ageSeconds: now - ts } } : {};
  if (check(rawBody)) {
    if (ts !== null && tolerance > 0 && Math.abs(now - ts) > tolerance) {
      return {
        valid: false,
        provider: "discord",
        reason: "timestamp_out_of_tolerance",
        received: sig,
        ...timestamp,
        message: `The signature is correct but its timestamp is ${now - ts}s old (tolerance ${tolerance}s).`,
      };
    }
    return { valid: true, provider: "discord", received: sig, ...timestamp, message: "Valid Discord signature." };
  }
  for (const v of bodyVariants(bodyToString(rawBody))) {
    if (v.delta && check(v.body)) {
      return { valid: false, provider: "discord", reason: DELTA_REASON[v.delta], received: sig, ...timestamp, message: DELTA_MESSAGE[v.delta] };
    }
  }
  return {
    valid: false,
    provider: "discord",
    reason: "signature_mismatch",
    received: sig,
    ...timestamp,
    message: "Signature mismatch: wrong application public key, or the body changed before verification (verify the raw body).",
  };
}
