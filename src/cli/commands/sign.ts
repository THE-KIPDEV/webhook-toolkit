import { readFileSync } from "node:fs";
import { forwardRequest, normalizeTarget } from "../../forward.js";
import { getSignatureProvider, SIGNATURE_PROVIDER_IDS } from "../../signing/providers.js";
import { sign, type SignOptions } from "../../signing/sign.js";
import { parseArgs, suggest, UsageError, type FlagSpecs } from "../args.js";
import { GLOBAL_FLAGS, readStdin, type CliContext } from "../context.js";
import { COMMAND_HELP } from "../help.js";
import { formatBytes, indent, previewBody, shellQuote, statusColor } from "../ui.js";

const FLAGS = {
  ...GLOBAL_FLAGS,
  secret: { type: "string", short: "s" },
  payload: { type: "string", short: "d" },
  file: { type: "string" },
  event: { type: "string", short: "e" },
  send: { type: "string" },
  url: { type: "string" },
  timestamp: { type: "number" },
  id: { type: "string" },
  json: { type: "boolean" },
} as const satisfies FlagSpecs;

export function resolveProviderArg(value: string | undefined, command: string): string {
  if (!value) throw new UsageError(`Missing <provider>. Usage: webhook-toolkit ${command} <${SIGNATURE_PROVIDER_IDS.join("|")}> …`);
  const info = getSignatureProvider(value);
  if (!info) {
    const hint = suggest(value.toLowerCase(), SIGNATURE_PROVIDER_IDS);
    throw new UsageError(`Unknown provider "${value}".${hint ? ` Did you mean ${hint}?` : ""} Supported: ${SIGNATURE_PROVIDER_IDS.join(", ")}.`);
  }
  return info.id;
}

export function curlCommand(url: string, headers: Record<string, string>, body: string): string {
  const lines = [`curl -X POST ${shellQuote(url)}`];
  for (const [k, v] of Object.entries(headers)) lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
  lines.push(`  --data-raw ${shellQuote(body)}`);
  return lines.join(" \\\n");
}

export async function signCommand(argv: string[], ctx: CliContext): Promise<number> {
  const { flags, positionals } = parseArgs(argv, FLAGS);
  const { ui } = ctx;
  if (flags.help) {
    ui.out(COMMAND_HELP.sign);
    return 0;
  }
  const provider = resolveProviderArg(positionals[0], "sign");
  if (!flags.secret) throw new UsageError(`Missing --secret. ${getSignatureProvider(provider)?.secretHint ?? ""}`.trim());
  if (flags.payload !== undefined && flags.file !== undefined) throw new UsageError("Use either --payload or --file, not both.");

  let payload: string | undefined = flags.payload;
  if (flags.file !== undefined) {
    payload = flags.file === "-" ? (await readStdin(ctx.stdin)).toString("utf8") : readFileSync(flags.file, "utf8");
  }
  const sendTo = flags.send ? normalizeTarget(flags.send) : undefined;
  const opts: SignOptions = { secret: flags.secret };
  if (payload !== undefined) opts.payload = payload;
  if (flags.event) opts.event = flags.event;
  if (flags.timestamp !== undefined) opts.timestamp = flags.timestamp;
  if (flags.id) opts.id = flags.id;
  const twilioUrl = flags.url ?? sendTo;
  if (twilioUrl) opts.url = twilioUrl;
  if (provider === "twilio" && !twilioUrl) {
    throw new UsageError("Twilio signs the public URL it calls: pass --url https://… (or --send, used as the URL).");
  }

  const signed = sign(provider, opts);
  const { c, sym } = ui;
  const curlUrl = sendTo ?? twilioUrl ?? "http://localhost:3000/webhooks";

  if (!sendTo) {
    if (flags.json) {
      ui.out(JSON.stringify({ ...signed, curl: curlCommand(curlUrl, signed.headers, signed.body) }, null, 2));
      return 0;
    }
    const label = getSignatureProvider(provider)?.label ?? provider;
    ui.out(`${c.bold(`Signed ${label} webhook`)}${signed.event ? c.dim(` (${signed.event})`) : ""}`);
    ui.out();
    ui.out(c.dim("Headers"));
    for (const [k, v] of Object.entries(signed.headers)) ui.out(`  ${c.cyan(k)}: ${v}`);
    ui.out();
    ui.out(c.dim(`Body (${formatBytes(Buffer.byteLength(signed.body))})`));
    ui.out(indent(previewBody(signed.body, 4000)));
    ui.out();
    ui.out(c.dim("curl"));
    ui.out(curlCommand(curlUrl, signed.headers, signed.body));
    if (!flags.send) ui.out(c.dim(`\nAdd --send <url> to send it now.`));
    return 0;
  }

  const res = await forwardRequest(
    { method: "POST", path: "/", query: "", headers: signed.headers, body: signed.body },
    sendTo,
  );
  if (flags.json) {
    ui.out(JSON.stringify({ request: signed, response: res }, null, 2));
  } else {
    ui.out(`${c.bold("POST")} ${res.url} ${c.dim(`(${signed.provider}${signed.event ? ` ${signed.event}` : ""})`)}`);
    ui.out(`${sym.arrow} ${statusColor(c, res.status)(`${res.status} ${res.statusText}`.trim())} ${c.dim(`${sym.dot} ${res.ms} ms`)}`);
    if (res.body) ui.out(indent(previewBody(res.body)));
  }
  return res.status < 400 ? 0 : 1;
}
