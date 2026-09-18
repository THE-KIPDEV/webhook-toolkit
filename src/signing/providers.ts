/**
 * Catalog of the signature schemes `sign()` and `verify()` understand, with realistic
 * sample events so `sign("stripe", { secret })` works without a payload.
 * Samples mirror the ones used on https://webhook-toolkit.com/signer.
 */

export type SignatureProvider =
  | "stripe"
  | "github"
  | "shopify"
  | "slack"
  | "twilio"
  | "mailgun"
  | "svix"
  | "paddle"
  | "discord";

export interface SampleEvent {
  event: string;
  payload: unknown;
}

export interface SignatureProviderInfo {
  id: SignatureProvider;
  label: string;
  /** `json` bodies are `JSON.stringify(payload)`, `form` bodies are urlencoded. */
  format: "json" | "form";
  /** Header(s) carrying the signature. */
  signatureHeader: string;
  algorithm: string;
  /** What `secret` means for this provider. */
  secretHint: string;
  /** Other services signing the same way. */
  compatible?: readonly string[];
  docs: string;
  /** Sample events, the first one is the default. */
  samples: readonly SampleEvent[];
}

const STRIPE_EVENT = (type: string, object: Record<string, unknown>) => ({
  id: "evt_test_webhook",
  object: "event",
  type,
  data: { object },
});

export const SIGNATURE_PROVIDERS: readonly SignatureProviderInfo[] = [
  {
    id: "stripe",
    label: "Stripe",
    format: "json",
    signatureHeader: "Stripe-Signature",
    algorithm: 'HMAC-SHA256 hex of "<t>.<body>"',
    secretHint: "Endpoint signing secret, whsec_… (Dashboard → Developers → Webhooks, or `stripe listen`)",
    docs: "https://docs.stripe.com/webhooks#verify-events",
    samples: [
      {
        event: "payment_intent.succeeded",
        payload: STRIPE_EVENT("payment_intent.succeeded", {
          id: "pi_3KExample",
          object: "payment_intent",
          amount: 2000,
          currency: "eur",
          status: "succeeded",
          customer: "cus_Example",
        }),
      },
      {
        event: "checkout.session.completed",
        payload: STRIPE_EVENT("checkout.session.completed", {
          id: "cs_test_Example",
          object: "checkout.session",
          amount_total: 1490,
          currency: "eur",
          customer_email: "client@example.com",
          payment_status: "paid",
        }),
      },
      {
        event: "customer.subscription.created",
        payload: STRIPE_EVENT("customer.subscription.created", {
          id: "sub_Example",
          object: "subscription",
          customer: "cus_Example",
          status: "active",
        }),
      },
    ],
  },
  {
    id: "github",
    label: "GitHub",
    format: "json",
    signatureHeader: "X-Hub-Signature-256",
    algorithm: "HMAC-SHA256 hex of the body (sha256=…)",
    secretHint: "The webhook secret set in Settings → Webhooks",
    compatible: ["Gitea", "Forgejo"],
    docs: "https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries",
    samples: [
      {
        event: "push",
        payload: {
          ref: "refs/heads/main",
          before: "0000000000000000000000000000000000000000",
          after: "a1b2c3d4e5f6",
          repository: { full_name: "octocat/hello-world" },
          pusher: { name: "octocat", email: "octocat@example.com" },
          head_commit: { id: "a1b2c3d4e5f6", message: "Update README" },
        },
      },
      {
        event: "pull_request",
        payload: {
          action: "opened",
          number: 42,
          pull_request: { id: 1, title: "Add feature", state: "open" },
          repository: { full_name: "octocat/hello-world" },
        },
      },
      {
        event: "issues",
        payload: {
          action: "opened",
          issue: { number: 7, title: "Bug report", state: "open" },
          repository: { full_name: "octocat/hello-world" },
        },
      },
    ],
  },
  {
    id: "shopify",
    label: "Shopify",
    format: "json",
    signatureHeader: "X-Shopify-Hmac-Sha256",
    algorithm: "HMAC-SHA256 base64 of the body",
    secretHint: "The app's client secret (API secret key)",
    docs: "https://shopify.dev/docs/apps/build/webhooks/subscribe/https",
    samples: [
      {
        event: "orders/create",
        payload: {
          id: 820982911946154500,
          email: "jon@example.com",
          total_price: "29.90",
          currency: "EUR",
          financial_status: "paid",
          line_items: [{ title: "T-Shirt", quantity: 1, price: "29.90" }],
        },
      },
      {
        event: "products/update",
        payload: { id: 788032119674292900, title: "Updated product", vendor: "Acme", status: "active" },
      },
    ],
  },
  {
    id: "slack",
    label: "Slack",
    format: "json",
    signatureHeader: "X-Slack-Signature",
    algorithm: 'HMAC-SHA256 hex of "v0:<timestamp>:<body>"',
    secretHint: "App credentials → Signing Secret",
    docs: "https://api.slack.com/authentication/verifying-requests-from-slack",
    samples: [
      {
        event: "event_callback",
        payload: {
          token: "verification-token",
          team_id: "T0001",
          type: "event_callback",
          event: { type: "message", user: "U0001", text: "Hello from Webhook Toolkit", channel: "C0001" },
        },
      },
      {
        event: "url_verification",
        payload: {
          type: "url_verification",
          token: "verification-token",
          challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
        },
      },
    ],
  },
  {
    id: "twilio",
    label: "Twilio",
    format: "form",
    signatureHeader: "X-Twilio-Signature",
    algorithm: "HMAC-SHA1 base64 of URL + sorted(key + value)",
    secretHint: "Account Auth Token (Console → Account). Also needs the exact public URL Twilio calls.",
    docs: "https://www.twilio.com/docs/usage/webhooks/webhooks-security",
    samples: [
      {
        event: "sms_inbound",
        payload: {
          MessageSid: "SM1234567890abcdef",
          AccountSid: "AC1234567890abcdef",
          From: "+33600000000",
          To: "+33700000000",
          Body: "Hello from Webhook Toolkit",
          NumMedia: "0",
        },
      },
      {
        event: "voice_inbound",
        payload: {
          CallSid: "CA1234567890abcdef",
          AccountSid: "AC1234567890abcdef",
          From: "+33600000000",
          To: "+33700000000",
          CallStatus: "ringing",
          Direction: "inbound",
        },
      },
    ],
  },
  {
    id: "mailgun",
    label: "Mailgun",
    format: "json",
    signatureHeader: "signature.signature (in the body)",
    algorithm: 'HMAC-SHA256 hex of "<timestamp><token>"',
    secretHint: "HTTP webhook signing key (Settings → Webhooks)",
    docs: "https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks",
    samples: [
      {
        event: "delivered",
        payload: {
          "event-data": {
            event: "delivered",
            recipient: "client@example.com",
            message: { headers: { "message-id": "<example@mg>" } },
          },
        },
      },
      {
        event: "failed",
        payload: {
          "event-data": { event: "failed", severity: "permanent", recipient: "bounce@example.com", reason: "bounce" },
        },
      },
    ],
  },
  {
    id: "svix",
    label: "Svix / Standard Webhooks",
    format: "json",
    signatureHeader: "svix-signature / webhook-signature",
    algorithm: 'HMAC-SHA256 base64 of "<id>.<timestamp>.<body>", key = base64-decoded secret',
    secretHint: "whsec_… signing secret (Clerk, Resend, Svix dashboard)",
    compatible: ["Clerk", "Resend", "Standard Webhooks"],
    docs: "https://docs.svix.com/receiving/verifying-payloads/how-manual",
    samples: [
      {
        event: "user.created",
        payload: {
          type: "user.created",
          object: "event",
          data: { id: "user_2Example", email_addresses: [{ email_address: "jane@example.com" }] },
        },
      },
      {
        event: "email.delivered",
        payload: {
          type: "email.delivered",
          created_at: "2026-01-01T00:00:00.000Z",
          data: { email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", to: ["jane@example.com"], subject: "Hello" },
        },
      },
    ],
  },
  {
    id: "paddle",
    label: "Paddle Billing",
    format: "json",
    signatureHeader: "Paddle-Signature",
    algorithm: 'HMAC-SHA256 hex of "<ts>:<body>"',
    secretHint: "Notification destination secret key, pdl_ntfset_…",
    docs: "https://developer.paddle.com/webhooks/signature-verification",
    samples: [
      {
        event: "transaction.completed",
        payload: {
          event_id: "evt_01hExample",
          event_type: "transaction.completed",
          occurred_at: "2026-01-01T00:00:00.000000Z",
          notification_id: "ntf_01hExample",
          data: { id: "txn_01hExample", status: "completed", currency_code: "EUR" },
        },
      },
    ],
  },
  {
    id: "discord",
    label: "Discord interactions",
    format: "json",
    signatureHeader: "X-Signature-Ed25519",
    algorithm: 'Ed25519 over "<timestamp><body>"',
    secretHint: "verify: the application PUBLIC key (hex). sign: a test Ed25519 private key (hex seed or PEM).",
    docs: "https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint-validating-security-request-headers",
    samples: [{ event: "PING", payload: { id: "1234567890", application_id: "1234567890", type: 1, version: 1 } }],
  },
];

export const SIGNATURE_PROVIDER_IDS: readonly SignatureProvider[] = SIGNATURE_PROVIDERS.map((p) => p.id);

const ALIASES: Record<string, SignatureProvider> = {
  "standard-webhooks": "svix",
  standardwebhooks: "svix",
  clerk: "svix",
  resend: "svix",
  "paddle-billing": "paddle",
};

/** Looks a provider up by id (case-insensitive). `clerk`, `resend` and `standard-webhooks` resolve to `svix`. */
export function getSignatureProvider(id: string): SignatureProviderInfo | undefined {
  const key = id.trim().toLowerCase();
  const resolved = ALIASES[key] ?? key;
  return SIGNATURE_PROVIDERS.find((p) => p.id === resolved);
}
