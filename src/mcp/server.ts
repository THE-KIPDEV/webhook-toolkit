import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WebhookToolkit } from "../client.js";
import { WebhookToolkitError } from "../errors.js";
import { forwardRequest, normalizeTarget, type ForwardResult } from "../forward.js";
import { SIGNATURE_PROVIDER_IDS, type SignatureProvider } from "../signing/providers.js";
import { sign, type SignOptions } from "../signing/sign.js";
import { verify, type VerifyOptions } from "../signing/verify.js";
import type { CapturedRequest, Endpoint } from "../types.js";
import { VERSION } from "../version.js";

export interface McpServerOptions {
  /** `whk_…` key. Defaults to `process.env.WEBHOOK_TOOLKIT_KEY`; `null` forces anonymous mode. */
  apiKey?: string | null;
  /** Defaults to `process.env.WEBHOOK_TOOLKIT_URL` or https://webhook-toolkit.com. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Bodies longer than this are truncated in tool results. Default 20 000 characters. */
  maxBodyChars?: number;
}

const INSTRUCTIONS = `Webhook Toolkit: receive, inspect, replay, sign and verify webhooks.
Typical flow: create_webhook_url → configure the third-party service (or the app under test) to send webhooks to the returned URL → trigger the event → wait_for_webhook → get_webhook_request for details → iterate on the local handler with replay_webhook_request or send_signed_webhook (both send from this machine, localhost works).
For "invalid signature" errors, use verify_webhook_signature: it explains the cause.
Anonymous URLs last 7 days. Web inspector, permanent URLs and plans: https://webhook-toolkit.com`;

const PROVIDERS = SIGNATURE_PROVIDER_IDS as unknown as [SignatureProvider, ...SignatureProvider[]];
const TIMESTAMPED = new Set(["stripe", "slack", "svix", "paddle", "discord"]);

type Extra = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number } & Record<string, unknown>;
  sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
};

function text(summary: string, data?: unknown): CallToolResult {
  const body = data === undefined ? summary : `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { content: [{ type: "text", text: body }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function errorMessage(err: unknown, baseUrl: string): string {
  if (err instanceof WebhookToolkitError) {
    const lines = [err.message];
    if (err.upgradeUrl) lines.push(`Upgrade: ${err.upgradeUrl}`);
    else if (err.status === 401) lines.push(`Set WEBHOOK_TOOLKIT_KEY in the MCP server config (create a key at ${baseUrl}/dashboard).`);
    else if (err.status === 404) lines.push("Unknown token or request id: check it, or call create_webhook_url.");
    else if (err.status === 410) lines.push("This URL expired: call create_webhook_url for a new one.");
    return lines.join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}

function truncate(body: string, max: number, where?: string): { body: string; note?: string } {
  if (body.length <= max) return { body };
  return {
    body: body.slice(0, max),
    note: `Body truncated: showing ${max} of ${body.length} characters${where ? `; full body in the inspector: ${where}` : ""}.`,
  };
}

function describeEndpoint(e: Endpoint): string {
  return [
    `Webhook URL: ${e.url}`,
    `Token: ${e.token}`,
    `Inspector: ${e.inspectUrl}`,
    `Expires: ${e.expiresAt ?? "never"}`,
    `Created: ${e.createdAt}`,
  ].join("\n");
}

function label(req: CapturedRequest): string {
  return req.provider ? `${req.provider}${req.event ? ` ${req.event}` : ""}` : "unknown sender";
}

/**
 * Builds the webhook-toolkit MCP server (tools only). Connect it to any transport:
 *
 * ```ts
 * const server = createMcpServer({ apiKey: process.env.WEBHOOK_TOOLKIT_KEY });
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const clientOptions: ConstructorParameters<typeof WebhookToolkit>[0] = {};
  if (options.apiKey !== undefined) clientOptions.apiKey = options.apiKey;
  if (options.baseUrl !== undefined) clientOptions.baseUrl = options.baseUrl;
  if (options.fetch !== undefined) clientOptions.fetch = options.fetch;
  const client = new WebhookToolkit(clientOptions);
  const maxBody = options.maxBodyChars ?? 20_000;
  /** token → createdAt of the last request wait_for_webhook returned (so the next wait continues after it). */
  const cursors = new Map<string, string>();
  /** token → createdAt of URLs created in this session. */
  const created = new Map<string, string>();
  const inspectorOf = (token: string) => `${client.baseUrl}/e/${token}`;

  const fullRequest = (req: CapturedRequest, token: string) => {
    const t = truncate(req.body, maxBody, inspectorOf(token));
    return { request: { ...req, body: t.body }, note: t.note };
  };
  const forwardSummary = (res: ForwardResult) => {
    const t = truncate(res.body, maxBody);
    return {
      summary: `${res.url} → ${res.status} ${res.statusText} in ${res.ms} ms`.replace(/\s+in/, " in"),
      data: { status: res.status, statusText: res.statusText, ms: res.ms, url: res.url, headers: res.headers, body: t.body },
      note: t.note ?? (res.truncated ? "Response body truncated to 64 KB." : undefined),
    };
  };
  const guard =
    <A>(fn: (args: A, extra: Extra) => Promise<CallToolResult>) =>
    async (args: A, extra: unknown): Promise<CallToolResult> => {
      try {
        return await fn(args, extra as Extra);
      } catch (err) {
        return failure(errorMessage(err, client.baseUrl));
      }
    };

  const server = new McpServer(
    { name: "webhook-toolkit", title: "Webhook Toolkit", version: VERSION, websiteUrl: "https://webhook-toolkit.com" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "create_webhook_url",
    {
      title: "Create a webhook URL",
      description:
        "Create a public HTTPS URL that captures every HTTP request sent to it (any method, any sub-path). Use it when you need an endpoint to receive a webhook from a third-party service (Stripe, GitHub, Shopify, Slack, Twilio, Clerk…) or from the app you are testing, without deploying or tunnelling anything. Returns the URL, the token the other tools take, and a web inspector link. Anonymous URLs expire after 7 days. Next: configure the sender with the URL, trigger the event, then call wait_for_webhook.",
      inputSchema: { name: z.string().max(100).optional().describe("Label shown in the dashboard, e.g. 'stripe-checkout-test'.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ name }: { name?: string | undefined }) => {
      const endpoint = await client.createEndpoint(name ? { name } : {});
      created.set(endpoint.token, endpoint.createdAt);
      const anon = endpoint.expiresAt
        ? "\nAnonymous URL (expires in 7 days). Set WEBHOOK_TOOLKIT_KEY for permanent URLs."
        : "";
      return text(
        `${describeEndpoint(endpoint)}${anon}\n\nNext: point the sender at the URL (sub-paths such as ${endpoint.url}/stripe work too), trigger the event, then call wait_for_webhook with token "${endpoint.token}".`,
      );
    }),
  );

  server.registerTool(
    "list_webhook_urls",
    {
      title: "List webhook URLs",
      description:
        "List the webhook URLs owned by the account behind WEBHOOK_TOOLKIT_KEY (required). Use it to find the token of an existing permanent URL instead of creating a new one.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const endpoints = await client.listEndpoints();
      if (endpoints.length === 0) return text("No webhook URLs on this account yet. Call create_webhook_url.");
      const lines = endpoints.map((e) => `- ${e.token}  ${e.name}  ${e.url}  (${e.requestCount} requests, expires ${e.expiresAt ?? "never"})`);
      return text(`${endpoints.length} webhook URL(s):\n${lines.join("\n")}`);
    }),
  );

  server.registerTool(
    "wait_for_webhook",
    {
      title: "Wait for a webhook",
      description:
        "Block until a webhook reaches a capture URL, then return it (method, path, headers, raw body, detected provider and event type). Use it right after triggering the action that sends the webhook. It is safe to call after the webhook was already sent: requests received since the URL was created in this session, or since the last request this tool returned for the token, are included. Filters skip unrelated deliveries. Calling it again returns the next request. A timeout means nothing matching arrived: check the sender's configuration, then call again.",
      inputSchema: {
        token: z.string().min(1).describe("Token returned by create_webhook_url (the last segment of the URL)."),
        timeout_seconds: z.number().int().min(1).max(600).default(60).describe("How long to wait. Default 60."),
        after: z.string().optional().describe("ISO timestamp: only requests strictly newer than this. Overrides the automatic cursor."),
        provider: z.string().optional().describe("Only a request from this sender, e.g. 'stripe', 'github'."),
        event: z.string().optional().describe("Only this event type, e.g. 'checkout.session.completed', 'push'."),
        method: z.string().optional().describe("Only this HTTP method, e.g. 'POST'."),
        path_contains: z.string().optional().describe("Only requests whose sub-path contains this text."),
        body_contains: z.string().optional().describe("Only requests whose body contains this text."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(
      async (
        args: {
          token: string;
          timeout_seconds: number;
          after?: string | undefined;
          provider?: string | undefined;
          event?: string | undefined;
          method?: string | undefined;
          path_contains?: string | undefined;
          body_contains?: string | undefined;
        },
        extra,
      ) => {
        const { token } = args;
        const timeoutSeconds = args.timeout_seconds ?? 60;
        const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();
        const hasFilter = Boolean(args.provider || args.event || args.method || args.path_contains || args.body_contains);
        const filter = (r: CapturedRequest) =>
          (!args.provider || lower(r.provider) === lower(args.provider)) &&
          (!args.event || lower(r.event) === lower(args.event)) &&
          (!args.method || lower(r.method) === lower(args.method)) &&
          (!args.path_contains || r.path.includes(args.path_contains)) &&
          (!args.body_contains || r.body.includes(args.body_contains));
        const after = args.after ?? cursors.get(token) ?? created.get(token);

        const progressToken = extra?._meta?.progressToken;
        const started = Date.now();
        const ticker =
          progressToken !== undefined
            ? setInterval(() => {
                const elapsed = Math.round((Date.now() - started) / 1000);
                extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: elapsed, total: timeoutSeconds, message: "Waiting for a webhook…" },
                  })
                  .catch(() => {});
              }, 5000)
            : undefined;
        try {
          const waitOpts: Parameters<WebhookToolkit["waitForRequest"]>[1] = { timeoutMs: timeoutSeconds * 1000 };
          if (after) waitOpts.after = after;
          if (hasFilter) waitOpts.filter = filter;
          if (extra?.signal) waitOpts.signal = extra.signal;
          const req = await client.waitForRequest(token, waitOpts);
          cursors.set(token, req.createdAt);
          const { request, note } = fullRequest(req, token);
          return text(
            `Received ${req.method} ${req.path} from ${label(req)} at ${req.createdAt} (${req.size} bytes).${note ? `\n${note}` : ""}\nCall wait_for_webhook again for the next one.`,
            request,
          );
        } catch (err) {
          if (err instanceof WebhookToolkitError && err.code === "timeout") {
            return text(
              `No ${hasFilter ? "matching " : ""}webhook within ${timeoutSeconds}s on ${token}. ${err.message} Check that the sender targets ${client.baseUrl}/r/${token}, then call wait_for_webhook again (list_webhook_requests shows everything received).`,
            );
          }
          throw err;
        } finally {
          if (ticker) clearInterval(ticker);
        }
      },
    ),
  );

  server.registerTool(
    "list_webhook_requests",
    {
      title: "List captured requests",
      description:
        "List the requests captured by a webhook URL, newest first, with method, path, detected provider/event, size and a short body preview. Use it to see what a service actually sent, then get_webhook_request for one in full.",
      inputSchema: {
        token: z.string().min(1).describe("Webhook URL token."),
        limit: z.number().int().min(1).max(100).default(20).describe("How many, default 20."),
        after: z.string().optional().describe("ISO timestamp: only requests newer than this."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ token, limit, after }: { token: string; limit: number; after?: string | undefined }) => {
      const requests = await client.listRequests(token, after ? { limit: limit ?? 20, after } : { limit: limit ?? 20 });
      if (requests.length === 0) {
        return text(`No requests captured yet on ${token}. Send one to ${client.baseUrl}/r/${token}, or call wait_for_webhook.`);
      }
      const rows = requests.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        method: r.method,
        path: r.path + (r.query ? `?${r.query}` : ""),
        provider: r.provider,
        event: r.event,
        size: r.size,
        bodyPreview: r.body.length > 300 ? `${r.body.slice(0, 300)}…` : r.body,
      }));
      return text(`${requests.length} request(s) on ${token}, newest first. Use get_webhook_request for full headers and body.`, rows);
    }),
  );

  server.registerTool(
    "get_webhook_request",
    {
      title: "Get a captured request",
      description:
        "Get one captured request in full: method, path, query, all headers, raw body (as received, byte-exact for signature checks), detected provider and event. Use it to inspect a payload before writing or fixing a handler.",
      inputSchema: {
        token: z.string().min(1).describe("Webhook URL token."),
        request_id: z.string().min(1).describe("Request id from wait_for_webhook or list_webhook_requests."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ token, request_id }: { token: string; request_id: string }) => {
      const req = await client.getRequest(token, request_id);
      const { request, note } = fullRequest(req, token);
      return text(`${req.method} ${req.path} from ${label(req)} at ${req.createdAt} (${req.size} bytes).${note ? `\n${note}` : ""}`, request);
    }),
  );

  server.registerTool(
    "set_webhook_response",
    {
      title: "Set the URL's response",
      description:
        "Change what a webhook URL answers to senders: status code, body and content type (and optionally its name). Use it to simulate a failing endpoint (e.g. 500 so the provider retries) or to answer a verification challenge that expects a specific body. URLs created with an API key can only be changed with that key.",
      inputSchema: {
        token: z.string().min(1).describe("Webhook URL token."),
        status: z.number().int().min(100).max(599).optional().describe("HTTP status to answer, e.g. 200, 410, 500."),
        body: z.string().max(100_000).optional().describe("Response body."),
        content_type: z.string().optional().describe("Response Content-Type, e.g. 'application/json'."),
        name: z.string().max(100).optional().describe("New label for the URL."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(
      async (args: {
        token: string;
        status?: number | undefined;
        body?: string | undefined;
        content_type?: string | undefined;
        name?: string | undefined;
      }) => {
        const response: { status?: number; body?: string; contentType?: string } = {};
        if (args.status !== undefined) response.status = args.status;
        if (args.body !== undefined) response.body = args.body;
        if (args.content_type !== undefined) response.contentType = args.content_type;
        const input: { name?: string; response?: typeof response } = {};
        if (Object.keys(response).length) input.response = response;
        if (args.name !== undefined) input.name = args.name;
        if (!input.name && !input.response) return failure("Nothing to change: pass status, body, content_type or name.");
        const endpoint = await client.updateEndpoint(args.token, input);
        return text(`${endpoint.url} now answers ${endpoint.response.status} (${endpoint.response.contentType}).`, endpoint.response);
      },
    ),
  );

  server.registerTool(
    "replay_webhook_request",
    {
      title: "Replay a request locally",
      description:
        "Re-send a captured webhook FROM THIS MACHINE to a URL, localhost included (e.g. http://localhost:3000/api/webhooks), with the same method, headers and body. Use it to iterate on a webhook handler without re-triggering the real event. Returns the handler's status, latency and response. The captured sub-path and query are appended to target_url. Timestamped signatures (Stripe, Slack, Svix, Paddle) are replayed as captured, so strict handlers reject them after ~5 minutes: then use send_signed_webhook.",
      inputSchema: {
        token: z.string().min(1).describe("Webhook URL token."),
        request_id: z.string().min(1).describe("Captured request id."),
        target_url: z.string().min(1).describe("Where to send it, e.g. http://localhost:3000/api/webhooks/stripe (a bare port such as 3000 works)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ token, request_id, target_url }: { token: string; request_id: string; target_url: string }) => {
      const req = await client.getRequest(token, request_id);
      const res = await forwardRequest(req, normalizeTarget(target_url));
      const out = forwardSummary(res);
      const ageMin = (Date.now() - new Date(req.createdAt).getTime()) / 60_000;
      const warn =
        req.provider && TIMESTAMPED.has(req.provider) && ageMin > 5 && res.status >= 400
          ? `\nNote: this ${req.provider} signature is ${Math.round(ageMin)} min old; the handler may reject it as expired. Use send_signed_webhook for a fresh signature.`
          : "";
      return text(`Replayed ${req.method} ${label(req)}: ${out.summary}${out.note ? `\n${out.note}` : ""}${warn}`, out.data);
    }),
  );

  const signInput = {
    provider: z.enum(PROVIDERS).describe("Signature scheme. 'svix' also covers Clerk, Resend and Standard Webhooks."),
    secret: z
      .string()
      .min(1)
      .describe("Signing secret, as your handler knows it (Stripe whsec_…, GitHub webhook secret, Twilio auth token, Discord: an Ed25519 test private key in hex)."),
    payload: z
      .string()
      .optional()
      .describe("Raw body to sign, sent verbatim (JSON text; Twilio: urlencoded or a JSON object of params). Omit to use a realistic sample of `event`."),
    event: z.string().optional().describe("Event type, e.g. 'checkout.session.completed', 'push', 'orders/create'."),
  };

  const buildSignOptions = (args: { secret: string; payload?: string | undefined; event?: string | undefined }, provider: string) => {
    const opts: SignOptions = { secret: args.secret };
    if (args.payload !== undefined) {
      // Twilio params may be given as a JSON object for convenience.
      if (provider === "twilio" && args.payload.trim().startsWith("{")) {
        try {
          opts.payload = JSON.parse(args.payload) as unknown;
        } catch {
          opts.payload = args.payload;
        }
      } else {
        opts.payload = args.payload;
      }
    }
    if (args.event) opts.event = args.event;
    return opts;
  };

  server.registerTool(
    "send_signed_webhook",
    {
      title: "Send a signed webhook",
      description:
        "Build a webhook with a valid provider signature (Stripe, GitHub, Shopify, Slack, Twilio, Mailgun, Svix/Clerk/Resend, Paddle, Discord with a test key) and POST it FROM THIS MACHINE to your handler (localhost works). Use it to test signature verification and event handling without the real provider. Returns the handler's status and response. Signing happens locally: the secret never leaves the machine.",
      inputSchema: {
        ...signInput,
        target_url: z.string().min(1).describe("Handler URL, e.g. http://localhost:3000/api/webhooks/stripe (a bare port such as 3000 works)."),
        twilio_url: z.string().optional().describe("Twilio only: the public URL Twilio would call (default: target_url)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(
      async (args: {
        provider: SignatureProvider;
        secret: string;
        payload?: string | undefined;
        event?: string | undefined;
        target_url: string;
        twilio_url?: string | undefined;
      }) => {
        const target = normalizeTarget(args.target_url);
        const opts = buildSignOptions(args, args.provider);
        if (args.provider === "twilio") opts.url = args.twilio_url ?? target;
        const signed = sign(args.provider, opts);
        const res = await forwardRequest({ method: "POST", path: "/", query: "", headers: signed.headers, body: signed.body }, target);
        const out = forwardSummary(res);
        return text(`Sent signed ${args.provider}${signed.event ? ` ${signed.event}` : ""} webhook: ${out.summary}${out.note ? `\n${out.note}` : ""}`, {
          sent: { headers: signed.headers, body: truncate(signed.body, maxBody).body },
          response: out.data,
        });
      },
    ),
  );

  server.registerTool(
    "sign_webhook_payload",
    {
      title: "Sign a webhook payload",
      description:
        "Compute valid signature headers for a webhook body without sending it. Use it to write a test fixture, a curl command, or to check what a provider's signature should be for a given secret. Returns headers, body and a curl command. Runs locally.",
      inputSchema: {
        ...signInput,
        url: z.string().optional().describe("Twilio only (required for Twilio): the public URL Twilio calls."),
        timestamp: z.number().int().optional().describe("Unix seconds to sign with (default: now)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(
      async (args: {
        provider: SignatureProvider;
        secret: string;
        payload?: string | undefined;
        event?: string | undefined;
        url?: string | undefined;
        timestamp?: number | undefined;
      }) => {
        const opts = buildSignOptions(args, args.provider);
        if (args.url) opts.url = args.url;
        if (args.timestamp !== undefined) opts.timestamp = args.timestamp;
        const signed = sign(args.provider, opts);
        const target = args.url ?? "http://localhost:3000/webhooks";
        const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
        const curl = [
          `curl -X POST ${q(target)}`,
          ...Object.entries(signed.headers).map(([k, v]) => `  -H ${q(`${k}: ${v}`)}`),
          `  --data-raw ${q(signed.body)}`,
        ].join(" \\\n");
        return text(`Signed ${args.provider}${signed.event ? ` ${signed.event}` : ""} payload (timestamp ${signed.timestamp}).\n\ncurl:\n${curl}`, {
          headers: signed.headers,
          body: signed.body,
        });
      },
    ),
  );

  server.registerTool(
    "verify_webhook_signature",
    {
      title: "Verify a webhook signature",
      description:
        "Check whether a webhook signature is valid and, when it is not, explain why: wrong secret, body modified before verification (JSON re-serialised by a parser, trailing newline, CRLF), whitespace in the secret, expired timestamp, or for Twilio the URL form (http vs https, port, query, trailing slash). Use it when a handler rejects deliveries with 'invalid signature'. Runs locally: the secret never leaves the machine.",
      inputSchema: {
        provider: z.enum(PROVIDERS).describe("Signature scheme. 'svix' also covers Clerk, Resend and Standard Webhooks."),
        secret: z.string().min(1).describe("Signing secret (Discord: the application public key)."),
        raw_body: z.string().describe("The body exactly as received (e.g. the body field of get_webhook_request)."),
        headers: z.record(z.string(), z.string()).describe("Request headers, any casing, e.g. {\"stripe-signature\": \"t=…,v1=…\"}."),
        url: z.string().optional().describe("Twilio only: the full public URL Twilio called."),
        tolerance_seconds: z.number().int().min(0).optional().describe("Timestamp tolerance, default 300. 0 disables the check."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(
      async (args: {
        provider: SignatureProvider;
        secret: string;
        raw_body: string;
        headers: Record<string, string>;
        url?: string | undefined;
        tolerance_seconds?: number | undefined;
      }) => {
        const opts: VerifyOptions = { secret: args.secret, rawBody: args.raw_body, headers: args.headers };
        if (args.url) opts.url = args.url;
        if (args.tolerance_seconds !== undefined) opts.toleranceSeconds = args.tolerance_seconds;
        const result = verify(args.provider, opts);
        return text(`${result.valid ? "VALID" : `INVALID (${result.reason})`}: ${result.message}`, result);
      },
    ),
  );

  server.registerTool(
    "explain_webhook_request",
    {
      title: "Explain a captured request (AI)",
      description:
        "AI analysis of a captured webhook: what the event means, its key fields, how its signature is verified and common pitfalls; or, with mode 'handler', a ready-to-use handler in node, python, php, go or ruby. Use it on an unfamiliar payload. Needs WEBHOOK_TOOLKIT_KEY; paid feature with 3 free trials.",
      inputSchema: {
        token: z.string().min(1).describe("Webhook URL token."),
        request_id: z.string().min(1).describe("Captured request id."),
        mode: z.enum(["explain", "handler"]).default("explain").describe("'explain' (default) or 'handler' to generate code."),
        language: z.enum(["node", "python", "php", "go", "ruby"]).optional().describe("Handler language (mode 'handler')."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: { token: string; request_id: string; mode: "explain" | "handler"; language?: "node" | "python" | "php" | "go" | "ruby" | undefined }) => {
      try {
        const opts: { mode: "explain" | "handler"; language?: "node" | "python" | "php" | "go" | "ruby" } = { mode: args.mode ?? "explain" };
        if (args.language) opts.language = args.language;
        const res = await client.explainRequest(args.token, args.request_id, opts);
        const trials = res.trialsLeft !== null && res.trialsLeft !== undefined ? `\nFree AI trials left: ${res.trialsLeft}.` : "";
        if (res.result.mode === "handler") {
          return text(
            `Handler (${res.result.language}):\n\n\`\`\`${res.result.language}\n${res.result.code}\n\`\`\`\n${res.result.notes.map((n) => `- ${n}`).join("\n")}${trials}`,
          );
        }
        return text(`${res.result.summary}${trials}`, res.result);
      } catch (err) {
        // 402: return the server's upgrade message verbatim.
        if (err instanceof WebhookToolkitError && err.status === 402) {
          return failure(err.upgradeUrl ? `${err.message}\n${err.upgradeUrl}` : err.message);
        }
        return failure(errorMessage(err, client.baseUrl));
      }
    },
  );

  return server;
}

/** Runs the MCP server on stdio until stdin closes. */
export async function runStdioServer(options: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
  });
  await server.connect(transport);
  await closed;
  await server.close().catch(() => {});
}
