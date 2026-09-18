import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { SIGNATURE_PROVIDER_IDS, sign, verify, type SignatureProvider, type VerifyOptions } from "../src/index.js";

const TS = 1_726_000_000;
const NOW = TS + 10;

// ─── Reference: the webhook-toolkit.com signer (src/lib/signer/sign.ts), replicated here with
// node:crypto and a fixed timestamp. Nothing is imported from the SaaS.
function saasSignPayload(opts: { providerId: string; eventType: string; payload: unknown; secret: string; targetUrl?: string; ts: number }) {
  const { secret, ts } = opts;
  switch (opts.providerId) {
    case "stripe": {
      const body = JSON.stringify(opts.payload);
      const v1 = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
      return { body, headers: { "Stripe-Signature": `t=${ts},v1=${v1}` } as Record<string, string> };
    }
    case "github": {
      const body = JSON.stringify(opts.payload);
      return {
        body,
        headers: {
          "X-Hub-Signature-256": `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`,
          "X-Hub-Signature": `sha1=${crypto.createHmac("sha1", secret).update(body).digest("hex")}`,
          "X-GitHub-Event": opts.eventType,
        } as Record<string, string>,
      };
    }
    case "shopify": {
      const body = JSON.stringify(opts.payload);
      return {
        body,
        headers: {
          "X-Shopify-Hmac-Sha256": crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64"),
          "X-Shopify-Topic": opts.eventType,
        } as Record<string, string>,
      };
    }
    case "slack": {
      const body = JSON.stringify(opts.payload);
      const sig = crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
      return { body, headers: { "X-Slack-Signature": `v0=${sig}`, "X-Slack-Request-Timestamp": String(ts) } as Record<string, string> };
    }
    case "twilio": {
      const params = opts.payload as Record<string, string>;
      let data = opts.targetUrl ?? "";
      for (const k of Object.keys(params).sort()) data += k + String(params[k]);
      const sig = crypto.createHmac("sha1", secret).update(Buffer.from(data, "utf-8")).digest("base64");
      return { body: new URLSearchParams(params).toString(), headers: { "X-Twilio-Signature": sig } as Record<string, string> };
    }
    default:
      throw new Error("not in the SaaS reference");
  }
}

const stripeEvent = { id: "evt_1", object: "event", type: "invoice.paid", data: { object: { id: "in_1", amount_paid: 4200, note: "café ✓" } } };

test("byte-identical to the webhook-toolkit.com signer (Stripe, GitHub, Shopify, Slack, Twilio)", () => {
  const cases: { provider: SignatureProvider; event: string; payload: unknown; secret: string; url?: string }[] = [
    { provider: "stripe", event: "invoice.paid", payload: stripeEvent, secret: "whsec_abc123" },
    { provider: "github", event: "push", payload: { ref: "refs/heads/main", commits: [{ message: "ünïcode" }] }, secret: "gh-secret" },
    { provider: "shopify", event: "orders/create", payload: { id: 1, total_price: "29.90" }, secret: "shpss_x" },
    { provider: "slack", event: "event_callback", payload: { type: "event_callback", event: { type: "message", text: "hi" } }, secret: "slack-s" },
    {
      provider: "twilio",
      event: "sms_inbound",
      payload: { MessageSid: "SM1", From: "+33600000000", Body: "Hello & bye=1" },
      secret: "auth-token",
      url: "https://example.com/twilio/sms?x=1",
    },
  ];
  for (const c of cases) {
    const ref = saasSignPayload({ providerId: c.provider, eventType: c.event, payload: c.payload, secret: c.secret, targetUrl: c.url, ts: TS });
    const ours = sign(c.provider, { secret: c.secret, payload: c.payload, event: c.event, timestamp: TS, ...(c.url ? { url: c.url } : {}) });
    assert.equal(ours.body, ref.body, `${c.provider} body`);
    for (const [name, value] of Object.entries(ref.headers)) assert.equal(ours.headers[name], value, `${c.provider} ${name}`);
  }
});

test("official documentation vectors", () => {
  // GitHub docs: "Testing the webhook payload validation".
  const gh = sign("github", { secret: "It's a Secret to Everybody", payload: "Hello, World!" });
  assert.equal(gh.headers["X-Hub-Signature-256"], "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");

  // Slack docs: "Verifying requests from Slack".
  const slackBody =
    "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
  const slack = sign("slack", { secret: "8f742231b10e8888abcd99yyyzzz85a5", payload: slackBody, timestamp: 1531420618 });
  assert.equal(slack.headers["X-Slack-Signature"], "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503");

  // Twilio docs: "Validating signatures from Twilio".
  const twilio = sign("twilio", {
    secret: "12345",
    url: "https://mycompany.com/myapp.php?foo=1&bar=2",
    payload: { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" },
  });
  assert.equal(twilio.headers["X-Twilio-Signature"], "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");

  // Svix docs: "Verifying webhooks manually".
  const svix = sign("svix", {
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    timestamp: 1614265330,
    payload: '{"test": 2432232314}',
  });
  assert.equal(svix.headers["svix-signature"], "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  assert.equal(svix.headers["webhook-signature"], svix.headers["svix-signature"]);
});

test("fixed vectors computed with an independent implementation (Python hmac)", () => {
  const stripe = sign("stripe", { secret: "whsec_test_secret", payload: '{"id":"evt_1","type":"invoice.paid"}', timestamp: TS });
  assert.equal(stripe.headers["Stripe-Signature"], `t=${TS},v1=a530ce3d81556a0eced506e1d1cad777bc55bc1e408e54dd6bfef08e1dde216c`);
  const shopify = sign("shopify", { secret: "shpss_secret", payload: '{"id":1,"total_price":"29.90"}' });
  assert.equal(shopify.headers["X-Shopify-Hmac-Sha256"], "rh5UJwq9JGQLLenXZa6ngDbWXbH6CmZZwshYp1cgjYQ=");
  const paddle = sign("paddle", { secret: "pdl_ntfset_secret", payload: '{"event_type":"transaction.completed"}', timestamp: TS });
  assert.equal(paddle.headers["Paddle-Signature"], `ts=${TS};h1=cd341d0defedf03e69cd6c492c590593f311c6f7fcfca85a6e426d1d0fd5a793`);
  const mailgun = sign("mailgun", { secret: "mg-signing-key", id: "abcdef0123456789", timestamp: TS, payload: { "event-data": { event: "opened" } } });
  const body = JSON.parse(mailgun.body) as { signature: { signature: string; token: string; timestamp: string } };
  assert.deepEqual(body.signature, {
    timestamp: String(TS),
    token: "abcdef0123456789",
    signature: "8cc7471193497a664277afb1cfa62302f5b5237bba2e484affd43b9d3051b729",
  });
});

function discordKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32).toString("hex");
  const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  return { seed, pub };
}

test("sign → verify round-trip for every provider", () => {
  const discord = discordKeys();
  const secrets: Record<SignatureProvider, { sign: string; verify: string }> = {
    stripe: { sign: "whsec_rt", verify: "whsec_rt" },
    github: { sign: "gh", verify: "gh" },
    shopify: { sign: "sh", verify: "sh" },
    slack: { sign: "sl", verify: "sl" },
    twilio: { sign: "tw", verify: "tw" },
    mailgun: { sign: "mg", verify: "mg" },
    svix: { sign: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", verify: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" },
    paddle: { sign: "pdl", verify: "pdl" },
    discord: { sign: discord.seed, verify: discord.pub },
  };
  const url = "https://example.com/hooks/twilio";
  for (const provider of SIGNATURE_PROVIDER_IDS) {
    const signed = sign(provider, { secret: secrets[provider].sign, timestamp: TS, url });
    const ok = verify(provider, { secret: secrets[provider].verify, rawBody: signed.body, headers: signed.headers, url, now: NOW });
    assert.equal(ok.valid, true, `${provider}: ${ok.message}`);
    // Bytes in, same verdict.
    const okBytes = verify(provider, { secret: secrets[provider].verify, rawBody: Buffer.from(signed.body), headers: signed.headers, url, now: NOW });
    assert.equal(okBytes.valid, true, `${provider} (bytes)`);
    if (provider === "discord") continue;
    const bad = verify(provider, { secret: `${secrets[provider].verify}x`, rawBody: signed.body, headers: signed.headers, url, now: NOW });
    assert.equal(bad.valid, false, `${provider} wrong secret`);
  }
});

test("verify accepts any header casing, Headers instances and Node's IncomingHttpHeaders", () => {
  const signed = sign("github", { secret: "s", payload: { a: 1 } });
  const lower = Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(verify("github", { secret: "s", rawBody: signed.body, headers: lower }).valid, true);
  assert.equal(verify("github", { secret: "s", rawBody: signed.body, headers: new Headers(signed.headers) }).valid, true);
  assert.equal(verify("GitHub", { secret: "s", rawBody: signed.body, headers: Object.entries(signed.headers) }).valid, true);
});

test("sign: samples, event patching, provider aliases and input errors", () => {
  const sample = sign("stripe", { secret: "s", event: "customer.subscription.created" });
  assert.equal((JSON.parse(sample.body) as { type: string }).type, "customer.subscription.created");
  assert.match((JSON.parse(sample.body) as { data: { object: { id: string } } }).data.object.id, /^sub_/);
  const patched = sign("stripe", { secret: "s", event: "invoice.paid" });
  assert.equal((JSON.parse(patched.body) as { type: string }).type, "invoice.paid");
  assert.equal(sign("github", { secret: "s", event: "pull_request" }).headers["X-GitHub-Event"], "pull_request");
  assert.equal(sign("clerk", { secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" }).provider, "svix");
  assert.equal(sign("stripe", { secret: "s", payload: { type: "charge.refunded" } }).event, "charge.refunded");
  assert.equal(sign("stripe", { secret: "s" }).headers["Content-Type"], "application/json");

  const tw = sign("twilio", { secret: "t", url: "https://e.com/x", payload: { To: ["+1", "+2"], Body: "hi" } });
  assert.equal(tw.body, "To=%2B1&To=%2B2&Body=hi");
  assert.equal(tw.contentType, "application/x-www-form-urlencoded");
  assert.equal(verify("twilio", { secret: "t", url: "https://e.com/x", rawBody: tw.body, headers: tw.headers }).valid, true);

  assert.throws(() => sign("nope", { secret: "s" }), /Unknown provider "nope"/);
  assert.throws(() => sign("stripe", { secret: "" }), /secret is required/);
  assert.throws(() => sign("twilio", { secret: "t" }), /pass `url`/);
  assert.throws(() => sign("svix", { secret: "whsec_not base64!" }), /base64/);
  assert.throws(() => sign("discord", { secret: "not-a-key" }), /Ed25519 PRIVATE key/);
});

test("verify diagnoses the usual causes of a failed signature", () => {
  const body = '{"id":"evt_1","type":"invoice.paid"}';
  const s = sign("stripe", { secret: "whsec_x", payload: body, timestamp: TS });
  const base: VerifyOptions = { secret: "whsec_x", rawBody: body, headers: s.headers, now: NOW };

  const trailing = verify("stripe", { ...base, rawBody: `${body}\n` });
  assert.equal(trailing.reason, "body_trailing_newline_added");

  const signedWithNewline = sign("stripe", { secret: "whsec_x", payload: `${body}\n`, timestamp: TS });
  assert.equal(verify("stripe", { ...base, headers: signedWithNewline.headers }).reason, "body_trailing_newline_removed");

  const crlf = sign("github", { secret: "g", payload: '{\n  "a": 1\n}' });
  assert.equal(verify("github", { secret: "g", rawBody: '{\r\n  "a": 1\r\n}', headers: crlf.headers }).reason, "body_line_endings_changed");

  const ws = verify("stripe", { ...base, secret: "whsec_x\n" });
  assert.equal(ws.reason, "secret_whitespace");

  const wrong = verify("stripe", { ...base, secret: "whsec_other" });
  assert.equal(wrong.reason, "signature_mismatch");
  assert.equal(wrong.received, s.headers["Stripe-Signature"]);
  assert.match(wrong.expected ?? "", /^t=1726000000,v1=[0-9a-f]{64}$/);
  assert.match(wrong.message, /raw body/);

  const old = verify("stripe", { ...base, now: TS + 3600 });
  assert.equal(old.reason, "timestamp_out_of_tolerance");
  assert.equal(old.timestamp?.ageSeconds, 3600);
  assert.equal(verify("stripe", { ...base, now: TS + 3600, toleranceSeconds: 0 }).valid, true);

  assert.equal(verify("stripe", { ...base, headers: {} }).reason, "missing_signature");
  assert.equal(verify("stripe", { ...base, headers: { "stripe-signature": "garbage" } }).reason, "malformed_signature");
  assert.equal(verify("slack", { secret: "x", rawBody: body, headers: { "x-slack-signature": "v0=abcd" } }).reason, "missing_timestamp");
  assert.equal(
    verify("svix", { secret: "whsec_!!", rawBody: body, headers: { "svix-id": "m", "svix-timestamp": "1", "svix-signature": "v1,abc" } }).reason,
    "invalid_secret",
  );
});

test("verify: Stripe secret rotation (several v1) and GitHub sha1 fallback", () => {
  const body = '{"a":1}';
  const good = sign("stripe", { secret: "new", payload: body, timestamp: TS }).headers["Stripe-Signature"] as string;
  const v1 = good.split("v1=")[1];
  const header = `t=${TS},v1=${"0".repeat(64)},v1=${v1}`;
  assert.equal(verify("stripe", { secret: "new", rawBody: body, headers: { "Stripe-Signature": header }, now: NOW }).valid, true);

  const gh = sign("github", { secret: "s", payload: body });
  assert.equal(verify("github", { secret: "s", rawBody: body, headers: { "X-Hub-Signature": gh.headers["X-Hub-Signature"] as string } }).valid, true);
});

test("verify Twilio: URL variants pinpoint proxy mistakes", () => {
  const params = { From: "+33600000000", Body: "hi", MessageSid: "SM1" };
  const url = "https://example.com/sms";
  const s = sign("twilio", { secret: "tok", url, payload: params });
  const check = (u: string) => verify("twilio", { secret: "tok", url: u, rawBody: s.body, headers: s.headers });

  assert.equal(check(url).valid, true);
  const scheme = check("http://example.com/sms");
  assert.equal(scheme.reason, "url_mismatch");
  assert.match(scheme.message, /http vs https/);
  assert.match(check("https://example.com:443/sms").message, /port/);
  assert.match(check("https://example.com/sms/").message, /trailing slash/);
  assert.match(check("https://example.com/sms?extra=1").message, /query string/);
  assert.equal(verify("twilio", { secret: "tok", rawBody: s.body, headers: s.headers }).reason, "missing_url");
  assert.equal(verify("twilio", { secret: "other", url, rawBody: s.body, headers: s.headers }).reason, "signature_mismatch");
});

test("verify Twilio: repeated params (issue #722) and JSON bodies with bodySHA256", () => {
  const url = "https://example.com/group";
  // Twilio coerces repeated keys to "a,b" in the order received.
  const canonical = `${url}Bodyhi` + "To+2,+1";
  const sig = crypto.createHmac("sha1", "tok").update(canonical).digest("base64");
  const body = "To=%2B2&Body=hi&To=%2B1";
  assert.equal(verify("twilio", { secret: "tok", url, rawBody: body, headers: { "X-Twilio-Signature": sig } }).valid, true);
  const sortedSig = crypto.createHmac("sha1", "tok").update(`${url}Bodyhi` + "To+1,+2").digest("base64");
  const sorted = verify("twilio", { secret: "tok", url, rawBody: body, headers: { "X-Twilio-Signature": sortedSig } });
  assert.equal(sorted.reason, "url_mismatch");
  assert.match(sorted.message, /repeated parameters/);

  const json = '{"EventType":"onMessageAdded"}';
  const hash = crypto.createHash("sha256").update(json).digest("hex");
  const jsonUrl = `https://example.com/conv?bodySHA256=${hash}`;
  const jsonSig = crypto.createHmac("sha1", "tok").update(jsonUrl).digest("base64");
  assert.equal(verify("twilio", { secret: "tok", url: jsonUrl, rawBody: json, headers: { "X-Twilio-Signature": jsonSig } }).valid, true);
  assert.equal(
    verify("twilio", { secret: "tok", url: jsonUrl, rawBody: `${json} `, headers: { "X-Twilio-Signature": jsonSig } }).reason,
    "body_hash_mismatch",
  );
});

test("verify Discord: Ed25519 with the application public key", () => {
  const { seed, pub } = discordKeys();
  const body = '{"type":1}';
  const signed = sign("discord", { secret: seed, payload: body, timestamp: TS });
  // Independent check with node:crypto.
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub, "hex")]), format: "der", type: "spki" });
  assert.equal(crypto.verify(null, Buffer.from(`${TS}${body}`), key, Buffer.from(signed.headers["X-Signature-Ed25519"] as string, "hex")), true);

  assert.equal(verify("discord", { secret: pub, rawBody: body, headers: signed.headers, now: NOW }).valid, true);
  assert.equal(verify("discord", { secret: pub, rawBody: `${body}\n`, headers: signed.headers, now: NOW }).reason, "body_trailing_newline_added");
  assert.equal(verify("discord", { secret: discordKeys().pub, rawBody: body, headers: signed.headers, now: NOW }).reason, "signature_mismatch");
  assert.equal(verify("discord", { secret: "zz", rawBody: body, headers: signed.headers, now: NOW }).reason, "invalid_secret");
});

test("verify Mailgun: signature embedded in JSON or legacy form bodies", () => {
  const signed = sign("mailgun", { secret: "key", timestamp: TS });
  assert.equal(verify("mailgun", { secret: "key", rawBody: signed.body, headers: {}, now: NOW }).valid, true);
  const sig = crypto.createHmac("sha256", "key").update(`${TS}tok123`).digest("hex");
  const form = `timestamp=${TS}&token=tok123&signature=${sig}&event=delivered`;
  assert.equal(verify("mailgun", { secret: "key", rawBody: form, headers: {}, now: NOW }).valid, true);
  assert.equal(verify("mailgun", { secret: "key", rawBody: "{}", headers: {} }).reason, "missing_signature");
});
