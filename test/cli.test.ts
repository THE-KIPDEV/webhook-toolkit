import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { COMMAND_HELP, MAIN_HELP } from "../src/cli/help.js";
import { sign, verify } from "../src/index.js";
import { startMockServer, startTargetServer, type MockServer, type TargetServer } from "./helpers/mock-server.js";
import { deadUrl, until } from "./helpers/until.js";

const CLI = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
const KEY = "whk_" + "b".repeat(40);

let mock: MockServer;
let target: TargetServer;

describe("CLI", () => {
  before(async () => {
    mock = await startMockServer({ keys: { [KEY]: "cli@example.com" }, keepAliveMs: 200 });
    target = await startTargetServer(() => ({ status: 202, body: '{"handled":true}', headers: { "content-type": "application/json" } }));
  });
  after(async () => {
    await target.close();
    await mock.close();
  });

  function cliEnv(configHome: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", XDG_CONFIG_HOME: configHome };
    delete env.WEBHOOK_TOOLKIT_KEY;
    delete env.WEBHOOK_TOOLKIT_URL;
    delete env.WEBHOOK_TOOLKIT_RELAY_TOKEN;
    delete env.FORCE_COLOR;
    return env;
  }

  function spawnCli(args: string[], configHome: string): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, [CLI, ...args], { env: cliEnv(configHome) });
  }

  function run(args: string[], configHome = mkdtempSync(join(tmpdir(), "whtk-cli-")), input?: string) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawnCli(args, configHome);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.stdin.end(input ?? "");
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  /** Resolves with the first NDJSON line of `child` matching `pred`. */
  function nextJson(child: ChildProcessWithoutNullStreams, pred: (o: Record<string, unknown>) => boolean, timeoutMs = 8000) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        child.stdout.off("data", onData);
        reject(new Error(`timeout waiting for a line; got: ${buf}`));
      }, timeoutMs);
      const onData = (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (pred(obj)) {
              clearTimeout(timer);
              child.stdout.off("data", onData);
              resolve(obj);
              return;
            }
          } catch {
            /* not JSON */
          }
        }
      };
      child.stdout.on("data", onData);
    });
  }

  function exitOf(child: ChildProcessWithoutNullStreams) {
    return new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  }

  test("--help, --version, command help, unknown commands", async () => {
    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.equal(help.stdout, MAIN_HELP + "\n");
    assert.equal((await run(["--version"])).stdout.trim(), JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
    const listenHelp = await run(["listen", "--help"]);
    assert.equal(listenHelp.stdout, COMMAND_HELP.listen + "\n");
    const unknown = await run(["lsten"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown command "lsten"\. Did you mean "listen"\?/);
    const badFlag = await run(["listen", "--forwad", "3000"]);
    assert.equal(badFlag.code, 2);
    assert.match(badFlag.stderr, /Did you mean --forward\?/);
  });

  test("listen --forward: prints the URL, streams requests, forwards them byte-for-byte", async () => {
    const home = mkdtempSync(join(tmpdir(), "whtk-listen-"));
    const child = spawnCli(["listen", "--forward", `${target.url}/webhooks`, "--json", "--base-url", mock.url], home);
    try {
      const ready = await nextJson(child, (o) => o.type === "listening");
      const endpoint = ready.endpoint as { url: string; token: string; expiresAt: string };
      assert.equal(ready.forward, `${target.url}/webhooks`);
      assert.ok(endpoint.expiresAt);

      const signed = sign("stripe", { secret: "whsec_cli", event: "invoice.paid" });
      const received = target.next();
      const requestLine = nextJson(child, (o) => o.type === "request");
      const forwardLine = nextJson(child, (o) => o.type === "forward");
      const res = await fetch(`${endpoint.url}/stripe?attempt=1`, {
        method: "POST",
        headers: { ...signed.headers, "X-Custom": "kept" },
        body: signed.body,
      });
      assert.equal(res.status, 200);

      const got = await received;
      assert.equal(got.method, "POST");
      assert.equal(got.url, "/webhooks/stripe?attempt=1");
      assert.equal(got.body, signed.body);
      assert.equal(got.headers["stripe-signature"], signed.headers["Stripe-Signature"]);
      assert.equal(got.headers["x-custom"], "kept");
      assert.equal(got.headers["content-type"], "application/json");
      // The forwarded delivery still verifies against the secret.
      assert.equal(verify("stripe", { secret: "whsec_cli", rawBody: got.body, headers: got.headers }).valid, true);

      const req = (await requestLine).request as { provider: string; event: string; path: string };
      assert.equal(req.provider, "stripe");
      assert.equal(req.event, "invoice.paid");
      assert.equal(req.path, "/stripe");
      const fwd = await forwardLine;
      assert.equal(fwd.status, 202);
      assert.equal(fwd.url, `${target.url}/webhooks/stripe?attempt=1`);

      const saved = JSON.parse(readFileSync(join(home, "webhook-toolkit", "config.json"), "utf8")) as { lastEndpoint: { token: string } };
      assert.equal(saved.lastEndpoint.token, endpoint.token);
    } finally {
      child.kill("SIGINT");
    }
    assert.equal(await exitOf(child), 0);

    // Second run reuses the saved URL; --new creates another one.
    const again = spawnCli(["listen", "--json", "--base-url", mock.url], home);
    const reused = await nextJson(again, (o) => o.type === "listening");
    again.kill("SIGINT");
    await exitOf(again);
    assert.equal(reused.reused, true);
    const fresh = spawnCli(["listen", "--json", "--new", "--base-url", mock.url], home);
    const created = await nextJson(fresh, (o) => o.type === "listening");
    fresh.kill("SIGINT");
    await exitOf(fresh);
    assert.equal(created.reused, false);
    assert.notEqual((created.endpoint as { token: string }).token, (reused.endpoint as { token: string }).token);
  });

  test("listen (human output) shows URL, inspector, expiry warning and forward failures", async () => {
    const home = mkdtempSync(join(tmpdir(), "whtk-listen-h-"));
    const down = await deadUrl();
    const child = spawnCli(["listen", "-f", `${down}/down`, "--base-url", mock.url], home);
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    try {
      await until(() => out.includes("Waiting for webhooks"), "the listen header");
      const token = /\/r\/(\S+)/.exec(out)?.[1] as string;
      assert.match(out, /Webhook URL {3}http:\/\/127\.0\.0\.1:\d+\/r\//);
      assert.match(out, /Inspector {5}http/);
      assert.match(out, /Expires {7}in 7 days \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)\n {16}Anonymous URL/);
      assert.match(out, /webhook-toolkit login/);
      mock.inject(token, { path: "/gh", headers: { "x-github-event": "push" }, body: "{}" });
      await until(() => out.includes("connection refused"), `the forward failure line, got:\n${out}`);
      assert.match(out, /POST {3}\/gh {2}github push/);
      assert.ok(out.includes(`connection refused (is ${down} running?)`), out);
    } finally {
      child.kill("SIGINT");
    }
    await exitOf(child);
  });

  test("sign: prints headers + curl, --json, --send to a local handler", async () => {
    const human = await run(["sign", "stripe", "--secret", "whsec_x", "--timestamp", "1726000000", "-e", "checkout.session.completed"]);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /Stripe-Signature: t=1726000000,v1=[0-9a-f]{64}/);
    assert.match(human.stdout, /curl -X POST http:\/\/localhost:3000\/webhooks/);

    const json = await run(["sign", "github", "-s", "gh", "-d", '{"zen":"Keep it logically awesome."}', "--json"]);
    const out = JSON.parse(json.stdout) as { headers: Record<string, string>; body: string; curl: string };
    assert.equal(out.body, '{"zen":"Keep it logically awesome."}');
    assert.equal(verify("github", { secret: "gh", rawBody: out.body, headers: out.headers }).valid, true);

    const received = target.next();
    const sent = await run(["sign", "shopify", "--secret", "shp", "--send", `${target.url}/shopify`, "--event", "products/update"]);
    assert.equal(sent.code, 0);
    assert.match(sent.stdout, /202 Accepted/);
    const got = await received;
    assert.equal(got.headers["x-shopify-topic"], "products/update");
    assert.equal(verify("shopify", { secret: "shp", rawBody: got.body, headers: got.headers }).valid, true);

    const twilio = await run(["sign", "twilio", "--secret", "tok"]);
    assert.equal(twilio.code, 2);
    assert.match(twilio.stderr, /--url/);
    const unknown = await run(["sign", "strpe", "--secret", "x"]);
    assert.match(unknown.stderr, /Did you mean stripe\?/);
  });

  test("verify: valid (exit 0) and invalid with the cause (exit 1), body from a file or stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "whtk-verify-"));
    const body = '{"type":"invoice.paid"}';
    const signed = sign("stripe", { secret: "whsec_v", payload: body });
    const file = join(dir, "body.json");
    writeFileSync(file, body);
    const header = `Stripe-Signature: ${signed.headers["Stripe-Signature"]}`;

    const ok = await run(["verify", "stripe", "--secret", "whsec_v", "--body-file", file, "-H", header]);
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /Valid Stripe signature/);

    writeFileSync(file, `${body}\n`);
    const bad = await run(["verify", "stripe", "--secret", "whsec_v", "--body-file", file, "-H", header]);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /Invalid Stripe signature \(body_trailing_newline_added\)/);
    assert.match(bad.stdout, /expected  t=/);

    const stdin = await run(["verify", "stripe", "--secret", "whsec_v", "--body-file", "-", "-H", header, "--json"], undefined, body);
    assert.equal((JSON.parse(stdin.stdout) as { valid: boolean }).valid, true);
  });

  test("requests, replay, endpoints", async () => {
    const home = mkdtempSync(join(tmpdir(), "whtk-req-"));
    const ep = await (await fetch(`${mock.url}/api/v1/endpoints`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).json() as {
      endpoint: { token: string };
    };
    const token = ep.endpoint.token;
    const empty = await run(["requests", token, "--base-url", mock.url], home);
    assert.match(empty.stdout, /No requests yet/);

    const captured = mock.inject(token, { path: "/billing", query: "v=2", headers: { "paddle-signature": "ts=1;h1=x", "content-type": "application/json" }, body: '{"event_type":"subscription.created"}' });
    const table = await run(["requests", token, "--base-url", mock.url], home);
    assert.match(table.stdout, /TIME\s+ID\s+METHOD\s+PATH\s+FROM\s+SIZE/);
    assert.match(table.stdout, new RegExp(`${captured.id}\\s+POST\\s+/billing\\?v=2\\s+paddle subscription\\.created`));
    const json = JSON.parse((await run(["requests", token, "--json", "--base-url", mock.url], home)).stdout) as { id: string }[];
    assert.equal(json[0]?.id, captured.id);

    const received = target.next();
    const replay = await run(["replay", token, captured.id, "--to", `${target.url}/hooks`, "--base-url", mock.url], home);
    assert.equal(replay.code, 0);
    assert.match(replay.stdout, /202 Accepted/);
    const got = await received;
    assert.equal(got.url, "/hooks/billing?v=2");
    assert.equal(got.body, '{"event_type":"subscription.created"}');
    assert.equal(got.headers["paddle-signature"], "ts=1;h1=x");

    const noKey = await run(["endpoints", "--base-url", mock.url], home);
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr, /needs an API key/);
  });

  test("login / whoami / logout, key saved with mode 600", async () => {
    const home = mkdtempSync(join(tmpdir(), "whtk-login-"));
    const bad = await run(["login", "--key", "whk_nope", "--base-url", mock.url], home);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /refused/);

    const ok = await run(["login", "--key", KEY, "--base-url", mock.url], home);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Logged in as cli@example\.com \(pro plan/);
    const path = join(home, "webhook-toolkit", "config.json");
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { apiKey: string; baseUrl: string };
    assert.equal(cfg.apiKey, KEY);
    assert.equal(cfg.baseUrl, mock.url);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);

    // The saved key and base URL are used without flags.
    const who = await run(["whoami"], home);
    assert.equal(who.code, 0);
    assert.match(who.stdout, /cli@example\.com {2}pro/);
    assert.equal((await run(["endpoints"], home)).code, 0);

    // Key piped on stdin (non-interactive login).
    const home2 = mkdtempSync(join(tmpdir(), "whtk-login2-"));
    assert.equal((await run(["login", "--base-url", mock.url], home2, `${KEY}\n`)).code, 0);

    assert.match((await run(["logout"], home)).stdout, /Logged out/);
    const anon = await run(["whoami"], home);
    assert.equal(anon.code, 1);
    assert.match(anon.stdout, /Not logged in/);
  });

  test("relay without a token explains how to get one", async () => {
    const res = await run(["relay", "--to", "3000", "--base-url", mock.url]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /No relay token/);
    assert.match(res.stderr, /\/pricing/);
    assert.match(res.stderr, /listen --forward/);
  });
});
