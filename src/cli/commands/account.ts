import { WebhookToolkit } from "../../client.js";
import { readConfig, writeConfig } from "../../config.js";
import { WebhookToolkitError } from "../../errors.js";
import { parseArgs, type FlagSpecs } from "../args.js";
import { GLOBAL_FLAGS, readStdin, type CliContext } from "../context.js";
import { COMMAND_HELP } from "../help.js";
import { formatDateTime } from "../ui.js";

/** Reads a secret from the terminal without echoing it (masked with *). */
function promptHidden(question: string, stdin: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          cleanup();
          output.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        output.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

export async function loginCommand(argv: string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv, GLOBAL_FLAGS);
  const { ui } = ctx;
  if (flags.help) {
    ui.out(COMMAND_HELP.login);
    return 0;
  }
  const { c, ce, sym } = ui;
  const baseUrl = ctx.settings(flags).baseUrl;
  let key = flags.key?.trim();
  if (!key) {
    if (ctx.stdin.isTTY) {
      ui.err(`Create an API key at ${baseUrl}/dashboard, then paste it here.`);
      key = await promptHidden("API key: ", ctx.stdin, process.stderr);
    } else {
      key = (await readStdin(ctx.stdin)).toString("utf8").trim();
    }
  }
  if (!key) {
    ui.err(ce.red(`${sym.fail} No key given.`));
    return 1;
  }
  if (!key.startsWith("whk_")) ui.err(ce.yellow(`${sym.warn} API keys start with "whk_": checking it anyway.`));

  try {
    const me = await new WebhookToolkit({ apiKey: key, baseUrl }).me();
    const cfg = readConfig(ctx.configPath);
    cfg.apiKey = key;
    if (flags["base-url"]) cfg.baseUrl = baseUrl;
    // An anonymous "last URL" would shadow the account's permanent ones.
    if (cfg.lastEndpoint?.expiresAt) delete cfg.lastEndpoint;
    writeConfig(cfg, ctx.configPath);
    const until = me.planActiveUntil ? `, until ${formatDateTime(me.planActiveUntil)}` : "";
    ui.out(c.green(`${sym.ok} Logged in as ${me.email}`) + c.dim(` (${me.plan} plan${until})`));
    ui.out(c.dim(`  Key saved to ${ctx.configPath} (mode 600).`));
    return 0;
  } catch (err) {
    if (err instanceof WebhookToolkitError && err.status === 401) {
      ui.err(ce.red(`${sym.fail} This key was refused (401). Check it in ${baseUrl}/dashboard.`));
      return 1;
    }
    throw err;
  }
}

export async function logoutCommand(argv: string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv, GLOBAL_FLAGS);
  const { ui } = ctx;
  if (flags.help) {
    ui.out(COMMAND_HELP.logout);
    return 0;
  }
  const cfg = readConfig(ctx.configPath);
  if (!cfg.apiKey) {
    ui.out("Not logged in: no saved key.");
  } else {
    delete cfg.apiKey;
    delete cfg.lastEndpoint;
    writeConfig(cfg, ctx.configPath);
    ui.out(ui.c.green(`${ui.sym.ok} Logged out.`) + ui.c.dim(` Key removed from ${ctx.configPath}.`));
  }
  if (ctx.env.WEBHOOK_TOOLKIT_KEY) ui.err(ui.ce.yellow(`${ui.sym.warn} WEBHOOK_TOOLKIT_KEY is still set in your environment.`));
  return 0;
}

export async function whoamiCommand(argv: string[], ctx: CliContext): Promise<number> {
  const FLAGS = { ...GLOBAL_FLAGS, json: { type: "boolean" } } as const satisfies FlagSpecs;
  const { flags } = parseArgs(argv, FLAGS);
  const { ui } = ctx;
  if (flags.help) {
    ui.out(COMMAND_HELP.whoami);
    return 0;
  }
  const settings = ctx.settings(flags);
  if (!settings.apiKey) {
    if (flags.json) ui.out(JSON.stringify({ loggedIn: false, baseUrl: settings.baseUrl }));
    else ui.out(`Not logged in (anonymous mode: URLs expire after 7 days). Run \`webhook-toolkit login\`.`);
    return 1;
  }
  const me = await ctx.client(flags).me();
  if (flags.json) {
    ui.out(JSON.stringify({ loggedIn: true, keySource: settings.apiKeySource, baseUrl: settings.baseUrl, ...me }, null, 2));
    return 0;
  }
  const { c } = ui;
  const source = { flag: "--key", env: "WEBHOOK_TOOLKIT_KEY", config: ctx.configPath }[settings.apiKeySource ?? "config"];
  ui.out(`${c.bold(me.email)}  ${c.cyan(me.plan)}${me.planActiveUntil ? c.dim(` until ${formatDateTime(me.planActiveUntil)}`) : ""}`);
  const limits = Object.entries(me.limits ?? {});
  if (limits.length) ui.out(c.dim(`  limits: ${limits.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ")}`));
  ui.out(c.dim(`  key from ${source} ${ui.sym.dot} ${settings.baseUrl}`));
  return 0;
}
