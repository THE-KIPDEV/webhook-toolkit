import type { WebhookToolkit } from "../../client.js";
import { updateConfig, type SavedEndpoint } from "../../config.js";
import { WebhookToolkitError } from "../../errors.js";
import { forwardRequest, normalizeTarget } from "../../forward.js";
import type { CapturedRequest, Endpoint } from "../../types.js";
import { parseArgs, type FlagSpecs } from "../args.js";
import { GLOBAL_FLAGS, type CliContext } from "../context.js";
import { COMMAND_HELP } from "../help.js";
import { formatBytes, formatClock, formatDateTime, formatRelative, indent, methodColor, previewBody, statusColor } from "../ui.js";

const FLAGS = {
  ...GLOBAL_FLAGS,
  forward: { type: "string", short: "f" },
  token: { type: "string", short: "t" },
  new: { type: "boolean" },
  name: { type: "string" },
  body: { type: "boolean" },
  json: { type: "boolean" },
} as const satisfies FlagSpecs;

const DAY_MS = 86_400_000;

function isAlive(saved: SavedEndpoint, now = Date.now()): boolean {
  return saved.expiresAt === null || new Date(saved.expiresAt).getTime() - now > 60_000;
}

async function resolveEndpoint(
  client: WebhookToolkit,
  ctx: CliContext,
  flags: { token?: string; new?: boolean; name?: string },
): Promise<{ endpoint: Endpoint; reused: boolean; notice?: string }> {
  if (flags.token) return { endpoint: await client.getEndpoint(flags.token), reused: true };

  const saved = ctx.config().lastEndpoint;
  // Reuse the last URL while alive, unless an account key is set and that URL is an anonymous one.
  if (!flags.new && saved && saved.baseUrl === client.baseUrl && isAlive(saved) && !(client.hasApiKey && saved.expiresAt !== null)) {
    try {
      return { endpoint: await client.getEndpoint(saved.token), reused: true };
    } catch (err) {
      if (!(err instanceof WebhookToolkitError) || ![403, 404, 410].includes(err.status)) throw err;
    }
  }
  try {
    return { endpoint: await client.createEndpoint(flags.name ? { name: flags.name } : {}), reused: false };
  } catch (err) {
    // Free accounts keep a single permanent URL: reuse it instead of failing.
    if (err instanceof WebhookToolkitError && err.code === "plan_limit" && client.hasApiKey) {
      const existing = await client.listEndpoints();
      const first = existing[0];
      if (first) return { endpoint: first, reused: true, notice: `${err.message} Reusing ${first.token}.` };
    }
    throw err;
  }
}

export async function listenCommand(argv: string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv, FLAGS);
  const { ui } = ctx;
  if (flags.help) {
    ui.out(COMMAND_HELP.listen);
    return 0;
  }
  const { c, ce, sym } = ui;
  const json = Boolean(flags.json);
  const target = flags.forward ? normalizeTarget(flags.forward) : undefined;
  const client = ctx.client(flags);
  const emit = (obj: unknown) => ui.out(JSON.stringify(obj));

  const resolveFlags: { token?: string; new?: boolean; name?: string } = {};
  if (flags.token) resolveFlags.token = flags.token;
  if (flags.new) resolveFlags.new = true;
  if (flags.name) resolveFlags.name = flags.name;
  const { endpoint, reused, notice } = await resolveEndpoint(client, ctx, resolveFlags);
  try {
    updateConfig(
      (cfg) => ({
        ...cfg,
        lastEndpoint: {
          token: endpoint.token,
          url: endpoint.url,
          inspectUrl: endpoint.inspectUrl,
          expiresAt: endpoint.expiresAt,
          createdAt: endpoint.createdAt,
          baseUrl: client.baseUrl,
        },
      }),
      ctx.configPath,
    );
  } catch {
    /* read-only home: reuse is a convenience only */
  }

  if (notice) ui.err(ce.yellow(`${sym.warn} ${notice}`));
  const expiresMs = endpoint.expiresAt ? new Date(endpoint.expiresAt).getTime() - Date.now() : null;

  if (json) {
    emit({ type: "listening", endpoint, reused, forward: target ?? null });
  } else {
    ui.out();
    ui.out(`  ${c.bold("webhook-toolkit")} ${c.dim(sym.dot)} ${c.green("listening")}`);
    ui.out();
    ui.out(`  ${c.dim("Webhook URL ")}  ${c.bold(c.cyan(endpoint.url))}${reused ? c.dim("  (reused, --new for a fresh one)") : ""}`);
    ui.out(`  ${c.dim("Inspector   ")}  ${endpoint.inspectUrl}`);
    if (target) ui.out(`  ${c.dim("Forwarding  ")}  ${sym.arrow} ${target}`);
    if (endpoint.expiresAt) {
      const soon = expiresMs !== null && expiresMs < DAY_MS;
      const when = `${formatRelative(endpoint.expiresAt)} (${formatDateTime(endpoint.expiresAt)})`;
      ui.out(`  ${c.dim("Expires     ")}  ${soon ? c.yellow(when) : when}`);
      ui.out(c.dim(`                Anonymous URL. Run \`webhook-toolkit login\` to get a permanent one.`));
    } else {
      ui.out(`  ${c.dim("Expires     ")}  never`);
    }
    ui.out();
    ui.out(c.dim(`  Waiting for webhooks${target ? "" : " (add --forward <url> to send them to localhost)"}. Ctrl+C to stop.`));
    ui.out();
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  if (expiresMs !== null && expiresMs > 0 && expiresMs < 2 ** 31 - 1) {
    expiryTimer = setTimeout(() => {
      const msg = `This anonymous URL expired at ${formatDateTime(endpoint.expiresAt as string)}: new requests are refused. Run \`webhook-toolkit listen --new\` for a fresh URL, or \`webhook-toolkit login\` for a permanent one.`;
      if (json) emit({ type: "expired", token: endpoint.token, expiresAt: endpoint.expiresAt });
      ui.err(ce.yellow(`${sym.warn} ${msg}`));
    }, expiresMs);
    expiryTimer.unref();
  }

  let count = 0;
  let disconnected = false;
  const onRequest = async (req: CapturedRequest) => {
    count++;
    const path = req.path + (req.query ? `?${req.query}` : "");
    const bodyBytes = Buffer.byteLength(req.body, "utf8");
    const truncated = req.size > bodyBytes;
    if (json) emit({ type: "request", request: req });
    else {
      const badge = req.provider ? c.magenta(`${req.provider}${req.event ? ` ${req.event}` : ""}`) : "";
      ui.out(
        `  ${c.dim(formatClock(req.createdAt))}  ${methodColor(c, req.method)(req.method.padEnd(6))} ${path}  ${badge}${badge ? "  " : ""}${c.dim(formatBytes(req.size))}`,
      );
      if (flags.body && req.body) ui.out(c.dim(indent(previewBody(req.body), "            ")));
      if (truncated) {
        ui.out(c.yellow(`            ${sym.warn} body truncated by the plan limit (${formatBytes(bodyBytes)} of ${formatBytes(req.size)} kept): signatures will not verify`));
      }
    }
    if (!target) return;
    try {
      const res = await forwardRequest(req, target, { signal: controller.signal });
      if (json) emit({ type: "forward", requestId: req.id, url: res.url, status: res.status, ms: res.ms });
      else {
        const hint = res.status >= 400 && res.body ? c.dim(`  ${res.body.replace(/\s+/g, " ").slice(0, 120)}`) : "";
        ui.out(`            ${c.dim(sym.hook)} ${statusColor(c, res.status)(`${res.status} ${res.statusText}`.trim())} ${c.dim(`${sym.dot} ${res.ms} ms`)}${hint}`);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      if (json) emit({ type: "forward", requestId: req.id, error: message });
      else {
        const refused = /connection refused/.test(message);
        ui.out(`            ${c.dim(sym.hook)} ${c.red(`${sym.fail} ${message}`)}${refused ? c.dim(` (is ${new URL(target).origin} running?)`) : ""}`);
      }
    }
  };

  // Requests that land between resolving the URL and connecting the stream are delivered too.
  let after = endpoint.createdAt;
  if (reused) {
    const latest = (await client.listRequests(endpoint.token, { limit: 1 }))[0];
    after = latest?.createdAt ?? endpoint.createdAt;
  }

  try {
    await client.stream(endpoint.token, onRequest, {
      after,
      signal: controller.signal,
      onOpen: () => {
        if (disconnected) ui.err(ce.green(`  ${sym.ok} reconnected`));
        disconnected = false;
      },
      onReconnect: ({ delayMs, error }) => {
        disconnected = true;
        const why = error instanceof Error ? error.message : String(error);
        ui.err(ce.dim(`  … connection lost (${why}), reconnecting in ${Math.round(delayMs / 1000)}s`));
      },
    });
  } catch (err) {
    if (err instanceof WebhookToolkitError && err.status === 410) {
      ui.err(
        ce.red(`${sym.fail} This URL has expired.`) +
          ` Run \`webhook-toolkit listen --new\` for a fresh one, or \`webhook-toolkit login\` for a permanent URL.`,
      );
      return 1;
    }
    throw err;
  } finally {
    clearTimeout(expiryTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (!json) {
    ui.err();
    ui.err(ce.dim(`  Stopped. ${count} request${count === 1 ? "" : "s"} received. Inspect them any time: ${endpoint.inspectUrl}`));
  }
  return 0;
}
