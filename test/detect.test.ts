import assert from "node:assert/strict";
import { test } from "node:test";
import { DETECTABLE_PROVIDERS, detectProvider } from "../src/index.js";

const JSON_CT = { "content-type": "application/json" };
const FORM_CT = { "content-type": "application/x-www-form-urlencoded" };
const redsysParams = (code: string) => Buffer.from(JSON.stringify({ Ds_Order: "1234", Ds_Response: code })).toString("base64");

/** One realistic fixture per provider: [headers, body, expected provider, expected event]. */
const FIXTURES: [string, Record<string, string>, string, string | null][] = [
  ["stripe", { ...JSON_CT, "Stripe-Signature": "t=1,v1=abc" }, '{"type":"checkout.session.completed"}', "checkout.session.completed"],
  ["github", { ...JSON_CT, "X-GitHub-Event": "push", "X-Hub-Signature-256": "sha256=x" }, '{"ref":"refs/heads/main"}', "push"],
  ["gitlab", { ...JSON_CT, "X-Gitlab-Event": "Merge Request Hook" }, '{"object_kind":"merge_request"}', "merge_request"],
  ["bitbucket", { ...JSON_CT, "X-Event-Key": "repo:push", "X-Hook-UUID": "u" }, "{}", "repo:push"],
  ["shopify", { ...JSON_CT, "X-Shopify-Topic": "orders/create", "X-Shopify-Hmac-Sha256": "x" }, "{}", "orders/create"],
  ["woocommerce", { ...JSON_CT, "X-WC-Webhook-Topic": "order.created" }, "{}", "order.created"],
  ["slack", { ...JSON_CT, "X-Slack-Signature": "v0=x" }, '{"type":"event_callback","event":{"type":"app_mention"}}', "app_mention"],
  ["slack", { ...FORM_CT, "X-Slack-Signature": "v0=x" }, "command=%2Fdeploy&text=prod", "/deploy"],
  ["slack", { ...FORM_CT, "X-Slack-Signature": "v0=x" }, `payload=${encodeURIComponent('{"type":"block_actions"}')}`, "block_actions"],
  ["sendgrid", { ...JSON_CT, "X-Twilio-Email-Event-Webhook-Signature": "x" }, '[{"event":"delivered"}]', "delivered"],
  ["twilio", { ...FORM_CT, "X-Twilio-Signature": "x" }, "MessageSid=SM1&SmsStatus=received&Body=hi", "message.received"],
  ["twilio", { ...FORM_CT, "X-Twilio-Signature": "x" }, "CallSid=CA1&CallStatus=ringing", "call.ringing"],
  ["paddle", { ...JSON_CT, "Paddle-Signature": "ts=1;h1=x" }, '{"event_type":"subscription.created"}', "subscription.created"],
  ["paddle", FORM_CT, "alert_name=payment_succeeded&p_signature=abc", "payment_succeeded"],
  ["svix", { ...JSON_CT, "svix-id": "msg_1", "svix-signature": "v1,x" }, '{"type":"user.created"}', "user.created"],
  ["svix", { ...JSON_CT, "webhook-id": "msg_1", "webhook-signature": "v1,x" }, '{"type":"email.bounced"}', "email.bounced"],
  ["gocardless", { ...JSON_CT, "Webhook-Signature": "x" }, '{"events":[{"resource_type":"payments","action":"confirmed"}]}', "payments.confirmed"],
  ["paypal", { ...JSON_CT, "PAYPAL-TRANSMISSION-ID": "x" }, '{"event_type":"PAYMENT.CAPTURE.COMPLETED"}', "PAYMENT.CAPTURE.COMPLETED"],
  ["discord", { ...JSON_CT, "X-Signature-Ed25519": "x", "X-Signature-Timestamp": "1" }, '{"type":2}', "APPLICATION_COMMAND"],
  ["discord", { ...JSON_CT, "X-Signature-Ed25519": "x" }, '{"type":1,"event":{"type":"APPLICATION_AUTHORIZED"}}', "APPLICATION_AUTHORIZED"],
  ["linear", { ...JSON_CT, "Linear-Signature": "x", "Linear-Event": "Issue" }, '{"type":"Issue","action":"create"}', "Issue.create"],
  ["typeform", { ...JSON_CT, "Typeform-Signature": "sha256=x" }, '{"event_type":"form_response"}', "form_response"],
  ["calendly", { ...JSON_CT, "Calendly-Webhook-Signature": "t=1,v1=x" }, '{"event":"invitee.created"}', "invitee.created"],
  ["square", { ...JSON_CT, "X-Square-HmacSha256-Signature": "x" }, '{"type":"payment.updated"}', "payment.updated"],
  ["hubspot", { ...JSON_CT, "X-HubSpot-Signature-v3": "x" }, '[{"subscriptionType":"contact.creation"}]', "contact.creation"],
  ["zoom", { ...JSON_CT, "x-zm-signature": "v0=x" }, '{"event":"meeting.started"}', "meeting.started"],
  ["lemonsqueezy", { ...JSON_CT, "X-Event-Name": "order_created", "X-Signature": "x" }, "{}", "order_created"],
  ["coinbase", { ...JSON_CT, "X-CC-Webhook-Signature": "x" }, '{"event":{"type":"charge:confirmed"}}', "charge:confirmed"],
  ["twitch", { ...JSON_CT, "Twitch-Eventsub-Message-Type": "notification" }, '{"subscription":{"type":"channel.follow"}}', "channel.follow"],
  ["mux", { ...JSON_CT, "Mux-Signature": "t=1,v1=x" }, '{"type":"video.asset.ready"}', "video.asset.ready"],
  ["vercel", { ...JSON_CT, "x-vercel-signature": "x" }, '{"type":"deployment.succeeded"}', "deployment.succeeded"],
  ["netlify", { ...JSON_CT, "X-Netlify-Event": "deploy_created" }, "{}", "deploy_created"],
  ["sentry", { ...JSON_CT, "Sentry-Hook-Resource": "issue" }, '{"action":"created"}', "issue.created"],
  ["trello", { ...JSON_CT, "X-Trello-Webhook": "x" }, '{"action":{"type":"createCard"}}', "createCard"],
  ["plaid", { ...JSON_CT, "Plaid-Verification": "x" }, '{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE"}', "TRANSACTIONS.SYNC_UPDATES_AVAILABLE"],
  ["mandrill", { ...FORM_CT, "X-Mandrill-Signature": "x" }, `mandrill_events=${encodeURIComponent('[{"event":"open"}]')}`, "open"],
  ["jira", { ...JSON_CT, "User-Agent": "Atlassian Webhook HTTP Client" }, '{"webhookEvent":"jira:issue_created"}', "jira:issue_created"],
  ["postmark", { ...JSON_CT, "User-Agent": "Postmark" }, '{"RecordType":"Bounce"}', "Bounce"],
  ["mollie", { ...FORM_CT, "User-Agent": "Mollie HTTP Client/1.0" }, "id=tr_WDqYK6vllg", null],
  ["adyen", JSON_CT, '{"live":"false","notificationItems":[{"NotificationRequestItem":{"eventCode":"AUTHORISATION"}}]}', "AUTHORISATION"],
  ["mailgun", JSON_CT, '{"signature":{"timestamp":"1","token":"t","signature":"s"},"event-data":{"event":"delivered"}}', "delivered"],
  ["mailgun", FORM_CT, "timestamp=1&token=t&signature=s&event=opened", "opened"],
  ["redsys", FORM_CT, `Ds_SignatureVersion=HMAC_SHA256_V1&Ds_MerchantParameters=${encodeURIComponent(redsysParams("0000"))}&Ds_Signature=x`, "payment.authorized"],
  ["redsys", FORM_CT, `Ds_SignatureVersion=HMAC_SHA256_V1&Ds_MerchantParameters=${encodeURIComponent(redsysParams("0190"))}&Ds_Signature=x`, "payment.denied"],
];

test("detects each provider and its event type", () => {
  for (const [provider, headers, body, event] of FIXTURES) {
    assert.deepEqual(detectProvider(headers, body), { provider, event }, `${provider} ${body.slice(0, 40)}`);
  }
});

test("every provider in the table has at least one fixture", () => {
  const covered = new Set(FIXTURES.map((f) => f[0]));
  for (const p of DETECTABLE_PROVIDERS) assert.ok(covered.has(p), `no fixture for ${p}`);
});

test("unknown senders, empty bodies and garbage are handled", () => {
  assert.deepEqual(detectProvider({ "content-type": "application/json" }, '{"hello":"world"}'), { provider: null, event: null });
  assert.deepEqual(detectProvider({}, undefined), { provider: null, event: null });
  assert.deepEqual(detectProvider({ "stripe-signature": "x" }, "not json"), { provider: "stripe", event: null });
  assert.deepEqual(detectProvider(new Headers({ "X-GitHub-Event": "ping" }), new TextEncoder().encode("{}")), { provider: "github", event: "ping" });
  // Form-looking body without content type still parses.
  assert.equal(detectProvider({}, "Ds_SignatureVersion=HMAC_SHA256_V1").provider, "redsys");
});
