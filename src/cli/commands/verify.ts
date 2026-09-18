import { readFileSync } from "node:fs";
import { parseHeaderLines } from "../../headers.js";
import { getSignatureProvider } from "../../signing/providers.js";
import { verify, type VerifyOptions } from "../../signing/verify.js";
import { parseArgs, UsageError, type FlagSpecs } from "../args.js";
import { GLOBAL_FLAGS, readStdin, type CliContext } from "../context.js";
import { COMMAND_HELP } from "../help.js";
import { formatRelative } from "../ui.js";
import { resolveProviderArg } from "./sign.js";

const FLAGS = {
  ...GLOBAL_FLAGS,
  secret: { type: "string", short: "s" },
  "body-file": { type: "string" },
  body: { type: "string" },
  header: { type: "string", short: "H", multiple: true },
  url: { type: "string" },
  tolerance: { type: "number" },
  json: { type: "boolean" },
} as const satisfies FlagSpecs;

export async function verifyCommand(argv: string[], ctx: CliContext): Promise<number> {
  const { flags, positionals } = parseArgs(argv, FLAGS);
  const { ui } = ctx;
  if (flags.help) {
    ui.out(COMMAND_HELP.verify);
    return 0;
  }
  const provider = resolveProviderArg(positionals[0], "verify");
  if (!flags.secret) throw new UsageError(`Missing --secret. ${getSignatureProvider(provider)?.secretHint ?? ""}`.trim());
  if (flags.body !== undefined && flags["body-file"] !== undefined) throw new UsageError("Use either --body or --body-file, not both.");

  let rawBody: string | Uint8Array;
  if (flags["body-file"] !== undefined) {
    // Bytes, not text: a signature covers the exact bytes received.
    rawBody = flags["body-file"] === "-" ? await readStdin(ctx.stdin) : readFileSync(flags["body-file"]);
  } else if (flags.body !== undefined) {
    rawBody = flags.body;
  } else {
    throw new UsageError('Missing body: pass --body-file <path> (or "-" for stdin) or --body <string>.');
  }
  let headers: Record<string, string>;
  try {
    headers = parseHeaderLines(flags.header ?? []);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (Object.keys(headers).length === 0 && provider !== "mailgun") {
    const h = getSignatureProvider(provider)?.signatureHeader ?? "the signature header";
    throw new UsageError(`Missing headers: pass the request headers with -H "Name: value" (at least ${h}).`);
  }

  const opts: VerifyOptions = { secret: flags.secret, rawBody, headers };
  if (flags.url) opts.url = flags.url;
  if (flags.tolerance !== undefined) opts.toleranceSeconds = flags.tolerance;
  const result = verify(provider, opts);

  if (flags.json) {
    ui.out(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }
  const { c, sym } = ui;
  const label = getSignatureProvider(provider)?.label ?? provider;
  if (result.valid) {
    ui.out(c.green(`${sym.ok} Valid ${label} signature.`));
  } else {
    ui.out(`${c.red(`${sym.fail} Invalid ${label} signature`)} ${c.dim(`(${result.reason})`)}`);
    ui.out(`  ${result.message}`);
  }
  if (result.expected !== undefined) ui.out(`  ${c.dim("expected ")} ${result.expected}`);
  if (result.received !== undefined) ui.out(`  ${c.dim("received ")} ${result.received}`);
  if (result.timestamp) {
    const age = result.timestamp.ageSeconds;
    const when =
      Math.abs(age) < 120 ? (age >= 0 ? `${age}s ago` : `${-age}s in the future`) : formatRelative(new Date(result.timestamp.value * 1000).toISOString());
    ui.out(`  ${c.dim("timestamp")} ${result.timestamp.value} ${c.dim(`(${when})`)}`);
  }
  return result.valid ? 0 : 1;
}
