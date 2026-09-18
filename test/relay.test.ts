import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { WebhookToolkitError } from "../src/index.js";
import { relayWebSocketUrl, runRelay, type RelayEvent } from "../src/relay.js";
import { startMockServer, startTargetServer, type MockServer, type TargetServer } from "./helpers/mock-server.js";
import { deadUrl } from "./helpers/until.js";

let mock: MockServer;
let target: TargetServer;

describe("relay", () => {
  before(async () => {
    mock = await startMockServer({ relays: { rly_valid: "my-slug" } });
    target = await startTargetServer((req) => ({
      status: req.url.startsWith("/hooks/fail") ? 422 : 201,
      body: JSON.stringify({ echo: req.body, url: req.url }),
      headers: { "content-type": "application/json", "x-local": "yes" },
    }));
  });
  after(async () => {
    await target.close();
    await mock.close();
  });

  test("relay URL", () => {
    assert.equal(relayWebSocketUrl("https://webhook-toolkit.com", "a b"), "wss://webhook-toolkit.com/__relay?token=a%20b");
    assert.equal(relayWebSocketUrl("http://localhost:3000", "t"), "ws://localhost:3000/__relay?token=t");
  });

  test("relays requests to localhost and returns the local response to the caller", async () => {
    const events: RelayEvent[] = [];
    const ac = new AbortController();
    let ready: (url: string) => void;
    const isReady = new Promise<string>((r) => (ready = r));
    const done = runRelay({
      token: "rly_valid",
      target: `${target.url}/hooks`,
      baseUrl: mock.url,
      signal: ac.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "ready") ready(e.publicUrl);
      },
    });
    const publicUrl = await isReady;
    assert.equal(publicUrl, `${mock.url}/relay/my-slug`);

    const res = await fetch(`${publicUrl}/stripe?x=1`, { method: "POST", body: '{"hello":"relay"}', headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=x" } });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("x-local"), "yes");
    assert.deepEqual(await res.json(), { echo: '{"hello":"relay"}', url: "/hooks/stripe?x=1" });
    const got = target.received.at(-1);
    assert.equal(got?.headers["stripe-signature"], "t=1,v1=x");

    const failed = await fetch(`${publicUrl}/fail`, { method: "POST", body: "x" });
    assert.equal(failed.status, 422);

    const ev = events.find((e) => e.type === "request");
    assert.ok(ev && ev.type === "request");
    assert.equal(ev.method, "POST");
    assert.equal(ev.path, "/stripe?x=1");
    assert.equal(ev.status, 201);

    ac.abort();
    await done;
  });

  test("an unreachable local target answers 502 to the caller", async () => {
    const ac = new AbortController();
    let ready: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    const done = runRelay({
      token: "rly_valid",
      target: await deadUrl(),
      baseUrl: mock.url,
      signal: ac.signal,
      onEvent: (e) => e.type === "ready" && ready(),
    });
    await isReady;
    const res = await fetch(`${mock.url}/relay/my-slug/x`, { method: "POST", body: "{}" });
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: string }).error, "relay target unreachable");
    ac.abort();
    await done;
  });

  test("a refused token rejects with code unauthorized", async () => {
    await assert.rejects(
      runRelay({ token: "rly_wrong", target: "3000", baseUrl: mock.url }),
      (e: unknown) => e instanceof WebhookToolkitError && e.code === "unauthorized" && e.status === 401,
    );
  });
});
