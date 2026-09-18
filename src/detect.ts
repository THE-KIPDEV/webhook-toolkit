import { toHeaderRecord, type HeadersLike } from "./headers.js";

export interface DetectedProvider {
  /** e.g. `"stripe"`, `"github"`, or `null` when nothing matched. */
  provider: string | null;
  /** e.g. `"checkout.session.completed"`, `"push"`, or `null` when unknown. */
  event: string | null;
}

/** Read-only view of a request the rules run against. Parsing is lazy and cached. */
export interface DetectionContext {
  header(name: string): string | undefined;
  json(path: string): unknown;
  form(name: string): string | undefined;
}

/** All conditions of one clause must hold. */
export interface DetectionClause {
  /** Header names that must all be present. */
  headers?: readonly string[];
  /** Tested against `User-Agent`. */
  userAgent?: RegExp;
  /** Dot paths that must all exist in the JSON body (`"0.event"` indexes arrays). */
  json?: readonly string[];
  /** Fields that must all exist in the urlencoded body. */
  form?: readonly string[];
}

export type EventSource =
  | { header: string }
  | { json: string }
  | { form: string }
  | { fn: (ctx: DetectionContext) => string | null | undefined };

export interface DetectionRule {
  provider: string;
  label: string;
  /** The rule matches when ANY clause holds. Rules are tried in order. */
  when: readonly DetectionClause[];
  /** First source yielding a non-empty string wins. */
  event?: readonly EventSource[];
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;

const join = (...parts: (string | null | undefined)[]): string | null => {
  const kept = parts.filter((p): p is string => typeof p === "string" && p !== "");
  return kept.length > 0 ? kept.join(".") : null;
};

const DISCORD_INTERACTIONS: Record<number, string> = {
  1: "PING",
  2: "APPLICATION_COMMAND",
  3: "MESSAGE_COMPONENT",
  4: "APPLICATION_COMMAND_AUTOCOMPLETE",
  5: "MODAL_SUBMIT",
};

function redsysEvent(ctx: DetectionContext): string | null {
  const encoded = ctx.form("Ds_MerchantParameters") ?? str(ctx.json("Ds_MerchantParameters"));
  if (!encoded) return null;
  try {
    const params = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
    const code = Number.parseInt(String(params.Ds_Response ?? ""), 10);
    if (Number.isNaN(code)) return null;
    if (code >= 0 && code <= 99) return "payment.authorized";
    if (code === 900) return "refund.authorized";
    if (code === 400) return "cancellation.authorized";
    return "payment.denied";
  } catch {
    return null;
  }
}

/**
 * The detection table. Ordered: specific signatures first, loose body heuristics last.
 * Contributions welcome: one entry + one test fixture per provider.
 */
export const DETECTION_RULES: readonly DetectionRule[] = [
  { provider: "stripe", label: "Stripe", when: [{ headers: ["stripe-signature"] }], event: [{ json: "type" }] },
  {
    provider: "github",
    label: "GitHub",
    when: [{ headers: ["x-github-event"] }],
    event: [{ header: "x-github-event" }],
  },
  {
    provider: "gitlab",
    label: "GitLab",
    when: [{ headers: ["x-gitlab-event"] }],
    event: [{ json: "object_kind" }, { header: "x-gitlab-event" }],
  },
  {
    provider: "bitbucket",
    label: "Bitbucket",
    when: [{ headers: ["x-event-key", "x-hook-uuid"] }, { headers: ["x-event-key"], userAgent: /Bitbucket/i }],
    event: [{ header: "x-event-key" }],
  },
  {
    provider: "shopify",
    label: "Shopify",
    when: [{ headers: ["x-shopify-topic"] }, { headers: ["x-shopify-hmac-sha256"] }],
    event: [{ header: "x-shopify-topic" }],
  },
  {
    provider: "woocommerce",
    label: "WooCommerce",
    when: [{ headers: ["x-wc-webhook-topic"] }],
    event: [{ header: "x-wc-webhook-topic" }],
  },
  {
    provider: "slack",
    label: "Slack",
    when: [{ headers: ["x-slack-signature"] }],
    event: [
      { json: "event.type" },
      { json: "type" },
      { form: "command" },
      { fn: (ctx) => { const p = ctx.form("payload"); try { return p ? str((JSON.parse(p) as { type?: unknown }).type) : null; } catch { return null; } } },
    ],
  },
  {
    provider: "sendgrid",
    label: "SendGrid",
    when: [{ headers: ["x-twilio-email-event-webhook-signature"] }, { userAgent: /SendGrid/i }],
    event: [{ json: "0.event" }],
  },
  {
    provider: "twilio",
    label: "Twilio",
    when: [{ headers: ["x-twilio-signature"] }],
    event: [
      { fn: (ctx) => { const s = ctx.form("CallStatus"); return s ? `call.${s}` : null; } },
      { fn: (ctx) => { const s = ctx.form("MessageStatus") ?? ctx.form("SmsStatus"); return s ? `message.${s}` : null; } },
      { form: "EventType" },
      { json: "EventType" },
    ],
  },
  {
    provider: "paddle",
    label: "Paddle",
    when: [{ headers: ["paddle-signature"] }, { form: ["p_signature", "alert_name"] }],
    event: [{ json: "event_type" }, { form: "alert_name" }],
  },
  {
    provider: "svix",
    label: "Svix / Standard Webhooks",
    when: [{ headers: ["svix-id"] }, { headers: ["webhook-id", "webhook-signature"] }],
    event: [{ json: "type" }, { json: "eventType" }, { json: "event_type" }],
  },
  {
    provider: "gocardless",
    label: "GoCardless",
    when: [{ headers: ["webhook-signature"], json: ["events.0.resource_type"] }],
    event: [{ fn: (ctx) => join(str(ctx.json("events.0.resource_type")), str(ctx.json("events.0.action"))) }],
  },
  {
    provider: "paypal",
    label: "PayPal",
    when: [{ headers: ["paypal-transmission-id"] }],
    event: [{ json: "event_type" }],
  },
  {
    provider: "discord",
    label: "Discord",
    when: [{ headers: ["x-signature-ed25519"] }],
    event: [
      { json: "event.type" },
      { fn: (ctx) => { const t = ctx.json("type"); return typeof t === "number" ? (DISCORD_INTERACTIONS[t] ?? (t === 0 ? "PING" : null)) : null; } },
    ],
  },
  {
    provider: "linear",
    label: "Linear",
    when: [{ headers: ["linear-signature"] }, { headers: ["linear-delivery"] }],
    event: [{ fn: (ctx) => join(str(ctx.json("type")) ?? ctx.header("linear-event"), str(ctx.json("action"))) }],
  },
  { provider: "typeform", label: "Typeform", when: [{ headers: ["typeform-signature"] }], event: [{ json: "event_type" }] },
  { provider: "calendly", label: "Calendly", when: [{ headers: ["calendly-webhook-signature"] }], event: [{ json: "event" }] },
  {
    provider: "square",
    label: "Square",
    when: [{ headers: ["x-square-hmacsha256-signature"] }, { headers: ["x-square-signature"] }],
    event: [{ json: "type" }],
  },
  {
    provider: "hubspot",
    label: "HubSpot",
    when: [{ headers: ["x-hubspot-signature-v3"] }, { headers: ["x-hubspot-signature"] }],
    event: [{ json: "0.subscriptionType" }, { json: "subscriptionType" }],
  },
  { provider: "zoom", label: "Zoom", when: [{ headers: ["x-zm-signature"] }], event: [{ json: "event" }] },
  {
    provider: "lemonsqueezy",
    label: "Lemon Squeezy",
    when: [{ headers: ["x-event-name", "x-signature"] }],
    event: [{ header: "x-event-name" }, { json: "meta.event_name" }],
  },
  { provider: "coinbase", label: "Coinbase Commerce", when: [{ headers: ["x-cc-webhook-signature"] }], event: [{ json: "event.type" }] },
  {
    provider: "twitch",
    label: "Twitch EventSub",
    when: [{ headers: ["twitch-eventsub-message-type"] }],
    event: [{ json: "subscription.type" }, { header: "twitch-eventsub-message-type" }],
  },
  { provider: "mux", label: "Mux", when: [{ headers: ["mux-signature"] }], event: [{ json: "type" }] },
  { provider: "vercel", label: "Vercel", when: [{ headers: ["x-vercel-signature"] }], event: [{ json: "type" }] },
  { provider: "netlify", label: "Netlify", when: [{ headers: ["x-netlify-event"] }], event: [{ header: "x-netlify-event" }] },
  {
    provider: "sentry",
    label: "Sentry",
    when: [{ headers: ["sentry-hook-resource"] }],
    event: [{ fn: (ctx) => join(ctx.header("sentry-hook-resource"), str(ctx.json("action"))) }],
  },
  { provider: "trello", label: "Trello", when: [{ headers: ["x-trello-webhook"] }], event: [{ json: "action.type" }] },
  {
    provider: "plaid",
    label: "Plaid",
    when: [{ headers: ["plaid-verification"] }],
    event: [{ fn: (ctx) => join(str(ctx.json("webhook_type")), str(ctx.json("webhook_code"))) }],
  },
  {
    provider: "mandrill",
    label: "Mandrill",
    when: [{ headers: ["x-mandrill-signature"] }],
    event: [
      { fn: (ctx) => { const e = ctx.form("mandrill_events"); try { return e ? str((JSON.parse(e) as { event?: unknown }[])[0]?.event) : null; } catch { return null; } } },
    ],
  },
  { provider: "jira", label: "Jira", when: [{ json: ["webhookEvent"], userAgent: /Atlassian/i }], event: [{ json: "webhookEvent" }] },
  { provider: "postmark", label: "Postmark", when: [{ userAgent: /Postmark/i }], event: [{ json: "RecordType" }] },
  { provider: "mollie", label: "Mollie", when: [{ userAgent: /Mollie/i }], event: [] },
  {
    provider: "adyen",
    label: "Adyen",
    when: [{ json: ["notificationItems.0.NotificationRequestItem"] }],
    event: [{ json: "notificationItems.0.NotificationRequestItem.eventCode" }],
  },
  {
    provider: "mailgun",
    label: "Mailgun",
    when: [{ json: ["signature.token", "signature.signature"] }, { form: ["token", "signature", "timestamp"] }],
    event: [{ json: "event-data.event" }, { form: "event" }],
  },
  {
    provider: "redsys",
    label: "Redsys",
    when: [{ form: ["Ds_SignatureVersion"] }, { json: ["Ds_SignatureVersion"] }],
    event: [{ fn: redsysEvent }],
  },
];

/** Every provider id `detectProvider` can return. */
export const DETECTABLE_PROVIDERS: readonly string[] = [...new Set(DETECTION_RULES.map((r) => r.provider))];

const FORM_LIKE = /^[\w.%+\-[\]]+=[^&]*(&[\w.%+\-[\]]+=[^&]*)*$/;

function createContext(headers: Record<string, string>, body: string): DetectionContext {
  let jsonCache: { value: unknown } | undefined;
  let formCache: { value: URLSearchParams | null } | undefined;
  const contentType = headers["content-type"] ?? "";

  const parsedJson = (): unknown => {
    if (!jsonCache) {
      let value: unknown;
      const trimmed = body.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          value = JSON.parse(body);
        } catch {
          value = undefined;
        }
      }
      jsonCache = { value };
    }
    return jsonCache.value;
  };
  const parsedForm = (): URLSearchParams | null => {
    if (!formCache) {
      const looksForm = contentType.includes("application/x-www-form-urlencoded") || (!contentType && FORM_LIKE.test(body.trim()));
      formCache = { value: looksForm && body ? new URLSearchParams(body.trim()) : null };
    }
    return formCache.value;
  };

  return {
    header: (name) => headers[name.toLowerCase()],
    json: (path) => {
      let cur: unknown = parsedJson();
      for (const seg of path.split(".")) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg];
      }
      return cur;
    },
    form: (name) => parsedForm()?.get(name) ?? undefined,
  };
}

function clauseHolds(ctx: DetectionContext, clause: DetectionClause): boolean {
  if (clause.headers && !clause.headers.every((h) => ctx.header(h) !== undefined)) return false;
  if (clause.userAgent && !clause.userAgent.test(ctx.header("user-agent") ?? "")) return false;
  if (clause.json && !clause.json.every((p) => ctx.json(p) !== undefined)) return false;
  if (clause.form && !clause.form.every((f) => ctx.form(f) !== undefined)) return false;
  return true;
}

function readEvent(ctx: DetectionContext, sources: readonly EventSource[] | undefined): string | null {
  for (const src of sources ?? []) {
    let value: unknown;
    if ("header" in src) value = ctx.header(src.header);
    else if ("json" in src) value = ctx.json(src.json);
    else if ("form" in src) value = ctx.form(src.form);
    else value = src.fn(ctx);
    const s = str(value);
    if (s) return s;
  }
  return null;
}

/**
 * Guesses which service sent a webhook, and the event type, from its headers and body.
 *
 * ```ts
 * detectProvider(req.headers, rawBody) // → { provider: "stripe", event: "invoice.paid" }
 * ```
 */
export function detectProvider(headers: HeadersLike, body?: string | Uint8Array | null): DetectedProvider {
  const h = toHeaderRecord(headers);
  const text = body == null ? "" : typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  const ctx = createContext(h, text);
  for (const rule of DETECTION_RULES) {
    if (rule.when.some((clause) => clauseHolds(ctx, clause))) {
      return { provider: rule.provider, event: readEvent(ctx, rule.event) };
    }
  }
  return { provider: null, event: null };
}
