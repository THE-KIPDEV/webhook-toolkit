import { describeNetworkError, WebhookToolkitError } from "./errors.js";
import type { CapturedRequest } from "./types.js";

export interface ForwardOptions {
  /** Default 30 000 ms. */
  timeoutMs?: number;
  /** Response body bytes kept in the result. Default 64 KiB. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /** Headers added/overridden on the forwarded request. */
  extraHeaders?: Record<string, string>;
}

export interface ForwardResult {
  /** The URL actually called. */
  url: string;
  status: number;
  statusText: string;
  /** Round-trip time in ms. */
  ms: number;
  headers: Record<string, string>;
  body: string;
  /** True when the response body was longer than `maxResponseBytes`. */
  truncated: boolean;
}

export type ForwardableRequest = Pick<CapturedRequest, "method" | "path" | "query" | "headers" | "body">;

/**
 * Headers never re-sent: hop-by-hop headers (RFC 9110 §7.6.1), `host`, `content-length`
 * (recomputed), and `expect`/`transfer-encoding` which fetch refuses.
 */
export const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "http2-settings",
]);

/** Copy of `headers` without the ones in `DROPPED_HEADERS`. */
export function forwardableHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (DROPPED_HEADERS.has(k) || k.startsWith(":")) continue;
    out[k] = value;
  }
  return out;
}

/**
 * `"3000"` → `http://localhost:3000`, `"localhost:3000/hooks"` → `http://localhost:3000/hooks`.
 * Full URLs are returned unchanged.
 */
export function normalizeTarget(target: string): string {
  const t = target.trim();
  if (/^\d{1,5}$/.test(t)) return `http://localhost:${t}`;
  if (/^:\d{1,5}(\/.*)?$/.test(t)) return `http://localhost${t}`;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookToolkitError(`Invalid target "${target}": expected a port (3000) or a URL (http://localhost:3000/webhooks).`, {
      code: "invalid_input",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebhookToolkitError(`Invalid target "${target}": only http(s) is supported.`, { code: "invalid_input" });
  }
  return url;
}

/**
 * Where a captured request lands: the target, plus the captured sub-path (when not `/`)
 * and query string. `http://localhost:3000/hooks` + `/stripe?x=1` → `http://localhost:3000/hooks/stripe?x=1`.
 */
export function buildForwardUrl(target: string, path: string, query: string): string {
  const url = new URL(normalizeTarget(target));
  const sub = path && path !== "/" ? path : "";
  if (sub) url.pathname = url.pathname.replace(/\/+$/, "") + (sub.startsWith("/") ? sub : `/${sub}`);
  if (query) {
    const extra = query.replace(/^\?/, "");
    url.search = url.search ? `${url.search}&${extra}` : `?${extra}`;
  }
  return url.toString();
}

/**
 * Re-sends a captured request FROM THIS MACHINE (so `localhost` works): same method,
 * headers (minus hop-by-hop, host and content-length) and body.
 */
export async function forwardRequest(
  request: ForwardableRequest,
  target: string,
  options: ForwardOptions = {},
): Promise<ForwardResult> {
  const url = buildForwardUrl(target, request.path, request.query);
  const method = request.method.toUpperCase();
  const headers = { ...forwardableHeaders(request.headers), ...(options.extraHeaders ?? {}) };
  const hasBody = method !== "GET" && method !== "HEAD";
  const doFetch = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxResponseBytes ?? 64 * 1024;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 30_000);

  const started = performance.now();
  try {
    const res = await doFetch(url, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Math.round(performance.now() - started);
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });
    return {
      url,
      status: res.status,
      statusText: res.statusText,
      ms,
      headers: resHeaders,
      body: buf.subarray(0, maxBytes).toString("utf8"),
      truncated: buf.length > maxBytes,
    };
  } catch (err) {
    const reason = timedOut ? `no response after ${Math.round((options.timeoutMs ?? 30_000) / 1000)}s` : describeNetworkError(err);
    throw new WebhookToolkitError(`${method} ${url} failed: ${reason}`, { code: "forward_failed", cause: err });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
