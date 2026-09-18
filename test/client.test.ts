import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { forwardRequest, sign, WebhookToolkit, WebhookToolkitError, type CapturedRequest } from "../src/index.js";
import { startMockServer, startTargetServer, type MockServer } from "./helpers/mock-server.js";
import { deadUrl, until } from "./helpers/until.js";

let mock: MockServer;
const KEY = "whk_" + "a".repeat(40);

describe("WebhookToolkit client", () => {
  before(async () => {
    mock = await startMockServer({ keys: { [KEY]: "dev@example.com" }, explainPaywall: true, keepAliveMs: 200, maxWaitSeconds: 1 });
  });
  after(async () => {
    await mock.close();
  });

  const anon = () => new WebhookToolkit({ baseUrl: mock.url, apiKey: null });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("endpoints: create, get, update, delete; anonymous URLs expire", async () => {
    const wt = anon();
    const ep = await wt.createEndpoint({ name: "ci" });
    assert.equal(ep.name, "ci");
    assert.equal(ep.url, `${mock.url}/r/${ep.token}`);
    assert.ok(ep.expiresAt, "anonymous endpoints expire");
    assert.equal((await wt.getEndpoint(ep.token)).token, ep.token);
    const updated = await wt.updateEndpoint(ep.token, { response: { status: 500, body: "boom" } });
    assert.equal(updated.response.status, 500);
    await wt.deleteEndpoint(ep.token);
    await assert.rejects(wt.getEndpoint(ep.token), (e: unknown) => e instanceof WebhookToolkitError && e.status === 404 && e.code === "not_found");
  });

  test("API key: sent as Bearer, required locally for account routes", async () => {
    const wt = new WebhookToolkit({ baseUrl: `${mock.url}/api/v1/`, apiKey: KEY });
    assert.equal(wt.baseUrl, mock.url);
    const ep = await wt.createEndpoint();
    assert.equal(ep.expiresAt, null);
    assert.equal(mock.calls.at(-1)?.authorization, `Bearer ${KEY}`);
    assert.deepEqual((await wt.listEndpoints()).map((e) => e.token), [ep.token]);
    assert.equal((await wt.me()).email, "dev@example.com");

    await assert.rejects(anon().listEndpoints(), (e: unknown) => e instanceof WebhookToolkitError && e.code === "unauthorized" && /API key/.test(e.message));
    await assert.rejects(
      new WebhookToolkit({ baseUrl: mock.url, apiKey: "whk_bad" }).me(),
      (e: unknown) => e instanceof WebhookToolkitError && e.status === 401,
    );
  });

  test("typed errors carry status, code and upgradeUrl (402)", async () => {
    const wt = anon();
    const ep = await wt.createEndpoint();
    const req = mock.inject(ep.token, { body: "{}" });
    await assert.rejects(wt.explainRequest(ep.token, req.id), (e: unknown) => {
      assert.ok(e instanceof WebhookToolkitError);
      assert.equal(e.status, 402);
      assert.equal(e.code, "upgrade_required");
      assert.equal(e.upgradeUrl, "https://webhook-toolkit.com/pricing");
      assert.match(e.message, /3 free AI explanations/);
      return true;
    });
    mock.expire(ep.token);
    await assert.rejects(wt.getEndpoint(ep.token), (e: unknown) => e instanceof WebhookToolkitError && e.status === 410 && e.code === "expired");
  });

  test("network and non-JSON failures are reported clearly", async () => {
    const down = new WebhookToolkit({ baseUrl: await deadUrl(), apiKey: null });
    await assert.rejects(down.createEndpoint(), (e: unknown) => e instanceof WebhookToolkitError && e.code === "network_error" && /connection refused/.test(e.message));
    const wrong = new WebhookToolkit({ baseUrl: `${mock.url}/nowhere`, apiKey: null });
    await assert.rejects(wrong.createEndpoint(), (e: unknown) => e instanceof WebhookToolkitError && e.status === 404 && /base URL/.test(e.message));
  });

  test("requests: list (newest first, after, limit), get, clear, real capture over HTTP", async () => {
    const wt = anon();
    const ep = await wt.createEndpoint();
    const signed = sign("stripe", { secret: "whsec_x", event: "invoice.paid" });
    const res = await fetch(`${ep.url}/stripe?x=1`, { method: "POST", headers: signed.headers, body: signed.body });
    assert.equal(res.status, 200);
    const second = mock.inject(ep.token, { body: "second" });

    const list = await wt.listRequests(ep.token);
    assert.deepEqual(list.map((r) => r.body), ["second", signed.body]);
    const first = list[1] as CapturedRequest;
    assert.equal(first.path, "/stripe");
    assert.equal(first.query, "x=1");
    assert.equal(first.provider, "stripe");
    assert.equal(first.event, "invoice.paid");
    assert.equal(first.headers["stripe-signature"], signed.headers["Stripe-Signature"]);
    assert.deepEqual((await wt.listRequests(ep.token, { after: first.createdAt })).map((r) => r.id), [second.id]);
    assert.equal((await wt.listRequests(ep.token, { limit: 1 })).length, 1);
    assert.equal((await wt.getRequest(ep.token, first.id)).body, signed.body);
    await wt.clearRequests(ep.token);
    assert.equal((await wt.listRequests(ep.token)).length, 0);
  });

  test("waitForRequest: long-poll, filter, requests that arrived before waiting, timeout", async () => {
    const wt = anon();
    const ep = await wt.createEndpoint();

    // Arrived before the wait started: still found (default `after` = creation time for our endpoints).
    mock.inject(ep.token, { body: '{"early":true}' });
    assert.equal((await wt.waitForRequest(ep.token, { timeoutMs: 2000 })).body, '{"early":true}');

    // Filter skips non-matching requests, including a burst.
    const since = new Date().toISOString();
    await sleep(5);
    setTimeout(() => {
      mock.inject(ep.token, { body: "a", headers: { "stripe-signature": "t=1,v1=x" } });
      mock.inject(ep.token, { body: "b" });
      mock.inject(ep.token, { body: '{"type":"invoice.paid"}', headers: { "stripe-signature": "t=1,v1=x" } });
    }, 150);
    const paid = await wt.waitForRequest(ep.token, { after: since, timeoutMs: 5000, filter: (r) => r.event === "invoice.paid" });
    assert.equal(paid.body, '{"type":"invoice.paid"}');

    // Nothing arrives: typed timeout (spans more than one long-poll round).
    const fresh = await anon().getEndpoint(ep.token); // another instance: default after = moment of call
    const other = anon();
    const t0 = Date.now();
    await assert.rejects(
      other.waitForRequest(fresh.token, { timeoutMs: 1500 }),
      (e: unknown) => e instanceof WebhookToolkitError && e.code === "timeout" && /within 2s/.test(e.message),
    );
    assert.ok(Date.now() - t0 >= 1400);

    // Moment-of-call mode chains 1 s polls (mock cap) and catches a request landing in a later round.
    setTimeout(() => mock.inject(ep.token, { body: "late" }), 1300);
    assert.equal((await other.waitForRequest(ep.token, { timeoutMs: 5000 })).body, "late");
  });

  test("waitForRequest honours an AbortSignal", async () => {
    const wt = anon();
    const ep = await wt.createEndpoint();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(wt.waitForRequest(ep.token, { timeoutMs: 10_000, signal: ac.signal }), (e: unknown) => e instanceof WebhookToolkitError && e.code === "aborted");
  });

  test("stream: SSE delivery, reconnection with catch-up, fatal errors", async () => {
    const wt = anon();
    const ep = await wt.createEndpoint();
    const got: string[] = [];
    const reconnects: number[] = [];
    const ac = new AbortController();
    let opened = 0;
    const done = wt.stream(ep.token, (r) => void got.push(r.body), {
      signal: ac.signal,
      onOpen: () => void opened++,
      onReconnect: ({ attempt }) => void reconnects.push(attempt),
    });
    await until(() => opened > 0, "the stream to open");
    mock.inject(ep.token, { body: "one" });
    await until(() => got.length >= 1, "the first request");

    mock.dropStreams();
    await sleep(50);
    mock.inject(ep.token, { body: "missed while disconnected" });
    await until(() => got.length >= 2, "the catch-up after reconnection");
    mock.inject(ep.token, { body: "three" });
    await until(() => got.length >= 3, "the third request");
    assert.deepEqual(got, ["one", "missed while disconnected", "three"]);
    assert.ok(reconnects.length >= 1);
    ac.abort();
    await done;

    mock.expire(ep.token);
    await assert.rejects(wt.stream(ep.token, () => {}), (e: unknown) => e instanceof WebhookToolkitError && e.status === 410);
  });

  test("forwardRequest replays a captured request byte-for-byte to a local server", async () => {
    const target = await startTargetServer(() => ({ status: 201, body: "created", headers: { "x-app": "1" } }));
    try {
      const req: Pick<CapturedRequest, "method" | "path" | "query" | "headers" | "body"> = {
        method: "PUT",
        path: "/github",
        query: "delivery=1",
        headers: { host: "webhook-toolkit.com", "content-length": "999", "x-github-event": "push", "content-type": "application/json" },
        body: '{"ref":"refs/heads/main","emoji":"🚀"}',
      };
      const res = await forwardRequest(req, `${target.url}/hooks`);
      assert.equal(res.status, 201);
      assert.equal(res.body, "created");
      assert.equal(res.headers["x-app"], "1");
      const got = target.received[0];
      assert.ok(got);
      assert.equal(got.method, "PUT");
      assert.equal(got.url, "/hooks/github?delivery=1");
      assert.equal(got.body, req.body);
      assert.equal(got.headers["x-github-event"], "push");
      assert.equal(got.headers.host, new URL(target.url).host);
      assert.equal(got.headers["content-length"], String(Buffer.byteLength(req.body)));

      await assert.rejects(forwardRequest(req, await deadUrl()), (e: unknown) => e instanceof WebhookToolkitError && e.code === "forward_failed" && /connection refused/.test(e.message));
    } finally {
      await target.close();
    }
  });
});
