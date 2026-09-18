import { forwardRequest, normalizeTarget } from "../../forward.js";
import { parseArgs, UsageError, type FlagSpecs } from "../args.js";
import { GLOBAL_FLAGS, type CliContext } from "../context.js";
import { COMMAND_HELP } from "../help.js";
import { formatBytes, formatDateTime, formatRelative, indent, methodColor, previewBody, statusColor, table } from "../ui.js";

const TIMESTAMPED = new Set(["stripe", "slack", "svix", "paddle", "discord"]);

export async function requestsCommand(argv: string[], ctx: CliContext): Promise<number> {
  const FLAGS = {
    ...GLOBAL_FLAGS,
    limit: { type: "number", short: "n" },
    after: { type: "string" },
    json: { type: "boolean" },
  } as const satisfies FlagSpecs;
  const { flags, positionals } = parseArgs(argv, FLAGS);
  const { ui } = ctx;
  if (flags.help) {
    ui.out(COMMAND_HELP.requests);
    return 0;
  }
  const token = positionals[0];
  if (!token) throw new UsageError("Missing <token>. Usage: webhook-toolkit requests <token>");
  const limit = flags.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UsageError("--limit must be an integer between 1 and 200.");
  const client = ctx.client(flags);
  const requests = await client.listRequests(token, flags.after ? { limit, after: flags.after } : { limit });
  if (flags.json) {
    ui.out(JSON.stringify(requests, null, 2));
    return 0;
  }
  const { c } = ui;
  if (requests.length === 0) {
    ui.out(`No requests yet. Send one:\n  curl -X POST ${client.baseUrl}/r/${token} -H 'content-type: application/json' -d '{"hello":"world"}'`);
    return 0;
  }
  const rows = requests.map((r) => [
    formatDateTime(r.createdAt),
    r.id,
    methodColor(c, r.method)(r.method),
    r.path + (r.query ? `?${r.query}` : ""),
    r.provider ? c.magenta(`${r.provider}${r.event ? ` ${r.event}` : ""}`) : c.dim("-"),
    formatBytes(r.size),
  ]);
  ui.out(table(c, ["TIME", "ID", "METHOD", "PATH", "FROM", "SIZE"], rows));
  return 0;
}

export async function endpointsCommand(argv: string[], ctx: CliContext): Promise<number> {
  const FLAGS = { ...GLOBAL_FLAGS, json: { type: "boolean" } } as const satisfies FlagSpecs;
  const { flags } = parseArgs(argv, FLAGS);
  const { ui } = ctx;
  if (flags.help) {
    ui.out(COMMAND_HELP.endpoints);
    return 0;
  }
  const endpoints = await ctx.client(flags).listEndpoints();
  if (flags.json) {
    ui.out(JSON.stringify(endpoints, null, 2));
    return 0;
  }
  const { c } = ui;
  if (endpoints.length === 0) {
    ui.out("No URLs yet. Create one with: webhook-toolkit listen");
    return 0;
  }
  ui.out(
    table(
      c,
      ["TOKEN", "NAME", "REQUESTS", "EXPIRES", "URL"],
      endpoints.map((e) => [e.token, e.name, String(e.requestCount), e.expiresAt ? formatRelative(e.expiresAt) : "never", e.url]),
    ),
  );
  return 0;
}

export async function replayCommand(argv: string[], ctx: CliContext): Promise<number> {
  const FLAGS = { ...GLOBAL_FLAGS, to: { type: "string" }, json: { type: "boolean" } } as const satisfies FlagSpecs;
  const { flags, positionals } = parseArgs(argv, FLAGS);
  const { ui } = ctx;
  if (flags.help) {
    ui.out(COMMAND_HELP.replay);
    return 0;
  }
  const [token, id] = positionals;
  if (!token || !id) throw new UsageError("Usage: webhook-toolkit replay <token> <requestId> --to <url|port>");
  if (!flags.to) throw new UsageError("Missing --to <url|port>, e.g. --to http://localhost:3000/webhooks");
  const target = normalizeTarget(flags.to);
  const req = await ctx.client(flags).getRequest(token, id);
  const res = await forwardRequest(req, target);
  if (flags.json) {
    ui.out(JSON.stringify({ request: { id: req.id, method: req.method, path: req.path, provider: req.provider, event: req.event }, response: res }, null, 2));
    return res.status < 400 ? 0 : 1;
  }
  const { c, sym } = ui;
  ui.out(`${methodColor(c, req.method)(req.method)} ${res.url} ${req.provider ? c.magenta(`${req.provider}${req.event ? ` ${req.event}` : ""}`) : ""}`);
  ui.out(`${sym.arrow} ${statusColor(c, res.status)(`${res.status} ${res.statusText}`.trim())} ${c.dim(`${sym.dot} ${res.ms} ms`)}`);
  if (res.body) ui.out(indent(previewBody(res.body)));
  const ageSec = (Date.now() - new Date(req.createdAt).getTime()) / 1000;
  if (req.provider && TIMESTAMPED.has(req.provider) && ageSec > 300) {
    ui.out(
      c.yellow(
        `${sym.warn} The ${req.provider} signature was captured ${Math.round(ageSec / 60)} min ago: handlers enforcing the 5-minute window reject it. ` +
          `Use \`webhook-toolkit sign ${req.provider} --send ${flags.to}\` for a freshly signed copy.`,
      ),
    );
  }
  return res.status < 400 ? 0 : 1;
}
