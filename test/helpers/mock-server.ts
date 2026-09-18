/**
 * In-process mock of the webhook-toolkit.com v1 contract (API-V1.md), enough to test the
 * client, the CLI and the MCP server without network:
 *   REST /api/v1 (endpoints, requests, wait long-poll, SSE stream, explain, me, relays),
 *   capture URLs /r/<token>/…, and the relay (WS /__relay + /relay/<slug>/… ingress).
 */
import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { detectProvider } from "../../src/detect.js";
import type { CapturedRequest, Endpoint } from "../../src/types.js";

export interface MockCall {
  method: string;
  path: string;
  query: string;
  authorization: string | undefined;
}

interface Stored {
  endpoint: Endpoint;
  requests: CapturedRequest[]; // oldest first
  owner: string | null;
  expired: boolean;
}

export interface MockServerOptions {
  /** Valid API keys → account email. */
  keys?: Record<string, string>;
  /** Answer /explain with 402 (trials exhausted). */
  explainPaywall?: boolean;
  /** Relay tokens → slug. */
  relays?: Record<string, string>;
  /** SSE keep-alive period in ms. */
  keepAliveMs?: number;
  /** Cap of the long-poll (the real API caps at 55 s); small values exercise multi-round waits. */
  maxWaitSeconds?: number;
}

export interface MockServer {
  url: string;
  calls: MockCall[];
  endpoints: Map<string, Stored>;
  /** Stores a request as if it had hit /r/<token>. */
  inject(token: string, req: { method?: string; path?: string; query?: string; headers?: Record<string, string>; body?: string }): CapturedRequest;
  /** Marks an endpoint expired (410 from then on). */
  expire(token: string): void;
  /** Closes every open SSE stream (simulates a network drop). */
  dropStreams(): void;
  close(): Promise<void>;
}

const UPGRADE_URL = "https://webhook-toolkit.com/pricing";

export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const keys = options.keys ?? {};
  const relays = options.relays ?? {};
  const endpoints = new Map<string, Stored>();
  const waiters = new Map<string, Set<(r: CapturedRequest) => void>>();
  const streams = new Map<string, Set<ServerResponse>>();
  const calls: MockCall[] = [];
  const sockets = new Set<Socket>();
  const tunnels = new Map<string, { ws: WebSocket; pending: Map<string, (msg: Record<string, unknown>) => void> }>();
  let lastTs = 0;
  let seq = 0;
  let base = "";

  const now = () => {
    // Strictly increasing timestamps, so "after" cursors are unambiguous.
    const t = Math.max(Date.now(), lastTs + 1);
    lastTs = t;
    return new Date(t).toISOString();
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const error = (res: ServerResponse, status: number, code: string, message: string, upgrade = false) =>
    send(res, status, upgrade ? { error: code, message, upgradeUrl: UPGRADE_URL } : { error: code, message });

  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  const makeEndpoint = (name: string, owner: string | null): Stored => {
    const token = randomBytes(9).toString("base64url");
    const createdAt = now();
    const endpoint: Endpoint = {
      id: `ep_${++seq}`,
      token,
      name,
      url: `${base}/r/${token}`,
      inspectUrl: `${base}/e/${token}`,
      expiresAt: owner ? null : new Date(Date.parse(createdAt) + 7 * 86_400_000).toISOString(),
      requestCount: 0,
      createdAt,
      response: { status: 200, body: '{"ok":true}', contentType: "application/json" },
    };
    const stored = { endpoint, requests: [], owner, expired: false };
    endpoints.set(token, stored);
    return stored;
  };

  const capture: MockServer["inject"] = (token, input) => {
    const stored = endpoints.get(token);
    if (!stored) throw new Error(`unknown token ${token}`);
    const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = input.body ?? "";
    const detected = detectProvider(headers, body);
    const req: CapturedRequest = {
      id: `req_${++seq}`,
      method: input.method ?? "POST",
      path: input.path ?? "/",
      query: input.query ?? "",
      headers,
      body,
      contentType: headers["content-type"] ?? "",
      size: Buffer.byteLength(body),
      ip: "127.0.0.1",
      country: "",
      createdAt: now(),
      provider: detected.provider,
      event: detected.event,
    };
    stored.requests.push(req);
    stored.endpoint.requestCount++;
    for (const w of waiters.get(token) ?? []) w(req);
    for (const res of streams.get(token) ?? []) res.write(`event: request\ndata: ${JSON.stringify(req)}\n\n`);
    return req;
  };

  const auth = (req: IncomingMessage): string | null => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return null;
    return keys[h.slice(7)] ?? null;
  };

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";
    const account = auth(req);
    if (req.headers.authorization && !account) return error(res, 401, "unauthorized", "Invalid API key.");
    const body = ["POST", "PATCH", "PUT"].includes(method) ? (await readBody(req)).toString("utf8") : "";
    let json: Record<string, unknown> = {};
    if (body) {
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return error(res, 400, "bad_request", "Invalid JSON body.");
      }
    }

    if (parts[0] === "me" && method === "GET") {
      if (!account) return error(res, 401, "unauthorized", "API key required.");
      return send(res, 200, { email: account, plan: "pro", planActiveUntil: "2026-12-31T00:00:00.000Z", limits: { endpoints: 25, retentionDays: 30 } });
    }
    if (parts[0] === "relays") {
      if (!account) return error(res, 401, "unauthorized", "API key required.");
      const list = Object.entries(relays).map(([token, slug], i) => ({ id: `rl_${i}`, slug, token, name: slug, publicUrl: `${base}/relay/${slug}`, lastSeen: null }));
      if (method === "GET") return send(res, 200, { relays: list });
      return error(res, 402, "upgrade_required", "The relay needs a Pass or Pro plan.", true);
    }
    if (parts[0] !== "endpoints") return error(res, 404, "not_found", "Unknown route.");

    if (parts.length === 1) {
      if (method === "POST") {
        const stored = makeEndpoint(typeof json.name === "string" ? json.name : "Untitled", account);
        return send(res, 201, { endpoint: stored.endpoint });
      }
      if (method === "GET") {
        if (!account) return error(res, 401, "unauthorized", "API key required.");
        return send(res, 200, { endpoints: [...endpoints.values()].filter((s) => s.owner === account).map((s) => s.endpoint) });
      }
      return error(res, 400, "bad_request", "Unsupported method.");
    }

    const token = parts[1] as string;
    const stored = endpoints.get(token);
    if (!stored) return error(res, 404, "not_found", "Unknown endpoint.");
    if (stored.expired) return error(res, 410, "expired", "This anonymous endpoint expired.");
    const sub = parts.slice(2);

    if (sub.length === 0) {
      if (method === "GET") return send(res, 200, { endpoint: stored.endpoint });
      if (stored.owner && stored.owner !== account) return error(res, 403, "forbidden", "Owned by another account.");
      if (method === "PATCH") {
        if (typeof json.name === "string") stored.endpoint.name = json.name;
        if (json.response && typeof json.response === "object") Object.assign(stored.endpoint.response, json.response);
        return send(res, 200, { endpoint: stored.endpoint });
      }
      if (method === "DELETE") {
        endpoints.delete(token);
        return send(res, 200, { ok: true });
      }
    }

    if (sub[0] === "requests" && sub.length === 1) {
      if (method === "DELETE") {
        stored.requests = [];
        return send(res, 200, { ok: true });
      }
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
      const after = url.searchParams.get("after");
      const list = stored.requests.filter((r) => !after || r.createdAt > after).slice().reverse().slice(0, limit);
      return send(res, 200, { requests: list });
    }
    if (sub[0] === "requests" && sub.length >= 2) {
      const found = stored.requests.find((r) => r.id === sub[1]);
      if (!found) return error(res, 404, "not_found", "Unknown request.");
      if (sub.length === 2) return send(res, 200, { request: found });
      if (sub[2] === "explain") {
        if (options.explainPaywall) {
          return error(res, 402, "upgrade_required", "You used your 3 free AI explanations. Upgrade to Pro for unlimited explanations.", true);
        }
        return send(res, 200, {
          result: {
            mode: "explain",
            provider: found.provider,
            event: found.event,
            summary: `A ${found.event ?? "webhook"} event.`,
            keyFields: [],
            signature: { header: null, algorithm: null, howToVerify: "n/a" },
            pitfalls: [],
          },
          trialsLeft: 2,
        });
      }
    }
    if (sub[0] === "wait") {
      const timeout = Math.min(options.maxWaitSeconds ?? 55, Math.max(1, Number(url.searchParams.get("timeout") ?? 30)));
      // The server's "now" is never earlier than the last timestamp it handed out.
      const after = url.searchParams.get("after") ?? new Date(Math.max(Date.now(), lastTs)).toISOString();
      const ready = stored.requests.find((r) => r.createdAt > after);
      if (ready) return send(res, 200, { request: ready });
      let set = waiters.get(token);
      if (!set) waiters.set(token, (set = new Set()));
      const waiter = (r: CapturedRequest) => {
        if (r.createdAt <= after) return;
        cleanup();
        send(res, 200, { request: r });
      };
      const timer = setTimeout(() => {
        cleanup();
        send(res, 200, { request: null, timedOut: true });
      }, timeout * 1000);
      const cleanup = () => {
        clearTimeout(timer);
        set?.delete(waiter);
      };
      res.on("close", cleanup);
      set.add(waiter);
      return;
    }
    if (sub[0] === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: hello\ndata: ${JSON.stringify({ endpointId: stored.endpoint.id })}\n\n`);
      let set = streams.get(token);
      if (!set) streams.set(token, (set = new Set()));
      set.add(res);
      const ka = setInterval(() => res.write(": keep-alive\n\n"), options.keepAliveMs ?? 20_000);
      res.on("close", () => {
        clearInterval(ka);
        set?.delete(res);
      });
      return;
    }
    return error(res, 404, "not_found", "Unknown route.");
  }

  async function handleRelayIngress(req: IncomingMessage, res: ServerResponse, slug: string, rest: string, query: string) {
    const tunnel = tunnels.get(slug);
    if (!tunnel) return send(res, 502, { error: "Relay offline", slug });
    const body = await readBody(req);
    const id = String(++seq);
    const reply = new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000);
      tunnel.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
    tunnel.ws.send(JSON.stringify({ type: "request", id, method: req.method, path: rest || "/", query, headers: req.headers, body: body.toString("base64") }));
    const msg = await reply;
    if (!msg) return send(res, 504, { error: "Relay timeout" });
    res.writeHead(Number(msg.status ?? 200), (msg.headers as Record<string, string>) ?? {});
    res.end(Buffer.from(String(msg.body ?? ""), "base64"));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    calls.push({ method: req.method ?? "GET", path: url.pathname, query: url.search, authorization: req.headers.authorization });
    const capt = url.pathname.match(/^\/r\/([^/]+)(\/.*)?$/);
    if (capt) {
      const token = capt[1] as string;
      const stored = endpoints.get(token);
      if (!stored) return error(res, 404, "not_found", "Unknown endpoint.");
      void readBody(req).then((buf) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        capture(token, { method: req.method ?? "GET", path: capt[2] ?? "/", query: url.search.replace(/^\?/, ""), headers, body: buf.toString("utf8") });
        res.writeHead(stored.endpoint.response.status, { "content-type": stored.endpoint.response.contentType });
        res.end(stored.endpoint.response.body);
      });
      return;
    }
    const relay = url.pathname.match(/^\/relay\/([^/]+)(\/.*)?$/);
    if (relay) return void handleRelayIngress(req, res, relay[1] as string, relay[2] ?? "/", url.search.replace(/^\?/, ""));
    if (url.pathname.startsWith("/api/v1")) {
      handleApi(req, res, url).catch((err: unknown) => error(res, 500, "server_error", String(err)));
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html>not found</html>");
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const slug = relays[url.searchParams.get("token") ?? ""];
    if (url.pathname !== "/__relay" || !slug) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tunnel = { ws, pending: new Map<string, (msg: Record<string, unknown>) => void>() };
      tunnels.set(slug, tunnel);
      ws.send(JSON.stringify({ type: "ready", slug }));
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === "response") tunnel.pending.get(String(msg.id))?.(msg);
      });
      ws.on("close", () => {
        if (tunnels.get(slug) === tunnel) tunnels.delete(slug);
      });
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    calls,
    endpoints,
    inject: capture,
    expire(token) {
      const s = endpoints.get(token);
      if (s) s.expired = true;
    },
    dropStreams() {
      for (const set of streams.values()) for (const res of set) res.socket?.destroy();
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A local HTTP server recording what it receives (the "app under test"). */
export interface TargetServer {
  url: string;
  received: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  /** Resolves with the next request received. */
  next(): Promise<TargetServer["received"][number]>;
  close(): Promise<void>;
}

export async function startTargetServer(
  handler: (req: { method: string; url: string; body: string }) => { status: number; body?: string; headers?: Record<string, string> } = () => ({
    status: 200,
    body: '{"received":true}',
    headers: { "content-type": "application/json" },
  }),
): Promise<TargetServer> {
  const received: TargetServer["received"] = [];
  let pending: ((r: TargetServer["received"][number]) => void)[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(entry);
      const out = handler(entry);
      res.writeHead(out.status, out.headers ?? {});
      res.end(out.body ?? "");
      const waiting = pending;
      pending = [];
      for (const p of waiting) p(entry);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    next: () => new Promise((resolve) => pending.push(resolve)),
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
