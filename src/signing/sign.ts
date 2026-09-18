import { randomBytes, randomUUID, sign as cryptoSign } from "node:crypto";
import { WebhookToolkitError } from "../errors.js";
import { bodyToString, decodeSvixSecret, ed25519PrivateKey, hmac, toUnixSeconds } from "./crypto.js";
import { getSignatureProvider, SIGNATURE_PROVIDER_IDS, type SignatureProvider, type SignatureProviderInfo } from "./providers.js";
import { buildCanonical, parseFormBody, type ParamEntry } from "./twilio.js";

export interface SignOptions {
  /** Signing secret (see `SIGNATURE_PROVIDERS[i].secretHint` for what it is per provider). */
  secret: string;
  /**
   * The event body. Objects are serialised with `JSON.stringify` (Twilio: urlencoded params).
   * Strings and bytes are sent verbatim, which is what you want to reproduce a real delivery.
   * Omitted: a realistic sample for `event` (or the provider's default event).
   */
  payload?: unknown;
  /** Event type: sets `X-GitHub-Event` / `X-Shopify-Topic`, and picks or patches the sample payload. */
  event?: string;
  /** Unix seconds (or a Date). Defaults to now. */
  timestamp?: number | Date;
  /** Twilio only (required): the exact public URL Twilio will call, query string included. */
  url?: string;
  /** Delivery id: `svix-id`, `X-GitHub-Delivery`, `X-Shopify-Webhook-Id`, Mailgun token. Random when omitted. */
  id?: string;
}

export interface SignedWebhook {
  provider: SignatureProvider;
  method: "POST";
  /** Ready to send: signature headers plus `Content-Type`. */
  headers: Record<string, string>;
  body: string;
  contentType: string;
  event: string | null;
  /** Unix seconds used in the signature. */
  timestamp: number;
}

const JSON_CT = "application/json";
const FORM_CT = "application/x-www-form-urlencoded";

function invalid(message: string): WebhookToolkitError {
  return new WebhookToolkitError(message, { code: "invalid_input" });
}

function resolveProvider(provider: string): SignatureProviderInfo {
  const info = getSignatureProvider(provider);
  if (!info) throw invalid(`Unknown provider "${provider}". Supported: ${SIGNATURE_PROVIDER_IDS.join(", ")}.`);
  return info;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Where each provider keeps the event type inside its JSON body. */
function setEventField(provider: SignatureProvider, payload: Record<string, unknown>, event: string): void {
  switch (provider) {
    case "stripe":
    case "svix":
      payload.type = event;
      break;
    case "paddle":
      payload.event_type = event;
      break;
    case "mailgun": {
      const data = payload["event-data"];
      if (data && typeof data === "object") (data as Record<string, unknown>).event = event;
      break;
    }
    default:
      break;
  }
}

function readEventField(provider: SignatureProvider, payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  switch (provider) {
    case "stripe":
    case "svix":
    case "slack":
      return str(p.type);
    case "paddle":
      return str(p.event_type);
    case "mailgun":
      return str((p["event-data"] as Record<string, unknown> | undefined)?.event);
    default:
      return null;
  }
}

/** Payload + event, falling back to the catalog samples. */
function resolvePayload(info: SignatureProviderInfo, opts: SignOptions): { payload: unknown; event: string | null } {
  if (opts.payload !== undefined) {
    let parsed: unknown = opts.payload;
    if (typeof parsed === "string" && info.format === "json") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        /* raw non-JSON string: sent verbatim */
      }
    }
    return { payload: opts.payload, event: opts.event ?? readEventField(info.id, parsed) };
  }
  const sample = (opts.event && info.samples.find((s) => s.event === opts.event)) || info.samples[0];
  if (!sample) throw invalid(`No sample payload for ${info.id}: pass payload.`);
  const payload = clone(sample.payload);
  const event = opts.event ?? sample.event;
  if (opts.event && sample.event !== opts.event && payload && typeof payload === "object") {
    setEventField(info.id, payload as Record<string, unknown>, opts.event);
  }
  return { payload, event };
}

function serializeJson(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) return bodyToString(payload);
  const json = JSON.stringify(payload);
  if (json === undefined) throw invalid("payload is not JSON-serialisable");
  return json;
}

/** Twilio params from an object (`{ Body: "hi" }`, arrays = repeated keys) or an urlencoded string. */
function twilioParams(payload: unknown): { entries: ParamEntry[]; body: string } {
  if (typeof payload === "string" || payload instanceof Uint8Array) {
    const body = bodyToString(payload);
    return { entries: parseFormBody(body), body };
  }
  if (!payload || typeof payload !== "object") throw invalid("Twilio payload must be an object of form params or an urlencoded string");
  const entries: ParamEntry[] = [];
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) search.append(key, String(v));
    // Twilio's own coercion: arrays become "a,b" in the signed string.
    entries.push([key, String(value)]);
  }
  return { entries, body: search.toString() };
}

function randomSvixId(): string {
  return "msg_" + randomBytes(18).toString("base64url").replace(/[-_]/g, "").slice(0, 24);
}

/**
 * Builds a request body plus valid signature headers, byte-for-byte what the provider
 * would send. Use it to exercise your webhook handler without triggering a real event.
 *
 * ```ts
 * const { headers, body } = sign("stripe", { secret: "whsec_…", payload: event });
 * await fetch("http://localhost:3000/webhooks/stripe", { method: "POST", headers, body });
 * ```
 */
export function sign(provider: SignatureProvider | (string & {}), opts: SignOptions): SignedWebhook {
  const info = resolveProvider(provider);
  if (typeof opts?.secret !== "string" || opts.secret === "") throw invalid(`${info.label}: secret is required (${info.secretHint}).`);
  const secret = opts.secret;
  const ts = toUnixSeconds(opts.timestamp);
  const { payload, event } = resolvePayload(info, opts);
  const result = (body: string, contentType: string, headers: Record<string, string>): SignedWebhook => ({
    provider: info.id,
    method: "POST",
    headers: { "Content-Type": contentType, ...headers },
    body,
    contentType,
    event,
    timestamp: ts,
  });

  switch (info.id) {
    case "stripe": {
      const body = serializeJson(payload);
      const v1 = hmac("sha256", secret, `${ts}.${body}`, "hex");
      return result(body, JSON_CT, { "Stripe-Signature": `t=${ts},v1=${v1}` });
    }
    case "github": {
      const body = serializeJson(payload);
      return result(body, JSON_CT, {
        "X-Hub-Signature-256": `sha256=${hmac("sha256", secret, body, "hex")}`,
        "X-Hub-Signature": `sha1=${hmac("sha1", secret, body, "hex")}`,
        "X-GitHub-Event": event ?? "push",
        "X-GitHub-Delivery": opts.id ?? randomUUID(),
        "User-Agent": "GitHub-Hookshot/webhook-toolkit",
      });
    }
    case "shopify": {
      const body = serializeJson(payload);
      return result(body, JSON_CT, {
        "X-Shopify-Hmac-Sha256": hmac("sha256", secret, body, "base64"),
        "X-Shopify-Topic": event ?? "orders/create",
        "X-Shopify-Shop-Domain": "example.myshopify.com",
        "X-Shopify-Webhook-Id": opts.id ?? randomUUID(),
      });
    }
    case "slack": {
      const body = serializeJson(payload);
      const sig = hmac("sha256", secret, `v0:${ts}:${body}`, "hex");
      return result(body, JSON_CT, { "X-Slack-Signature": `v0=${sig}`, "X-Slack-Request-Timestamp": String(ts) });
    }
    case "mailgun": {
      // Mailgun signs "<timestamp><token>" and puts the signature inside the body.
      const token = opts.id ?? randomBytes(16).toString("hex");
      const signature = hmac("sha256", secret, `${ts}${token}`, "hex");
      let obj: unknown = payload;
      if (typeof obj === "string") {
        try {
          obj = JSON.parse(obj);
        } catch {
          throw invalid("Mailgun payload must be a JSON object (the signature is embedded in it)");
        }
      }
      const payloadObj = obj && typeof obj === "object" ? { ...(obj as object) } : {};
      const body = JSON.stringify({ signature: { timestamp: String(ts), token, signature }, ...payloadObj });
      return result(body, JSON_CT, {});
    }
    case "twilio": {
      if (!opts.url) throw invalid("Twilio signs the full public URL it calls: pass `url` (e.g. https://example.com/twilio/sms).");
      const { entries, body } = twilioParams(payload);
      const sig = hmac("sha1", secret, Buffer.from(buildCanonical(opts.url, entries), "utf-8"), "base64");
      return result(body, FORM_CT, { "X-Twilio-Signature": sig });
    }
    case "svix": {
      const key = decodeSvixSecret(secret);
      if (!key) throw invalid("Svix / Standard Webhooks secrets are base64, usually prefixed with whsec_.");
      const body = serializeJson(payload);
      const id = opts.id ?? randomSvixId();
      const sig = `v1,${hmac("sha256", key, `${id}.${ts}.${body}`, "base64")}`;
      // Both header families: Svix SDKs (Clerk, Resend) read svix-*, Standard Webhooks libraries read webhook-*.
      return result(body, JSON_CT, {
        "svix-id": id,
        "svix-timestamp": String(ts),
        "svix-signature": sig,
        "webhook-id": id,
        "webhook-timestamp": String(ts),
        "webhook-signature": sig,
      });
    }
    case "paddle": {
      const body = serializeJson(payload);
      const h1 = hmac("sha256", secret, `${ts}:${body}`, "hex");
      return result(body, JSON_CT, { "Paddle-Signature": `ts=${ts};h1=${h1}` });
    }
    case "discord": {
      let key;
      try {
        key = ed25519PrivateKey(secret);
      } catch {
        throw invalid("Discord signing needs an Ed25519 PRIVATE key (32-byte hex seed or PEM). Discord never shares its own: use a test key pair.");
      }
      const body = serializeJson(payload);
      const sig = cryptoSign(null, Buffer.from(`${ts}${body}`, "utf8"), key).toString("hex");
      return result(body, JSON_CT, { "X-Signature-Ed25519": sig, "X-Signature-Timestamp": String(ts) });
    }
  }
}
