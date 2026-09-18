# webhook-toolkit

**Receive, forward, sign and verify webhooks from your terminal, your test suite and your AI agent.**
One package: a CLI (`webhook-toolkit`, alias `whtk`), a typed library and an MCP server, backed by [webhook-toolkit.com](https://webhook-toolkit.com).

[![npm](https://img.shields.io/npm/v/webhook-toolkit.svg)](https://www.npmjs.com/package/webhook-toolkit)
[![license](https://img.shields.io/npm/l/webhook-toolkit.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/webhook-toolkit.svg)](https://nodejs.org)
[![CI](https://github.com/THE-KIPDEV/webhook-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-KIPDEV/webhook-toolkit/actions/workflows/ci.yml)

## Quick start

```sh
npx webhook-toolkit listen --forward http://localhost:3000/webhooks
```

That's it: no account, no config. You get a public URL; paste it into Stripe, GitHub, Shopify or any other sender, and every webhook shows up in your terminal and is re-sent to your local handler:

```
  webhook-toolkit · listening

  Webhook URL   https://webhook-toolkit.com/r/l90c9MKIdo0o
  Inspector     https://webhook-toolkit.com/e/l90c9MKIdo0o
  Forwarding    → http://localhost:3000/webhooks
  Expires       in 7 days (2026-09-25 15:42)
                Anonymous URL. Run `webhook-toolkit login` to get a permanent one.

  Waiting for webhooks. Ctrl+C to stop.

  15:42:11  POST   /stripe  stripe checkout.session.completed  248 B
            ↳ 200 OK · 3 ms
  15:42:11  POST   /github  github push  269 B
            ↳ 500 Internal Server Error · 1 ms  {"error":"handler crashed: cannot read properties of undefined"}
```

Every request is also kept in a web inspector (headers, raw body, replay), so nothing is lost when your handler crashes.

## Contents

- [CLI](#cli)
- [Test webhooks in your test suite](#test-webhooks-in-your-test-suite)
- [Use it from AI agents (MCP)](#use-it-from-ai-agents-mcp)
- [Signing and verifying](#signing-and-verifying)
- [Relay: a real tunnel (paid)](#relay-a-real-tunnel-paid)
- [Free vs paid](#free-vs-paid)
- [How it compares](#how-it-compares)
- [Library reference](#library-reference)
- [Configuration](#configuration)

## CLI

```sh
npm i -g webhook-toolkit     # or run any command with npx webhook-toolkit …
```

| Command | What it does |
|---|---|
| `whtk listen [--forward <url>]` | Public URL + live stream of incoming requests, optionally re-sent to localhost. Reuses your last URL while it is alive (`--new` for a fresh one). |
| `whtk relay --to <url\|port>` | Real tunnel: callers get your local app's response. [Paid](#relay-a-real-tunnel-paid). |
| `whtk sign <provider> --secret <s>` | Build a validly signed webhook: prints headers + a ready-to-run `curl`, or sends it with `--send`. |
| `whtk verify <provider> --secret <s> …` | Check a signature, and when it fails, say why. |
| `whtk replay <token> <id> --to <url>` | Re-send a captured request from your machine (localhost works). |
| `whtk requests <token>` | List captured requests (`--json` for scripts). |
| `whtk endpoints` | List your account's URLs. |
| `whtk login` / `logout` / `whoami` | Save, remove or inspect your API key. |
| `whtk mcp` | Start the MCP server on stdio. |

A few things worth knowing:

- **Sub-paths and query strings are kept.** A request to `…/r/<token>/stripe?x=1` is forwarded to `http://localhost:3000/webhooks/stripe?x=1`, so one URL can feed several handlers.
- **Headers are forwarded as received** (minus hop-by-hop headers, `host` and `content-length`), so signature checks in your handler pass exactly as in production.
- **`--json` prints NDJSON** (`listening`, `request`, `forward` events) for scripting: `whtk listen -f 3000 --json | jq .request.event`.
- Colors follow `NO_COLOR`, `FORCE_COLOR` and are off when output is not a terminal.

### Send a signed test event

```sh
# Prints the headers and a curl command, with a realistic sample event
whtk sign stripe --secret whsec_… --event checkout.session.completed

# Or send it straight to your handler
whtk sign github --secret my-secret --file push.json --send http://localhost:3000/api/github
whtk sign twilio --secret <auth token> --url https://example.com/sms --send 3000
```

### Debug "invalid signature"

```sh
whtk verify stripe --secret whsec_test_secret --body-file body.json \
  -H "Stripe-Signature: t=1726000000,v1=a530ce3d81556a0eced506e1d1cad777bc55bc1e408e54dd6bfef08e1dde216c"
```

```
✗ Invalid Stripe signature (body_trailing_newline_added)
  The signature matches the body without its trailing newline: a newline was appended after signing (proxy, logger, copy-paste). Verify the raw bytes exactly as received.
  expected  t=1726000000,v1=1e0085bf1054f89ac8882e2e5fcbfdf301b1d6445e8ed7a316120cd5dc651ba9
  received  t=1726000000,v1=a530ce3d81556a0eced506e1d1cad777bc55bc1e408e54dd6bfef08e1dde216c
  timestamp 1726000000 (738 days ago)
```

The verifier replays the usual mistakes (whitespace in the secret, added or stripped trailing newline, CRLF conversion, expired timestamp, and for Twilio: http vs https, port, query string, trailing slash, repeated parameters) and tells you which one matches. The same logic powers the [online signature validator](https://webhook-toolkit.com/webhook-signature-validator).

## Test webhooks in your test suite

The library gives your tests a real public URL and a way to wait for what lands on it. It works anonymously; set `WEBHOOK_TOOLKIT_KEY` in CI for permanent URLs and higher limits.

### Vitest (or Jest in ESM mode)

```ts
import { expect, test } from "vitest";
import { WebhookToolkit, verify } from "webhook-toolkit";

const wt = new WebhookToolkit(); // anonymous, or reads WEBHOOK_TOOLKIT_KEY

test("creating an order notifies the customer's webhook", async () => {
  const endpoint = await wt.createEndpoint({ name: "ci-orders" });

  // The app under test sends its outgoing webhooks to the capture URL.
  await api.post("/settings/webhooks", { url: endpoint.url, secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" });
  await api.post("/orders", { sku: "tshirt", quantity: 2 });

  const req = await wt.waitForRequest(endpoint.token, {
    timeoutMs: 30_000,
    filter: (r) => JSON.parse(r.body).type === "order.created",
  });

  expect(JSON.parse(req.body).data.quantity).toBe(2);
  // Your outgoing signatures are correct, too:
  expect(verify("svix", { secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", rawBody: req.body, headers: req.headers }).valid).toBe(true);
});
```

`waitForRequest` checks requests that already arrived since the endpoint was created, then long-polls until `timeoutMs`, so the order of "trigger" and "wait" does not matter. It rejects with a `WebhookToolkitError` (`code: "timeout"`) when nothing matched.

To test **your handler** without any network at all, sign the payload locally:

```ts
import { sign } from "webhook-toolkit";

const { headers, body } = sign("stripe", { secret: process.env.STRIPE_WEBHOOK_SECRET!, event: "checkout.session.completed" });
const res = await fetch("http://localhost:3000/api/webhooks/stripe", { method: "POST", headers, body });
expect(res.status).toBe(200);
```

### Playwright

```ts
import { expect, test } from "@playwright/test";
import { WebhookToolkit } from "webhook-toolkit";

const wt = new WebhookToolkit();

test("'Send test event' reaches the configured URL", async ({ page }) => {
  const endpoint = await wt.createEndpoint();

  await page.goto("/settings/integrations");
  await page.getByLabel("Webhook URL").fill(endpoint.url);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Send test event" }).click();

  const req = await wt.waitForRequest(endpoint.token, { timeoutMs: 15_000 });
  expect(req.method).toBe("POST");
  expect(req.headers["content-type"]).toContain("application/json");
});
```

> The package is ESM-only. CommonJS test runners work on Node ≥ 20.19 / 22.12 (native `require(esm)`); Jest needs its [ESM mode](https://jestjs.io/docs/ecmascript-modules).

## Use it from AI agents (MCP)

`webhook-toolkit mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. Your coding agent can create a webhook URL, wait for the delivery after triggering it, read the payload, then replay it or send freshly signed events to your **localhost** handler while it fixes the code.

The API key is optional: everything except `list_webhook_urls` and `explain_webhook_request` works anonymously.

**Claude Code**

```sh
claude mcp add webhook-toolkit -- npx -y webhook-toolkit mcp
# with a key:
claude mcp add webhook-toolkit --env WEBHOOK_TOOLKIT_KEY=whk_… -- npx -y webhook-toolkit mcp
```

**Cursor** (`.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`), **Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "webhook-toolkit": {
      "command": "npx",
      "args": ["-y", "webhook-toolkit", "mcp"],
      "env": { "WEBHOOK_TOOLKIT_KEY": "whk_…" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "inputs": [
    { "type": "promptString", "id": "webhook-toolkit-key", "description": "webhook-toolkit.com API key (optional)", "password": true }
  ],
  "servers": {
    "webhook-toolkit": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "webhook-toolkit", "mcp"],
      "env": { "WEBHOOK_TOOLKIT_KEY": "${input:webhook-toolkit-key}" }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.webhook-toolkit]
command = "npx"
args = ["-y", "webhook-toolkit", "mcp"]
env = { WEBHOOK_TOOLKIT_KEY = "whk_…" }
```

**ChatGPT, Claude.ai and other remote-capable clients**: add a custom connector pointing at the hosted server, nothing to install:

```
https://webhook-toolkit.com/mcp
```

(Streamable HTTP, optional `Authorization: Bearer whk_…`.) The hosted server cannot reach your machine, so replaying to `localhost` and `send_signed_webhook` need the local server above.

| Tool | Use it to |
|---|---|
| `create_webhook_url` | Get a public URL to receive a webhook from a third-party service or the app under test |
| `wait_for_webhook` | Block until the delivery arrives (filters: provider, event, method, path, body); safe to call after triggering |
| `list_webhook_requests` / `get_webhook_request` | See what was actually sent: headers, raw body, detected provider and event |
| `replay_webhook_request` | Re-send a captured request from the local machine to e.g. `http://localhost:3000/api/webhooks` |
| `send_signed_webhook` | POST a validly signed event (Stripe, GitHub, Shopify, Slack, Twilio, Mailgun, Svix, Paddle, Discord) to your handler |
| `sign_webhook_payload` | Compute signature headers and a `curl` command without sending |
| `verify_webhook_signature` | Explain why a handler rejects a signature |
| `set_webhook_response` | Change what the URL answers (status, body): simulate failures, answer challenges |
| `list_webhook_urls` | Find an existing permanent URL (key required) |
| `explain_webhook_request` | AI explanation of a payload, or a generated handler (paid, 3 free trials) |

Outputs are compact text plus the key JSON; bodies over 20 KB are truncated with a note pointing to the inspector. To embed the server in your own process: `import { createMcpServer } from "webhook-toolkit/mcp"`.

## Signing and verifying

`sign()` and `verify()` run locally with `node:crypto`: secrets never leave your machine. Signatures are byte-for-byte identical to the [webhook-toolkit.com signer](https://webhook-toolkit.com/signer), and the tests check them against the providers' published examples (GitHub, Slack, Twilio, Svix).

| Provider | id | Signature | Algorithm | `secret` |
|---|---|---|---|---|
| Stripe | `stripe` | `Stripe-Signature` | HMAC-SHA256 hex of `t.body` | endpoint secret `whsec_…` |
| GitHub, Gitea, Forgejo | `github` | `X-Hub-Signature-256` (+ `X-Hub-Signature`) | HMAC-SHA256 hex of the body | webhook secret |
| Shopify | `shopify` | `X-Shopify-Hmac-Sha256` | HMAC-SHA256 base64 of the body | app client secret |
| Slack | `slack` | `X-Slack-Signature`, `X-Slack-Request-Timestamp` | HMAC-SHA256 hex of `v0:ts:body` | signing secret |
| Twilio | `twilio` | `X-Twilio-Signature` | HMAC-SHA1 base64 of URL + sorted params (`bodySHA256` for JSON) | auth token, plus `url` |
| Mailgun | `mailgun` | `signature` object in the body | HMAC-SHA256 hex of `timestamp + token` | webhook signing key |
| Svix / Standard Webhooks (Clerk, Resend) | `svix` | `svix-*` and `webhook-*` headers | HMAC-SHA256 base64 of `id.ts.body` | `whsec_…` |
| Paddle Billing | `paddle` | `Paddle-Signature` | HMAC-SHA256 hex of `ts:body` | `pdl_ntfset_…` |
| Discord interactions | `discord` | `X-Signature-Ed25519`, `X-Signature-Timestamp` | Ed25519 | verify: app public key; sign: a test private key |

```ts
import { sign, verify } from "webhook-toolkit";

// In an Express handler (use express.raw so the body stays byte-exact)
app.post("/webhooks/stripe", express.raw({ type: "*/*" }), (req, res) => {
  const result = verify("stripe", { secret: process.env.STRIPE_WEBHOOK_SECRET!, rawBody: req.body, headers: req.headers });
  if (!result.valid) return res.status(400).send(result.message);
  // …
});
```

`verify()` returns `{ valid, reason?, message, expected?, received?, timestamp? }`. Failure reasons: `missing_signature`, `malformed_signature`, `missing_timestamp`, `missing_url`, `invalid_secret`, `timestamp_out_of_tolerance` (default 300 s, `toleranceSeconds: 0` disables), `signature_mismatch`, `secret_whitespace`, `body_trailing_newline_added`, `body_trailing_newline_removed`, `body_line_endings_changed`, `url_mismatch` (Twilio), `body_hash_mismatch` (Twilio JSON). Comparisons are constant-time.

### Provider detection

`detectProvider(headers, body)` returns `{ provider, event }` from a data-driven table (`DETECTION_RULES`), for example `{ provider: "stripe", event: "invoice.paid" }` or `{ provider: "twilio", event: "message.received" }`. It knows Stripe, GitHub, GitLab, Bitbucket, Shopify, WooCommerce, Slack, SendGrid, Twilio, Paddle, Svix (Clerk, Resend), GoCardless, PayPal, Discord, Linear, Typeform, Calendly, Square, HubSpot, Zoom, Lemon Squeezy, Coinbase Commerce, Twitch, Mux, Vercel, Netlify, Sentry, Trello, Plaid, Mandrill, Jira, Postmark, Mollie, Adyen, Mailgun and Redsys. Adding one is a table entry plus a test fixture.

## Relay: a real tunnel (paid)

`listen --forward` is free and fine for most webhooks, but the sender receives the capture URL's response, not your app's. When the sender needs your real answer (Slack slash commands, Twilio TwiML, Shopify mandatory responses, OAuth callbacks), use the relay:

```sh
whtk login               # once
whtk relay --to 3000
```

```
  webhook-toolkit relay · live

  Public URL  https://webhook-toolkit.com/relay/my-app  (any sub-path works)
  Forwarding  → http://localhost:3000
```

Requests to the public URL are proxied over a WebSocket to your machine and your local response (status, headers, body) goes back to the caller. It reconnects with backoff. The relay comes with the [7-day Pass or Pro](https://webhook-toolkit.com/pricing).

## Free vs paid

| | Anonymous | Free account | Pass (7 days, €5 once) / Pro (€9/month) |
|---|---|---|---|
| Capture URLs | up to 30 new per day, each lasts 7 days | 1 permanent URL | 25 permanent URLs |
| History | 7 days | 7 days | 30 days |
| CLI `listen --forward`, replay, sign, verify, MCP | ✓ | ✓ | ✓ |
| Relay (real tunnel to localhost) | | | ✓ |
| AI explanations and generated handlers | 3 free trials | 3 free trials | ✓ |

Details and the Business plan: [webhook-toolkit.com/pricing](https://webhook-toolkit.com/pricing). Everything that runs locally (signing, verifying, detection, forwarding) is free and stays free.

## How it compares

- **[smee.io](https://smee.io)** is a free, open-source service from the GitHub Probot team that forwards webhooks to localhost through its client. If forwarding is all you need, it does the job. webhook-toolkit's `listen --forward` works the same way and adds a stored inspector, provider/event detection, replay, signing and verification tools, a test-suite API and an MCP server.
- **[webhook.site](https://webhook.site)** is a mature hosted request inspector with custom responses and paid automation features. webhook-toolkit covers the inspect-and-respond part and focuses on the local developer loop: forwarding, signed test events, signature diagnosis, tests and agents.
- **[ngrok](https://ngrok.com)** is a general-purpose tunnel for any HTTP or TCP service, with a local traffic inspector. Pick it to expose a whole app. webhook-toolkit's free flow needs no account, and its paid relay is scoped to webhooks.

## Library reference

```ts
import { WebhookToolkit, WebhookToolkitError, sign, verify, detectProvider, forwardRequest } from "webhook-toolkit";

const wt = new WebhookToolkit({ apiKey, baseUrl }); // both optional (env: WEBHOOK_TOOLKIT_KEY, WEBHOOK_TOOLKIT_URL)
```

| Method | Returns |
|---|---|
| `createEndpoint({ name? })` | `Endpoint`: `{ token, url, inspectUrl, expiresAt, createdAt, response, … }` |
| `listEndpoints()` | `Endpoint[]` (API key required) |
| `getEndpoint(token)` / `deleteEndpoint(token)` | `Endpoint` / `void` |
| `updateEndpoint(token, { name?, response?: { status?, body?, contentType? } })` | `Endpoint` |
| `listRequests(token, { limit?, after? })` | `CapturedRequest[]`, newest first |
| `getRequest(token, id)` / `clearRequests(token)` | `CapturedRequest` / `void` |
| `waitForRequest(token, { timeoutMs?, after?, filter?, signal? })` | `CapturedRequest` (rejects with `code: "timeout"`) |
| `stream(token, onRequest, { signal?, after?, onOpen?, onReconnect? })` | `Promise<void>`: live SSE feed, reconnects and catches up on missed requests |
| `replayRequest(token, id, url)` | server-side replay to a public URL |
| `explainRequest(token, id, { mode?, language? })` | AI explanation or handler (paid, 3 free trials) |
| `me()`, `listRelays()`, `createRelay()` | account, plan, relays |

`forwardRequest(request, target)` re-sends a captured request from your machine (the same function behind `listen --forward` and `replay`). Errors are `WebhookToolkitError` with `status` (HTTP status, `0` for network errors), `code` (`unauthorized`, `upgrade_required`, `plan_limit`, `expired`, `timeout`, `network_error`, …) and `upgradeUrl` on 402 answers. Everything is typed; types ship with the package.

## Configuration

| Variable | Purpose |
|---|---|
| `WEBHOOK_TOOLKIT_KEY` | API key (`whk_…`), created in your [dashboard](https://webhook-toolkit.com/dashboard). Takes precedence over the saved key; `--key` overrides both. |
| `WEBHOOK_TOOLKIT_URL` | API origin, e.g. `http://localhost:3000` for a self-hosted instance. Same as `--base-url`. |
| `WEBHOOK_TOOLKIT_RELAY_TOKEN` | Relay token for `whtk relay`. |
| `NO_COLOR` / `FORCE_COLOR` | Terminal colors. |

`whtk login` stores the key in `~/.config/webhook-toolkit/config.json` (or `$XDG_CONFIG_HOME/webhook-toolkit/config.json`) with mode `600`. The same file remembers the last URL used by `listen`.

A capture URL's token is a capability: anyone holding it can read the requests sent to it. Use an account for anything sensitive; the owner's key is then required to change or delete the URL.

## Requirements

Node.js 18.17 or later. Runtime dependencies: `@modelcontextprotocol/sdk` and `zod` (MCP server) and `ws` (relay).

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](./CONTRIBUTING.md). New providers for detection or signing are the easiest place to start.

## License

[MIT](./LICENSE) © 2026 Kipdev. Hosted service: [webhook-toolkit.com](https://webhook-toolkit.com).
