import { WebhookToolkitError } from "../../errors.js";
import { normalizeTarget } from "../../forward.js";
import { runRelay, type RelayEvent } from "../../relay.js";
import { parseArgs, UsageError, type FlagSpecs } from "../args.js";
import { GLOBAL_FLAGS, type CliContext } from "../context.js";
import { COMMAND_HELP } from "../help.js";
import { formatBytes, formatClock, methodColor, statusColor } from "../ui.js";

const FLAGS = {
  ...GLOBAL_FLAGS,
  to: { type: "string" },
  token: { type: "string" },
  json: { type: "boolean" },
} as const satisfies FlagSpecs;

function howToGetToken(baseUrl: string): string {
  return [
    "A relay token is required. The relay is a paid feature (Pass or Pro): the caller receives",
    "your localhost's real response.",
    `  1. Pick a plan:        ${baseUrl}/pricing`,
    `  2. Create a relay:     ${baseUrl}/dashboard (copy its token)`,
    "  3. Run:                webhook-toolkit relay --to 3000 --token <relay token>",
    "     (or `webhook-toolkit login` once, then `webhook-toolkit relay --to 3000`)",
    "Free alternative: webhook-toolkit listen --forward http://localhost:3000 (forwards requests,",
    "but the sender gets the capture URL's response instead of your app's).",
  ].join("\n");
}

export async function relayCommand(argv: string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv, FLAGS);
  const { ui } = ctx;
  if (flags.help) {
    ui.out(COMMAND_HELP.relay);
    return 0;
  }
  if (!flags.to) throw new UsageError("Missing --to <url|port>, e.g. webhook-toolkit relay --to 3000");
  const { c, ce, sym } = ui;
  const json = Boolean(flags.json);
  const emit = (obj: unknown) => ui.out(JSON.stringify(obj));
  const target = normalizeTarget(flags.to);
  const settings = ctx.settings(flags);

  let token = flags.token || ctx.env.WEBHOOK_TOOLKIT_RELAY_TOKEN || ctx.env.WHT_RELAY_TOKEN;
  if (!token && settings.apiKey) {
    const client = ctx.client(flags);
    try {
      const relays = await client.listRelays();
      const relay = relays[0] ?? (await client.createRelay({ name: "cli" }));
      token = relay.token;
    } catch (err) {
      if (err instanceof WebhookToolkitError && err.status === 402) {
        ui.err(ce.red(`${sym.fail} ${err.message}`));
        ui.err(`  Upgrade: ${err.upgradeUrl ?? `${settings.baseUrl}/pricing`}`);
        return 1;
      }
      throw err;
    }
  }
  if (!token) {
    ui.err(ce.red(`${sym.fail} No relay token.`));
    ui.err(howToGetToken(settings.baseUrl));
    return 1;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let served = 0;

  const onEvent = (e: RelayEvent) => {
    if (json) {
      emit(e);
      return;
    }
    switch (e.type) {
      case "connecting":
        if (e.attempt === 1) ui.err(ce.dim(`  Connecting to ${settings.baseUrl}…`));
        break;
      case "ready":
        ui.out();
        ui.out(`  ${c.bold("webhook-toolkit relay")} ${c.dim(sym.dot)} ${c.green("live")}`);
        ui.out();
        ui.out(`  ${c.dim("Public URL")}  ${c.bold(c.cyan(e.publicUrl))}  ${c.dim("(any sub-path works)")}`);
        ui.out(`  ${c.dim("Forwarding")}  ${sym.arrow} ${target}`);
        ui.out();
        ui.out(c.dim("  Callers receive your local response. Ctrl+C to stop."));
        ui.out();
        break;
      case "request": {
        served++;
        const status = e.error
          ? c.red(`502 ${sym.fail} ${e.error} (is ${new URL(target).origin} running?)`)
          : statusColor(c, e.status)(String(e.status));
        ui.out(
          `  ${c.dim(formatClock())}  ${methodColor(c, e.method)(e.method.padEnd(6))} ${e.path}  ${sym.arrow} ${status}  ${c.dim(`${e.ms} ms ${sym.dot} ${formatBytes(e.bytes)}`)}`,
        );
        break;
      }
      case "disconnected":
        ui.err(ce.dim(`  … disconnected (code ${e.code}), retrying in ${Math.round(e.retryInMs / 1000)}s`));
        break;
    }
  };

  try {
    await runRelay({ token, target, baseUrl: settings.baseUrl, onEvent, signal: controller.signal });
  } catch (err) {
    if (err instanceof WebhookToolkitError && err.code === "unauthorized") {
      ui.err(ce.red(`${sym.fail} The relay token was refused (401).`));
      ui.err(howToGetToken(settings.baseUrl));
      return 1;
    }
    throw err;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (!json) ui.err(ce.dim(`\n  Relay closed. ${served} request${served === 1 ? "" : "s"} served.`));
  return 0;
}
