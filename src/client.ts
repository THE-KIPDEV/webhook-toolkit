import { detectProvider } from "./detect.js";
import { codeForStatus, describeNetworkError, WebhookToolkitError } from "./errors.js";
import { SseParser } from "./sse.js";
import type {
  CapturedRequest,
  Endpoint,
  EndpointResponse,
  ExplainLanguage,
  ExplainResponse,
  Me,
  Relay,
  RemoteReplayResult,
} from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://webhook-toolkit.com";

export interface WebhookToolkitOptions {
  /** `whk_…` API key. Defaults to `process.env.WEBHOOK_TOOLKIT_KEY`. Pass `null` to force anonymous mode. */
  apiKey?: string | null;
  /** Site origin. Defaults to `process.env.WEBHOOK_TOOLKIT_URL` or https://webhook-toolkit.com. */
  baseUrl?: string;
  /** Custom fetch implementation (defaults to the global one). */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout for regular calls, in ms. Default 30 000. */
  timeoutMs?: number;
  userAgent?: string;
}

export interface UpdateEndpointInput {
  name?: string;
  /** What the capture URL answers to senders. */
  response?: Partial<EndpointResponse>;
}

export interface ListRequestsOptions {
  /** 1–200, default 50. Newest first. */
  limit?: number;
  /** Only requests strictly newer than this. */
  after?: string | Date;
  signal?: AbortSignal;
}

export interface WaitForRequestOptions {
  /** Overall timeout in ms (the client chains 55 s long-polls until it elapses). Default 30 000. */
  timeoutMs?: number;
  /**
   * Only consider requests strictly newer than this. Defaults to the endpoint's creation time
   * for endpoints created by this client instance (so a webhook that arrived before you started
   * waiting still counts), otherwise to the moment of the call.
   */
  after?: string | Date;
  /** Keep waiting past requests for which this returns false. */
  filter?: (request: CapturedRequest) => boolean | Promise<boolean>;
  signal?: AbortSignal;
}

export interface StreamOptions {
  /** Abort to stop streaming; the returned promise then resolves. */
  signal?: AbortSignal;
  /** Called on every (re)connection. */
  onOpen?: () => void;
  /** Called before each reconnection attempt. */
  onReconnect?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** On (re)connection, fetch requests missed while disconnected. Default true. */
  catchUp?: boolean;
  /** Reconnect when nothing (not even a keep-alive) arrived for this long. Default 65 000 ms. */
  idleTimeoutMs?: number;
  /**
   * Also deliver requests newer than this that arrived before the first connection (e.g. the
   * endpoint's `createdAt`), so nothing is lost between creating a URL and streaming it.
   */
  after?: string | Date;
}

export interface ExplainOptions {
  mode?: "explain" | "handler";
  language?: ExplainLanguage;
}

type Query = Record<string, string | number | undefined>;

interface CallInit {
  body?: unknown;
  query?: Query;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  requireKey?: string;
}

/** Status codes after which reconnecting a stream is pointless. */
const FATAL_STREAM_STATUSES = new Set([400, 401, 402, 403, 404, 410]);

/** Accepts `https://webhook-toolkit.com`, `…/api/v1`, trailing slashes. Returns the bare origin(+path). */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WebhookToolkitError(`Invalid base URL "${url}": expected something like https://webhook-toolkit.com`, {
      code: "invalid_input",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebhookToolkitError(`Invalid base URL "${url}": must be http(s).`, { code: "invalid_input" });
  }
  return trimmed;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function byCreatedAsc(a: CapturedRequest, b: CapturedRequest): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** An AbortSignal that fires on the parent signal or after `timeoutMs` (AbortSignal.any is Node >= 20.3). */
function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, ms);
  };
  if (timeoutMs && timeoutMs > 0) arm(timeoutMs);
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    /** Restart the timeout (idle watchdog). */
    rearm: arm,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Client for the webhook-toolkit.com REST API v1.
 *
 * ```ts
 * const wt = new WebhookToolkit();               // anonymous, or WEBHOOK_TOOLKIT_KEY
 * const endpoint = await wt.createEndpoint();   // → endpoint.url receives webhooks
 * const req = await wt.waitForRequest(endpoint.token, { filter: (r) => r.event === "invoice.paid" });
 * ```
 */
export class WebhookToolkit {
  /** Site origin, e.g. `https://webhook-toolkit.com`. */
  readonly baseUrl: string;
  /** REST root, e.g. `https://webhook-toolkit.com/api/v1`. */
  readonly apiUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  /** token → createdAt of endpoints created by this instance (default `after` for waitForRequest). */
  readonly #created = new Map<string, string>();

  constructor(options: WebhookToolkitOptions = {}) {
    const env = typeof process !== "undefined" ? process.env : {};
    const key = options.apiKey === undefined ? env.WEBHOOK_TOOLKIT_KEY : options.apiKey;
    this.#apiKey = key ? key.trim() : undefined;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? (env.WEBHOOK_TOOLKIT_URL || DEFAULT_BASE_URL));
    this.apiUrl = `${this.baseUrl}/api/v1`;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new WebhookToolkitError("No fetch implementation available (Node >= 18.17 required).");
    this.#fetch = f;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#userAgent = options.userAgent ?? `webhook-toolkit/${VERSION} (+https://webhook-toolkit.com)`;
  }

  /** True when calls are authenticated with an API key. */
  get hasApiKey(): boolean {
    return this.#apiKey !== undefined;
  }

  // ─── endpoints ────────────────────────────────────────────────────────────

  /** Creates a capture URL. Anonymous URLs expire after 7 days; with a key they belong to your account. */
  async createEndpoint(input: { name?: string } = {}): Promise<Endpoint> {
    const { data } = await this.#call<{ endpoint: Endpoint }>("POST", "/endpoints", { body: input });
    this.#created.set(data.endpoint.token, data.endpoint.createdAt);
    return data.endpoint;
  }

  /** Lists the capture URLs of your account (API key required). */
  async listEndpoints(): Promise<Endpoint[]> {
    const { data } = await this.#call<{ endpoints: Endpoint[] }>("GET", "/endpoints", { requireKey: "listEndpoints()" });
    return data.endpoints;
  }

  async getEndpoint(token: string): Promise<Endpoint> {
    const { data } = await this.#call<{ endpoint: Endpoint }>("GET", `/endpoints/${enc(token)}`);
    return data.endpoint;
  }

  /** Renames the endpoint and/or changes what it answers (status, body, content type). */
  async updateEndpoint(token: string, input: UpdateEndpointInput): Promise<Endpoint> {
    const { data } = await this.#call<{ endpoint: Endpoint }>("PATCH", `/endpoints/${enc(token)}`, { body: input });
    return data.endpoint;
  }

  async deleteEndpoint(token: string): Promise<void> {
    await this.#call("DELETE", `/endpoints/${enc(token)}`);
    this.#created.delete(token);
  }

  // ─── requests ─────────────────────────────────────────────────────────────

  /** Captured requests, newest first. */
  async listRequests(token: string, options: ListRequestsOptions = {}): Promise<CapturedRequest[]> {
    const query: Query = {};
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.after !== undefined) query.after = toIso(options.after);
    const { data } = await this.#call<{ requests: CapturedRequest[] }>("GET", `/endpoints/${enc(token)}/requests`, {
      query,
      signal: options.signal,
    });
    return (data.requests ?? []).map((r) => normalizeCapturedRequest(token, r));
  }

  async getRequest(token: string, id: string): Promise<CapturedRequest> {
    const { data } = await this.#call<{ request: CapturedRequest }>("GET", `/endpoints/${enc(token)}/requests/${enc(id)}`);
    return normalizeCapturedRequest(token, data.request);
  }

  /** Deletes the request history of an endpoint. */
  async clearRequests(token: string): Promise<void> {
    await this.#call("DELETE", `/endpoints/${enc(token)}/requests`);
  }

  /**
   * Resolves with the first request (matching `filter`, if given) newer than `after`.
   * Requests that already arrived are checked first, then the API long-poll is chained until
   * `timeoutMs`. Rejects with a `WebhookToolkitError` of code `timeout` when nothing matched.
   */
  async waitForRequest(token: string, options: WaitForRequestOptions = {}): Promise<CapturedRequest> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    const filter = options.filter;
    const signal = options.signal;
    let cursor: string | undefined = options.after !== undefined ? toIso(options.after) : this.#created.get(token);
    let ignored = 0;

    const matches = async (req: CapturedRequest) => {
      if (!filter || (await filter(req))) return true;
      ignored++;
      return false;
    };
    /** Checks requests already stored after the cursor, oldest first. */
    const scanStored = async (): Promise<CapturedRequest | undefined> => {
      if (cursor === undefined) return undefined;
      const stored = (await this.listRequests(token, { after: cursor, limit: 200, signal })).sort(byCreatedAsc);
      for (const req of stored) {
        cursor = req.createdAt;
        if (await matches(req)) return req;
      }
      return undefined;
    };

    const early = await scanStored();
    if (early) return early;

    for (;;) {
      if (signal?.aborted) throw new WebhookToolkitError("waitForRequest() aborted", { code: "aborted" });
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const seconds = Math.min(55, Math.max(1, Math.ceil(remaining / 1000)));
      const query: Query = { timeout: seconds };
      if (cursor !== undefined) query.after = cursor;
      const { data, response } = await this.#call<{ request: CapturedRequest | null; timedOut?: boolean; now?: string }>(
        "GET",
        `/endpoints/${enc(token)}/wait`,
        { query, signal, timeoutMs: seconds * 1000 + 15_000 },
      );
      if (data.request) {
        const req = normalizeCapturedRequest(token, data.request);
        cursor = req.createdAt;
        if (await matches(req)) return req;
        // A burst may have landed behind the non-matching one: check it before polling again.
        const next = await scanStored();
        if (next) return next;
        continue;
      }
      if (cursor === undefined) {
        // The first poll used the server's "now". Continue from the server clock so that nothing
        // landing between two polls is missed (no request arrived during the poll that timed out).
        const date = response.headers.get("date");
        cursor = data.now ?? (date ? new Date(date).toISOString() : new Date().toISOString());
      }
    }
    const what = filter ? "matching request" : "request";
    const extra = ignored ? ` (${ignored} non-matching request${ignored > 1 ? "s" : ""} ignored)` : "";
    throw new WebhookToolkitError(`No ${what} reached endpoint ${token} within ${Math.round(timeoutMs / 1000)}s${extra}.`, {
      code: "timeout",
    });
  }

  /**
   * Live feed of incoming requests over Server-Sent Events. Reconnects with backoff, and
   * replays what was missed while disconnected. Resolves when `signal` aborts; rejects on
   * fatal errors (unknown/expired endpoint, auth).
   */
  async stream(
    token: string,
    onRequest: (request: CapturedRequest) => void | Promise<void>,
    options: StreamOptions = {},
  ): Promise<void> {
    const { signal } = options;
    const catchUp = options.catchUp ?? true;
    const seen = new Set<string>();
    const seenOrder: string[] = [];
    let lastCreatedAt: string | undefined = options.after !== undefined ? toIso(options.after) : undefined;
    let attempt = 0;

    const emit = async (req: CapturedRequest) => {
      if (seen.has(req.id)) return;
      seen.add(req.id);
      seenOrder.push(req.id);
      if (seenOrder.length > 2000) seen.delete(seenOrder.shift() as string);
      if (!lastCreatedAt || req.createdAt > lastCreatedAt) lastCreatedAt = req.createdAt;
      await onRequest(req);
    };

    while (!signal?.aborted) {
      let error: unknown = new Error("stream closed by the server");
      try {
        await this.#streamOnce(token, emit, options, async () => {
          attempt = 0;
          options.onOpen?.();
          if (catchUp && lastCreatedAt) {
            const missed = await this.listRequests(token, { after: lastCreatedAt, limit: 200, signal });
            for (const req of missed.sort(byCreatedAsc)) await emit(req);
          }
        });
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof WebhookToolkitError && (FATAL_STREAM_STATUSES.has(err.status) || err.code === "bad_response")) throw err;
        error = err;
      }
      if (signal?.aborted) return;
      attempt++;
      const delayMs = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      options.onReconnect?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }

  async #streamOnce(
    token: string,
    emit: (req: CapturedRequest) => Promise<void>,
    options: StreamOptions,
    onOpen: () => Promise<void>,
  ): Promise<void> {
    const idle = options.idleTimeoutMs ?? 65_000;
    const link = linkedSignal(options.signal, idle);
    const url = `${this.apiUrl}/endpoints/${enc(token)}/stream`;
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, { headers: this.#headers({ accept: "text/event-stream" }), signal: link.signal });
      } catch (err) {
        throw this.#networkError(err, url, link.timedOut(), options.signal);
      }
      if (!response.ok) throw await this.#httpError(response);
      const ct = response.headers.get("content-type") ?? "";
      if (!ct.includes("text/event-stream") || !response.body) {
        throw new WebhookToolkitError(`Expected an event stream from ${url}, got "${ct || "no content type"}". Is the base URL right?`, {
          status: response.status,
          code: "bad_response",
        });
      }
      await onOpen();

      const queue: CapturedRequest[] = [];
      const parser = new SseParser((msg) => {
        if (msg.event !== "request") return;
        try {
          const parsed = JSON.parse(msg.data) as CapturedRequest | { request: CapturedRequest };
          const req = "request" in parsed && parsed.request && typeof parsed.request === "object" ? parsed.request : (parsed as CapturedRequest);
          if (req && typeof req.id === "string") queue.push(normalizeCapturedRequest(token, req));
        } catch {
          /* ignore malformed events */
        }
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          link.rearm(idle);
          parser.feed(decoder.decode(value, { stream: true }));
          while (queue.length > 0) await emit(queue.shift() as CapturedRequest);
        }
      } catch (err) {
        if (err instanceof WebhookToolkitError) throw err;
        throw this.#networkError(err, url, link.timedOut(), options.signal);
      } finally {
        reader.cancel().catch(() => {});
      }
    } finally {
      link.cleanup();
      link.abort();
    }
  }

  // ─── server-side features ─────────────────────────────────────────────────

  /**
   * Server-side replay to a PUBLIC URL (private/loopback hosts are refused with `blocked_host`).
   * To replay to localhost, use `forwardRequest()` which sends from your machine.
   */
  async replayRequest(token: string, id: string, url: string): Promise<RemoteReplayResult> {
    const { data } = await this.#call<{ result: RemoteReplayResult }>(
      "POST",
      `/endpoints/${enc(token)}/requests/${enc(id)}/replay`,
      { body: { url }, timeoutMs: 60_000 },
    );
    return data.result;
  }

  /** AI explanation of a captured request, or a generated handler (`mode: "handler"`). Paid, 3 free trials. */
  async explainRequest(token: string, id: string, options: ExplainOptions = {}): Promise<ExplainResponse> {
    const body: Record<string, string> = { mode: options.mode ?? "explain" };
    if (options.language) body.language = options.language;
    const { data } = await this.#call<ExplainResponse>("POST", `/endpoints/${enc(token)}/requests/${enc(id)}/explain`, {
      body,
      timeoutMs: 120_000,
    });
    return data;
  }

  /** Account, plan and limits (API key required). */
  async me(): Promise<Me> {
    const { data } = await this.#call<Me>("GET", "/me", { requireKey: "me()" });
    return data;
  }

  /** Relays of your account (paid plans, API key required). */
  async listRelays(): Promise<Relay[]> {
    const { data } = await this.#call<{ relays: Relay[] }>("GET", "/relays", { requireKey: "listRelays()" });
    return data.relays;
  }

  async createRelay(input: { name?: string } = {}): Promise<Relay> {
    const { data } = await this.#call<{ relay: Relay }>("POST", "/relays", { body: input, requireKey: "createRelay()" });
    return data.relay;
  }

  // ─── plumbing ─────────────────────────────────────────────────────────────

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { "user-agent": this.#userAgent, ...extra };
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
    return headers;
  }

  #networkError(err: unknown, url: string, timedOut: boolean, parent?: AbortSignal): WebhookToolkitError {
    if (parent?.aborted) return new WebhookToolkitError("Request aborted", { code: "aborted", cause: err });
    if (timedOut) return new WebhookToolkitError(`Request to ${url} timed out`, { code: "timeout", cause: err });
    return new WebhookToolkitError(`Could not reach ${this.baseUrl} (${describeNetworkError(err)})`, {
      code: "network_error",
      cause: err,
    });
  }

  async #httpError(response: Response): Promise<WebhookToolkitError> {
    const text = await response.text().catch(() => "");
    let body: { error?: unknown; message?: unknown; upgradeUrl?: unknown } | undefined;
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      body = undefined;
    }
    const code = typeof body?.error === "string" ? body.error : codeForStatus(response.status);
    const message =
      typeof body?.message === "string" && body.message
        ? body.message
        : body
          ? `HTTP ${response.status} (${code})`
          : `HTTP ${response.status} from ${response.url || this.apiUrl}${text.trimStart().startsWith("<") ? " (HTML page: is the base URL right?)" : ""}`;
    const upgradeUrl = typeof body?.upgradeUrl === "string" ? body.upgradeUrl : undefined;
    return new WebhookToolkitError(message, upgradeUrl ? { status: response.status, code, upgradeUrl } : { status: response.status, code });
  }

  async #call<T>(method: string, path: string, init: CallInit = {}): Promise<{ data: T; response: Response }> {
    if (init.requireKey && !this.#apiKey) {
      throw new WebhookToolkitError(
        `${init.requireKey} needs an API key. Create one at ${this.baseUrl}/dashboard, then pass { apiKey } or set WEBHOOK_TOOLKIT_KEY.`,
        { status: 401, code: "unauthorized" },
      );
    }
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers = this.#headers({ accept: "application/json" });
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const link = linkedSignal(init.signal, init.timeoutMs ?? this.#timeoutMs);
    try {
      let response: Response;
      let text: string;
      try {
        response = await this.#fetch(url, { method, headers, body, signal: link.signal });
        if (!response.ok) throw await this.#httpError(response);
        text = await response.text();
      } catch (err) {
        if (err instanceof WebhookToolkitError) throw err;
        throw this.#networkError(err, url.toString(), link.timedOut(), init.signal);
      }
      if (!text) return { data: {} as T, response };
      try {
        return { data: JSON.parse(text) as T, response };
      } catch {
        throw new WebhookToolkitError(`Expected JSON from ${method} ${url.pathname}, got something else. Is the base URL right?`, {
          status: response.status,
          code: "bad_response",
        });
      }
    } finally {
      link.cleanup();
    }
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Defensive normalisation of a captured request: strips a leading `/r/<token>` from `path`
 * (the contract says sub-path only), fills `provider`/`event` locally when the server omitted
 * them, and tolerates a `bodyPreview` field in place of `body`.
 */
export function normalizeCapturedRequest(token: string, raw: CapturedRequest): CapturedRequest {
  const req = { ...raw } as CapturedRequest & { bodyPreview?: string };
  req.headers = req.headers ?? {};
  if (typeof req.body !== "string") req.body = typeof req.bodyPreview === "string" ? req.bodyPreview : "";
  delete req.bodyPreview;
  req.query = typeof req.query === "string" ? req.query.replace(/^\?/, "") : "";
  const prefix = `/r/${token}`;
  if (typeof req.path !== "string" || req.path === "") req.path = "/";
  else if (req.path === prefix || req.path.startsWith(`${prefix}/`)) req.path = req.path.slice(prefix.length) || "/";
  if (req.provider === undefined || req.event === undefined) {
    const detected = detectProvider(req.headers, req.body);
    if (req.provider === undefined) req.provider = detected.provider;
    if (req.event === undefined) req.event = req.provider === detected.provider ? detected.event : null;
  }
  return req;
}
