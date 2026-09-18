import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The last capture URL used by `listen`, reused while it has not expired. */
export interface SavedEndpoint {
  token: string;
  url: string;
  inspectUrl: string;
  expiresAt: string | null;
  createdAt: string;
  baseUrl: string;
}

export interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
  lastEndpoint?: SavedEndpoint;
}

/** `$XDG_CONFIG_HOME/webhook-toolkit/config.json`, falling back to `~/.config/webhook-toolkit/config.json`. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(base, "webhook-toolkit", "config.json");
}

export function readConfig(path = configPath()): StoredConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

/** Atomic write, file mode 600 (it may hold an API key), directory mode 700. */
export function writeConfig(config: StoredConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort (e.g. Windows) */
  }
}

export function updateConfig(patch: (config: StoredConfig) => StoredConfig, path = configPath()): StoredConfig {
  const next = patch(readConfig(path));
  writeConfig(next, path);
  return next;
}
