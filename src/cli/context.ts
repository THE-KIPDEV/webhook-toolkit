import { DEFAULT_BASE_URL, normalizeBaseUrl, WebhookToolkit } from "../client.js";
import { configPath, readConfig, type StoredConfig } from "../config.js";
import type { FlagSpecs } from "./args.js";
import type { Ui } from "./ui.js";

/** Options accepted by every command. */
export const GLOBAL_FLAGS = {
  key: { type: "string" },
  "base-url": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies FlagSpecs;

export type KeySource = "flag" | "env" | "config";

export interface Settings {
  apiKey: string | undefined;
  apiKeySource: KeySource | undefined;
  baseUrl: string;
}

export interface CliContext {
  ui: Ui;
  env: NodeJS.ProcessEnv;
  configPath: string;
  config(): StoredConfig;
  settings(flags: { key?: string; "base-url"?: string }): Settings;
  client(flags: { key?: string; "base-url"?: string }): WebhookToolkit;
  stdin: NodeJS.ReadStream;
}

export function createContext(ui: Ui, env: NodeJS.ProcessEnv = process.env): CliContext {
  const path = configPath(env);
  const config = () => readConfig(path);
  const settings = (flags: { key?: string; "base-url"?: string }): Settings => {
    const cfg = config();
    let apiKey: string | undefined;
    let apiKeySource: KeySource | undefined;
    if (flags.key) [apiKey, apiKeySource] = [flags.key, "flag"];
    else if (env.WEBHOOK_TOOLKIT_KEY) [apiKey, apiKeySource] = [env.WEBHOOK_TOOLKIT_KEY, "env"];
    else if (cfg.apiKey) [apiKey, apiKeySource] = [cfg.apiKey, "config"];
    const baseUrl = normalizeBaseUrl(flags["base-url"] || env.WEBHOOK_TOOLKIT_URL || cfg.baseUrl || DEFAULT_BASE_URL);
    return { apiKey, apiKeySource, baseUrl };
  };
  return {
    ui,
    env,
    configPath: path,
    config,
    settings,
    client: (flags) => {
      const s = settings(flags);
      return new WebhookToolkit({ apiKey: s.apiKey ?? null, baseUrl: s.baseUrl });
    },
    stdin: process.stdin,
  };
}

/** Reads all of stdin (empty string when stdin is a TTY). */
export async function readStdin(stdin: NodeJS.ReadStream = process.stdin): Promise<Buffer> {
  if (stdin.isTTY) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks);
}
