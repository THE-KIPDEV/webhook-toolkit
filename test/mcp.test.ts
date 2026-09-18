import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "../src/mcp/server.js";
import { sign, verify } from "../src/index.js";
import { startMockServer, startTargetServer, type MockServer, type TargetServer } from "./helpers/mock-server.js";
import { deadUrl } from "./helpers/until.js";

let mock: MockServer;
let target: TargetServer;
let client: Client;

describe("MCP server", () => {
  before(async () => {
    mock = await startMockServer({ explainPaywall: true, maxWaitSeconds: 1 });
    target = await startTargetServer(() => ({ status: 201, body: '{"ok":1}', headers: { "content-type": "application/json" } }));
    const server = createMcpServer({ baseUrl: mock.url, apiKey: null });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(clientTransport);
  });
  after(async () => {
    await client.close();
    await target.close();
    await mock.close();
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    const text = res.content.map((c) => c.text).join("\n");
    const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
    return { isError: Boolean(res.isError), text, data: json ? (JSON.parse(json) as Record<string, unknown>) : undefined };
  }

  test("exposes the 11 tools with agent-oriented descriptions", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "create_webhook_url",
      "explain_webhook_request",
      "get_webhook_request",
      "list_webhook_requests",
      "list_webhook_urls",
      "replay_webhook_request",
      "send_signed_webhook",
      "set_webhook_response",
      "sign_webhook_payload",
      "verify_webhook_signature",
      "wait_for_webhook",
    ]);
    for (const t of tools) {
      assert.ok((t.description ?? "").length > 120, `${t.name} description too short`);
      assert.match(t.description ?? "", /Use (it|them)? ?(when|to|right|on)/i, `${t.name} says when to use it`);
    }
    const instructions = client.getInstructions();
    assert.match(instructions ?? "", /create_webhook_url → /);
  });

  test("create → wait (already arrived, then next, then filtered) → list → get", async () => {
    const created = await call("create_webhook_url", { name: "agent" });
    assert.equal(created.isError, false);
    const token = /Token: (\S+)/.exec(created.text)?.[1] as string;
    assert.match(created.text, /Webhook URL: http:\/\/127\.0\.0\.1:\d+\/r\//);
    assert.match(created.text, /expires in 7 days/);

    // The webhook arrives BEFORE the agent calls wait_for_webhook.
    mock.inject(token, { headers: { "x-github-event": "push" }, body: '{"ref":"main"}' });
    const first = await call("wait_for_webhook", { token, timeout_seconds: 3 });
    assert.match(first.text, /Received POST \/ from github push/);
    assert.equal((first.data as { body: string }).body, '{"ref":"main"}');

    // Calling again waits for the NEXT one.
    setTimeout(() => mock.inject(token, { body: "second" }), 200);
    const second = await call("wait_for_webhook", { token, timeout_seconds: 5 });
    assert.equal((second.data as { body: string }).body, "second");

    // Filters skip unrelated deliveries.
    setTimeout(() => {
      mock.inject(token, { body: "noise" });
      mock.inject(token, { headers: { "stripe-signature": "t=1,v1=x" }, body: '{"type":"invoice.paid"}' });
    }, 200);
    const filtered = await call("wait_for_webhook", { token, timeout_seconds: 5, provider: "stripe", event: "invoice.paid" });
    assert.match(filtered.text, /from stripe invoice\.paid/);

    const timeout = await call("wait_for_webhook", { token, timeout_seconds: 1 });
    assert.equal(timeout.isError, false);
    assert.match(timeout.text, /No webhook within 1s/);

    const list = await call("list_webhook_requests", { token });
    assert.match(list.text, /4 request\(s\)/);
    assert.equal((list.data as unknown as unknown[]).length, 4);

    const big = mock.inject(token, { body: "x".repeat(25_000) });
    const got = await call("get_webhook_request", { token, request_id: big.id });
    assert.match(got.text, /Body truncated: showing 20000 of 25000 characters/);
    assert.equal((got.data as { body: string }).body.length, 20_000);
  });

  test("set_webhook_response changes what the URL answers", async () => {
    const token = /Token: (\S+)/.exec((await call("create_webhook_url")).text)?.[1] as string;
    const res = await call("set_webhook_response", { token, status: 503, body: "down", content_type: "text/plain" });
    assert.match(res.text, /now answers 503 \(text\/plain\)/);
    const hit = await fetch(`${mock.url}/r/${token}`, { method: "POST", body: "x" });
    assert.equal(hit.status, 503);
    assert.equal(await hit.text(), "down");
    assert.equal((await call("set_webhook_response", { token })).isError, true);
  });

  test("replay_webhook_request sends from this machine to localhost", async () => {
    const token = /Token: (\S+)/.exec((await call("create_webhook_url")).text)?.[1] as string;
    const captured = mock.inject(token, { path: "/stripe", headers: { "stripe-signature": "t=1,v1=x", "content-type": "application/json" }, body: '{"type":"invoice.paid"}' });
    const received = target.next();
    const res = await call("replay_webhook_request", { token, request_id: captured.id, target_url: `${target.url}/api/webhooks` });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /→ 201 Created in \d+ ms/);
    const got = await received;
    assert.equal(got.url, "/api/webhooks/stripe");
    assert.equal(got.body, '{"type":"invoice.paid"}');
    assert.equal(got.headers["stripe-signature"], "t=1,v1=x");

    const down = await call("replay_webhook_request", { token, request_id: captured.id, target_url: await deadUrl() });
    assert.equal(down.isError, true);
    assert.match(down.text, /connection refused/);
  });

  test("send_signed_webhook / sign_webhook_payload / verify_webhook_signature", async () => {
    const received = target.next();
    const sent = await call("send_signed_webhook", { provider: "stripe", secret: "whsec_mcp", event: "checkout.session.completed", target_url: target.url });
    assert.equal(sent.isError, false, sent.text);
    assert.match(sent.text, /Sent signed stripe checkout\.session\.completed webhook/);
    const got = await received;
    assert.equal(verify("stripe", { secret: "whsec_mcp", rawBody: got.body, headers: got.headers }).valid, true);

    const twilioReceived = target.next();
    await call("send_signed_webhook", { provider: "twilio", secret: "tok", payload: '{"Body":"hi","From":"+1"}', target_url: `${target.url}/sms` });
    const tw = await twilioReceived;
    assert.equal(tw.body, "Body=hi&From=%2B1");
    assert.equal(verify("twilio", { secret: "tok", url: `${target.url}/sms`, rawBody: tw.body, headers: tw.headers }).valid, true);

    const signed = await call("sign_webhook_payload", { provider: "github", secret: "gh", payload: '{"a":1}' });
    const data = signed.data as { headers: Record<string, string>; body: string };
    assert.equal(data.headers["X-Hub-Signature-256"], sign("github", { secret: "gh", payload: '{"a":1}' }).headers["X-Hub-Signature-256"]);
    assert.match(signed.text, /curl -X POST/);

    const valid = await call("verify_webhook_signature", { provider: "github", secret: "gh", raw_body: '{"a":1}', headers: data.headers });
    assert.match(valid.text, /^VALID/);
    const invalid = await call("verify_webhook_signature", { provider: "github", secret: "gh", raw_body: '{"a":1}\n', headers: data.headers });
    assert.match(invalid.text, /^INVALID \(body_trailing_newline_added\)/);
  });

  test("explain returns the server's upgrade message verbatim on 402; list needs a key", async () => {
    const token = /Token: (\S+)/.exec((await call("create_webhook_url")).text)?.[1] as string;
    const req = mock.inject(token, { body: "{}" });
    const res = await call("explain_webhook_request", { token, request_id: req.id });
    assert.equal(res.isError, true);
    assert.equal(res.text, "You used your 3 free AI explanations. Upgrade to Pro for unlimited explanations.\nhttps://webhook-toolkit.com/pricing");

    const list = await call("list_webhook_urls");
    assert.equal(list.isError, true);
    assert.match(list.text, /WEBHOOK_TOOLKIT_KEY/);
  });

  test("`webhook-toolkit mcp` speaks MCP over stdio and exits when the client disconnects", async () => {
    const cli = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("WEBHOOK_TOOLKIT_")) env[k] = v;
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--base-url", mock.url], env, stderr: "pipe" });
    const stdio = new Client({ name: "stdio-test", version: "1.0.0" });
    await stdio.connect(transport);
    assert.equal(stdio.getServerVersion()?.name, "webhook-toolkit");
    assert.equal((await stdio.listTools()).tools.length, 11);
    const res = (await stdio.callTool({ name: "create_webhook_url", arguments: {} })) as { content: { text: string }[] };
    assert.match(res.content[0]?.text ?? "", new RegExp(`Webhook URL: ${mock.url.replace(/[.]/g, "\\.")}/r/`));
    const pid = transport.pid;
    await stdio.close();
    assert.ok(pid);
    // The server process is gone shortly after stdin closes.
    const deadline = Date.now() + 5000;
    const alive = () => {
      try {
        process.kill(pid as number, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(), false);
  });
});
