import WebSocket from "ws";
import { describeNetworkError, WebhookToolkitError } from "./errors.js";
import { buildForwardUrl, forwardableHeaders, normalizeTarget } from "./forward.js";

/**
 * Relay wire protocol (same as https://webhook-toolkit.com/relay.js):
 *   CLI → wss://<host>/__relay?token=<relayToken>
 *   ← {type:"ready", slug}
 *   ← {type:"request", id, method, path, query, headers, body(base64)}
 *   → {type:"response", id, status, headers, body(base64)}   (within 30 s)
 */

export type RelayEvent =
  | { type: "connecting"; url: string; attempt: number }
  | { type: "ready"; slug: string; publicUrl: string }
  | {
      type: "request";
      id: string;
      method: string;
      path: string;
      status: number;
      ms: number;
      bytes: number;
      /** Set when the local target could not be reached (the caller got a 502). */
      error?: string;
    }
  | { type: "disconnected"; code: number; reason: string; retryInMs: number };

export interface RelayOptions {
  /** Relay token from the dashboard (paid plans). */
  token: string;
  /** Local target: a port (`3000`) or URL (`http://localhost:3000/webhooks`). */
  target: string;
  /** Site origin, e.g. https://webhook-toolkit.com. */
  baseUrl: string;
  onEvent?: (event: RelayEvent) => void;
  signal?: AbortSignal;
  /** Local request timeout. The server gives up after 30 s, so keep it below. Default 28 000. */
  localTimeoutMs?: number;
  /** Reconnect when the server sent nothing (not even a ping) for this long. Default 70 000. */
  idleTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface RelayRequestMessage {
  type: "request";
  id: string;
  method: string;
  path?: string;
  query?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: string;
}

/** Response headers that must not be relayed back (fetch already decoded the body). */
const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

export function relayWebSocketUrl(baseUrl: string, token: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = "/__relay";
  u.search = `?token=${encodeURIComponent(token)}`;
  return u.toString();
}

/** Answers one relayed request by calling the local target. Never throws. */
export async function handleRelayRequest(
  msg: RelayRequestMessage,
  target: string,
  opts: { timeoutMs?: number; fetch?: typeof globalThis.fetch } = {},
): Promise<{ response: { type: "response"; id: string; status: number; headers: Record<string, string>; body: string }; ms: number; error?: string }> {
  const started = performance.now();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg.headers ?? {})) {
    if (v === undefined) continue;
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  const method = (msg.method || "GET").toUpperCase();
  const url = buildForwardUrl(target, msg.path || "/", msg.query || "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(url, {
      method,
      headers: forwardableHeaders(headers),
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.from(msg.body ?? "", "base64"),
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 28_000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      if (!DROPPED_RESPONSE_HEADERS.has(key)) respHeaders[key] = value;
    });
    return {
      response: { type: "response", id: msg.id, status: res.status, headers: respHeaders, body: buf.toString("base64") },
      ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    const detail = describeNetworkError(err);
    return {
      response: {
        type: "response",
        id: msg.id,
        status: 502,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ error: "relay target unreachable", detail })).toString("base64"),
      },
      ms: Math.round(performance.now() - started),
      error: detail,
    };
  }
}

/**
 * Connects a relay and keeps it connected (exponential backoff, 1 s → 15 s) until `signal`
 * aborts. Rejects with a `WebhookToolkitError` (code `unauthorized`) when the token is refused.
 */
export function runRelay(options: RelayOptions): Promise<void> {
  const target = normalizeTarget(options.target);
  const wsUrl = relayWebSocketUrl(options.baseUrl, options.token);
  const emit = options.onEvent ?? (() => {});
  const idleMs = options.idleTimeoutMs ?? 70_000;

  return new Promise<void>((resolve, reject) => {
    let delay = 1000;
    let attempt = 0;
    let ws: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(retryTimer);
      clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        ws?.terminate();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => finish();
    if (options.signal?.aborted) return finish();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const unauthorized = () =>
      finish(
        new WebhookToolkitError("The relay token was refused (401).", {
          status: 401,
          code: "unauthorized",
          upgradeUrl: `${options.baseUrl.replace(/\/+$/, "")}/pricing`,
        }),
      );

    const connect = () => {
      if (settled) return;
      attempt++;
      emit({ type: "connecting", url: wsUrl.replace(/token=[^&]+/, "token=***"), attempt });
      const socket = new WebSocket(wsUrl, { handshakeTimeout: 15_000 });
      ws = socket;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => socket.terminate(), idleMs);
      };

      socket.on("unexpected-response", (_req, res) => {
        if (res.statusCode === 401 || res.statusCode === 403) unauthorized();
        else socket.terminate();
      });
      socket.on("open", () => {
        delay = 1000;
        armIdle();
      });
      socket.on("ping", armIdle);
      socket.on("message", (data) => {
        armIdle();
        let msg: { type?: string; slug?: string; id?: unknown };
        try {
          msg = JSON.parse(data.toString()) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === "ready" && msg.slug) {
          emit({ type: "ready", slug: msg.slug, publicUrl: `${options.baseUrl.replace(/\/+$/, "")}/relay/${msg.slug}` });
          return;
        }
        if (msg.type !== "request" || typeof msg.id !== "string") return;
        const request = msg as unknown as RelayRequestMessage;
        const handleOpts: { timeoutMs?: number; fetch?: typeof globalThis.fetch } = {};
        if (options.localTimeoutMs !== undefined) handleOpts.timeoutMs = options.localTimeoutMs;
        if (options.fetch) handleOpts.fetch = options.fetch;
        void handleRelayRequest(request, target, handleOpts).then(({ response, ms, error }) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
          emit({
            type: "request",
            id: request.id,
            method: (request.method || "GET").toUpperCase(),
            path: (request.path || "/") + (request.query ? `?${request.query}` : ""),
            status: response.status,
            ms,
            bytes: Buffer.byteLength(response.body, "base64"),
            ...(error ? { error } : {}),
          });
        });
      });
      socket.on("error", () => {
        /* "close" follows and schedules the reconnection */
      });
      socket.on("close", (code, reasonBuf) => {
        clearTimeout(idleTimer);
        if (settled) return;
        if (code === 1008 || code === 4001) return unauthorized();
        const retryInMs = delay;
        emit({ type: "disconnected", code, reason: reasonBuf.toString(), retryInMs });
        retryTimer = setTimeout(connect, retryInMs);
        delay = Math.min(delay * 2, 15_000);
      });
    };

    connect();
  });
}

