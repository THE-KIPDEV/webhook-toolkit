import { WebhookToolkitError } from "../errors.js";
import { VERSION } from "../version.js";
import { parseArgs, suggest, UsageError } from "./args.js";
import { createContext, GLOBAL_FLAGS, type CliContext } from "./context.js";
import { COMMAND_HELP, MAIN_HELP } from "./help.js";
import { createUi, type Ui } from "./ui.js";

type Command = (argv: string[], ctx: CliContext) => Promise<number>;

// Lazy imports keep `--help` and `sign` fast (no ws / MCP SDK loaded).
const COMMANDS: Record<string, () => Promise<Command>> = {
  listen: async () => (await import("./commands/listen.js")).listenCommand,
  relay: async () => (await import("./commands/relay.js")).relayCommand,
  requests: async () => (await import("./commands/requests.js")).requestsCommand,
  replay: async () => (await import("./commands/requests.js")).replayCommand,
  endpoints: async () => (await import("./commands/requests.js")).endpointsCommand,
  sign: async () => (await import("./commands/sign.js")).signCommand,
  verify: async () => (await import("./commands/verify.js")).verifyCommand,
  login: async () => (await import("./commands/account.js")).loginCommand,
  logout: async () => (await import("./commands/account.js")).logoutCommand,
  whoami: async () => (await import("./commands/account.js")).whoamiCommand,
  mcp: async () => mcpCommand,
};

async function mcpCommand(argv: string[], ctx: CliContext): Promise<number> {
  const { flags } = parseArgs(argv, GLOBAL_FLAGS);
  if (flags.help) {
    ctx.ui.out(COMMAND_HELP.mcp);
    return 0;
  }
  const settings = ctx.settings(flags);
  const { runStdioServer } = await import("../mcp/server.js");
  // stdout carries the protocol: nothing else may be printed there.
  await runStdioServer({ apiKey: settings.apiKey ?? null, baseUrl: settings.baseUrl });
  return 0;
}

function report(err: unknown, ui: Ui, command: string): number {
  const { ce, sym } = ui;
  if (err instanceof UsageError) {
    ui.err(ce.red(`${sym.fail} ${err.message}`));
    ui.err(ce.dim(`  Run "webhook-toolkit ${command} --help" for usage.`));
    return 2;
  }
  if (err instanceof WebhookToolkitError) {
    ui.err(ce.red(`${sym.fail} ${err.message}`));
    if (err.upgradeUrl) ui.err(`  Upgrade: ${err.upgradeUrl}`);
    if (err.status === 401 && !err.upgradeUrl) ui.err(ce.dim("  Check your API key: webhook-toolkit whoami / webhook-toolkit login"));
    return err.code === "invalid_input" ? 2 : 1;
  }
  const e = err as { message?: string; code?: string; stack?: string };
  if (e?.code === "ENOENT") ui.err(ce.red(`${sym.fail} ${e.message}`));
  else ui.err(ce.red(`${sym.fail} ${e?.message ?? String(err)}`));
  if (process.env.DEBUG) ui.err(e?.stack ?? "");
  return 1;
}

/** Runs the CLI and resolves with the exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let color: boolean | undefined;
  const args = argv.filter((a) => {
    if (a === "--no-color") color = false;
    else if (a === "--color") color = true;
    else return true;
    return false;
  });
  const ui = createUi({ env, ...(color === undefined ? {} : { color }) });
  const [first, ...rest] = args;

  if (!first || first === "-h" || first === "--help") {
    ui.out(MAIN_HELP);
    return 0;
  }
  if (first === "help") {
    const topic = rest[0];
    ui.out((topic && COMMAND_HELP[topic]) || MAIN_HELP);
    return 0;
  }
  if (first === "-v" || first === "--version" || first === "version") {
    ui.out(VERSION);
    return 0;
  }
  const load = COMMANDS[first];
  if (!load) {
    const hint = first.startsWith("-") ? undefined : suggest(first, Object.keys(COMMANDS));
    ui.err(ui.ce.red(`${ui.sym.fail} Unknown command "${first}".${hint ? ` Did you mean "${hint}"?` : ""}`));
    ui.err(ui.ce.dim('  Run "webhook-toolkit --help" to see all commands.'));
    return 2;
  }
  try {
    const run = await load();
    return await run(rest, createContext(ui, env));
  } catch (err) {
    return report(err, ui, first);
  }
}
