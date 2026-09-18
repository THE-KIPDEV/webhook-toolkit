import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, UsageError } from "../src/cli/args.js";
import { colorEnabled, createColors, formatBytes, formatRelative, shellQuote, table } from "../src/cli/ui.js";
import { configPath, readConfig, writeConfig } from "../src/config.js";
import { buildForwardUrl, forwardableHeaders, normalizeBaseUrl, normalizeCapturedRequest, normalizeTarget, VERSION } from "../src/index.js";
import { SseParser, type SseMessage } from "../src/sse.js";

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test("parseArgs: long/short/inline/repeated flags, booleans, numbers, positionals", () => {
  const spec = {
    forward: { type: "string", short: "f" },
    json: { type: "boolean" },
    limit: { type: "number", short: "n" },
    header: { type: "string", short: "H", multiple: true },
  } as const;
  const { flags, positionals } = parseArgs(
    ["tok", "--forward", "http://x", "--json", "-n", "5", "-H", "A: 1", "--header=B: 2", "--", "--not-a-flag"],
    spec,
  );
  assert.deepEqual(flags, { forward: "http://x", json: true, limit: 5, header: ["A: 1", "B: 2"] });
  assert.deepEqual(positionals, ["tok", "--not-a-flag"]);
  assert.deepEqual(parseArgs(["--no-json", "-f=3000"], spec).flags, { json: false, forward: "3000" });
  // A value may start with a dash when it is not a known flag.
  assert.equal(parseArgs(["--forward", "-weird"], spec).flags.forward, "-weird");

  assert.throws(() => parseArgs(["--forwrd", "x"], spec), (e: unknown) => e instanceof UsageError && /Did you mean --forward\?/.test(e.message));
  assert.throws(() => parseArgs(["--forward"], spec), /needs a value/);
  assert.throws(() => parseArgs(["--forward", "--json"], spec), /needs a value/);
  assert.throws(() => parseArgs(["-n", "abc"], spec), /expects a number/);
  assert.throws(() => parseArgs(["--json=yes"], spec), /does not take a value/);
  assert.throws(() => parseArgs(["-z"], spec), /Unknown option -z/);
});

test("forward helpers: targets, URL joining, header filtering", () => {
  assert.equal(normalizeTarget("3000"), "http://localhost:3000");
  assert.equal(normalizeTarget(":8080/hooks"), "http://localhost:8080/hooks");
  assert.equal(normalizeTarget("localhost:3000/webhooks"), "http://localhost:3000/webhooks");
  assert.equal(normalizeTarget("https://api.example.com/x"), "https://api.example.com/x");
  assert.throws(() => normalizeTarget("ftp://x"), /only http/);

  assert.equal(buildForwardUrl("http://localhost:3000/webhooks", "/", ""), "http://localhost:3000/webhooks");
  assert.equal(buildForwardUrl("http://localhost:3000/webhooks/", "/stripe", "a=1"), "http://localhost:3000/webhooks/stripe?a=1");
  assert.equal(buildForwardUrl("3000", "/gh", ""), "http://localhost:3000/gh");
  assert.equal(buildForwardUrl("http://h/x?token=1", "/", "b=2"), "http://h/x?token=1&b=2");

  assert.deepEqual(
    forwardableHeaders({ host: "a", "content-length": "3", connection: "keep-alive", "transfer-encoding": "chunked", expect: "100-continue", "stripe-signature": "t=1", "X-Custom": "y" }),
    { "stripe-signature": "t=1", "x-custom": "y" },
  );
});

test("normalizeBaseUrl and normalizeCapturedRequest", () => {
  assert.equal(normalizeBaseUrl("https://webhook-toolkit.com/api/v1/"), "https://webhook-toolkit.com");
  assert.equal(normalizeBaseUrl("http://localhost:3000"), "http://localhost:3000");
  assert.throws(() => normalizeBaseUrl("nope"), /Invalid base URL/);

  const req = normalizeCapturedRequest("tok", {
    id: "1",
    method: "POST",
    path: "/r/tok/stripe",
    query: "?x=1",
    headers: { "stripe-signature": "t=1,v1=a" },
    body: '{"type":"invoice.paid"}',
    contentType: "application/json",
    size: 10,
    ip: "",
    country: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as never);
  assert.equal(req.path, "/stripe");
  assert.equal(req.query, "x=1");
  assert.equal(req.provider, "stripe");
  assert.equal(req.event, "invoice.paid");
  // Server-provided nulls are kept.
  const kept = normalizeCapturedRequest("tok", { ...req, path: "/", provider: null, event: null });
  assert.equal(kept.provider, null);
});

test("SSE parser: fields, multi-line data, comments, CRLF and split chunks", () => {
  const got: SseMessage[] = [];
  const p = new SseParser((m) => got.push(m));
  p.feed(": keep-alive\n\nevent: hello\ndata: {\"a\":1}\n\n");
  p.feed("event: request\r\ndata: line1\r\ndata: line2\r");
  p.feed("\n\r\nid: 7\ndata: x");
  p.feed("y\n\n");
  assert.deepEqual(got, [
    { event: "hello", data: '{"a":1}', id: undefined },
    { event: "request", data: "line1\nline2", id: undefined },
    { event: "message", data: "xy", id: "7" },
  ]);
});

test("config: XDG path, mode 600, round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "whtk-cfg-"));
  const path = configPath({ XDG_CONFIG_HOME: dir });
  assert.equal(path, join(dir, "webhook-toolkit", "config.json"));
  assert.deepEqual(readConfig(path), {});
  writeConfig({ apiKey: "whk_x" }, path);
  assert.deepEqual(readConfig(path), { apiKey: "whk_x" });
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("ui helpers: NO_COLOR, FORCE_COLOR, formatting, shell quoting", () => {
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(colorEnabled({ isTTY: false }, {}), false);
  assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  assert.equal(colorEnabled({ isTTY: true }, {}), true);
  assert.equal(createColors(true).red("x"), "\u001b[31mx\u001b[39m");
  assert.equal(createColors(false).red("x"), "x");
  // Column widths ignore ANSI sequences.
  assert.equal(table(createColors(true), ["A", "B"], [[createColors(true).green("ok"), "1"]]).split("\n")[1], "\u001b[32mok\u001b[39m  1");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatRelative(new Date(Date.now() + 7 * 86_400_000 + 5000).toISOString()), "in 7 days");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("http://localhost:3000/x"), "http://localhost:3000/x");
});
