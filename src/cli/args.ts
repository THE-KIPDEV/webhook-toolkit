/** Minimal, typed, dependency-free argv parser. */

export type FlagType = "string" | "boolean" | "number";

export interface FlagSpec {
  type: FlagType;
  /** One-letter alias, without the dash. */
  short?: string;
  /** Repeatable (`-H a -H b`); values are collected in an array. */
  multiple?: boolean;
}

export type FlagSpecs = Record<string, FlagSpec>;

type FlagValue<F extends FlagSpec> = F["multiple"] extends true
  ? string[]
  : F["type"] extends "boolean"
    ? boolean
    : F["type"] extends "number"
      ? number
      : string;

export type ParsedFlags<S extends FlagSpecs> = { -readonly [K in keyof S]?: FlagValue<S[K]> };

export interface ParsedArgs<S extends FlagSpecs> {
  flags: ParsedFlags<S>;
  positionals: string[];
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Levenshtein distance, for "did you mean" suggestions. */
export function distance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j] ?? 0;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length] ?? 0;
}

export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = distance(input, c);
    if (d < bestScore) {
      best = c;
      bestScore = d;
    }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

export function parseArgs<S extends FlagSpecs>(argv: readonly string[], specs: S): ParsedArgs<S> {
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  const byShort = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) if (spec.short) byShort.set(spec.short, name);

  const unknown = (token: string): never => {
    const bare = token.replace(/^-+/, "").split("=")[0] ?? "";
    const hint = suggest(bare, Object.keys(specs));
    throw new UsageError(`Unknown option ${token.split("=")[0]}.${hint ? ` Did you mean --${hint}?` : ""}`);
  };

  const assign = (name: string, spec: FlagSpec, raw: string | boolean) => {
    let value: unknown = raw;
    if (spec.type === "number") {
      const n = Number(raw);
      if (typeof raw !== "string" || raw.trim() === "" || !Number.isFinite(n)) throw new UsageError(`Option --${name} expects a number, got "${String(raw)}".`);
      value = n;
    }
    if (spec.multiple) {
      const list = (flags[name] as unknown[] | undefined) ?? [];
      list.push(value);
      flags[name] = list;
    } else {
      flags[name] = value;
    }
  };

  const isKnownFlag = (token: string) => {
    if (token.startsWith("--")) {
      const name = token.slice(2).split("=")[0] ?? "";
      return name in specs || (name.startsWith("no-") && name.slice(3) in specs);
    }
    return /^-[a-zA-Z]$/.test(token) && byShort.has(token.slice(1));
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let inline: string | undefined;
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inline = eq === -1 ? undefined : token.slice(eq + 1);
      if (!(name in specs) && name.startsWith("no-") && specs[name.slice(3)]?.type === "boolean" && inline === undefined) {
        flags[name.slice(3)] = false;
        continue;
      }
    } else if (/^-[a-zA-Z]/.test(token)) {
      const short = token[1] as string;
      name = byShort.get(short);
      if (!name) unknown(token);
      const rest = token.slice(2);
      inline = rest.startsWith("=") ? rest.slice(1) : rest || undefined;
    } else {
      positionals.push(token);
      continue;
    }

    const spec = name !== undefined ? specs[name] : undefined;
    if (!spec || name === undefined) return unknown(token);
    if (spec.type === "boolean") {
      if (inline === undefined) assign(name, spec, true);
      else if (inline === "true" || inline === "false") assign(name, spec, inline === "true");
      else throw new UsageError(`Option --${name} does not take a value.`);
      continue;
    }
    if (inline !== undefined) {
      assign(name, spec, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || isKnownFlag(next)) throw new UsageError(`Option --${name} needs a value.`);
    assign(name, spec, next);
    i++;
  }
  return { flags: flags as ParsedFlags<S>, positionals };
}
