/** Terminal output helpers: ANSI colors honouring NO_COLOR / FORCE_COLOR / non-TTY, and formatters. */

export interface Colors {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  magenta(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
}

export function colorEnabled(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv, override?: boolean): boolean {
  if (override !== undefined) return override;
  if ("NO_COLOR" in env && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

export function createColors(enabled: boolean): Colors {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
    gray: wrap(90, 39),
  };
}

export interface Ui {
  /** Colors for stdout. */
  c: Colors;
  /** Colors for stderr. */
  ce: Colors;
  out(line?: string): void;
  err(line?: string): void;
  /** Unicode symbols unless the terminal is known not to support them. */
  sym: { ok: string; fail: string; arrow: string; warn: string; dot: string; hook: string };
}

export function createUi(
  options: {
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WriteStream;
    env?: NodeJS.ProcessEnv;
    color?: boolean;
  } = {},
): Ui {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const unicode = process.platform !== "win32" || Boolean(env.WT_SESSION) || env.TERM_PROGRAM === "vscode";
  return {
    c: createColors(colorEnabled(stdout, env, options.color)),
    ce: createColors(colorEnabled(stderr, env, options.color)),
    out: (line = "") => void stdout.write(line + "\n"),
    err: (line = "") => void stderr.write(line + "\n"),
    sym: unicode
      ? { ok: "✓", fail: "✗", arrow: "→", warn: "!", dot: "·", hook: "↳" }
      : { ok: "OK", fail: "X", arrow: "->", warn: "!", dot: "-", hook: "->" },
  };
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatClock(iso: string | Date = new Date()): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${date} ${formatClock(d).slice(0, 5)}`;
}

/** "in 6 days", "in 3 hours", "12 minutes ago". */
export function formatRelative(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  if (Number.isNaN(diff)) return iso;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  let text = "less than a minute";
  for (const [ms, name] of units) {
    if (abs >= ms) {
      // Rounded, so a URL created 2 s ago reads "in 7 days", not "in 6 days".
      const n = Math.round(abs / ms);
      text = `${n} ${name}${n > 1 ? "s" : ""}`;
      break;
    }
  }
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function statusColor(c: Colors, status: number): (s: string) => string {
  if (status >= 500) return c.red;
  if (status >= 400) return c.yellow;
  if (status >= 300) return c.cyan;
  return c.green;
}

export function methodColor(c: Colors, method: string): (s: string) => string {
  switch (method.toUpperCase()) {
    case "GET":
      return c.green;
    case "POST":
      return c.cyan;
    case "PUT":
    case "PATCH":
      return c.yellow;
    case "DELETE":
      return c.red;
    default:
      return c.magenta;
  }
}

/** Pretty-prints JSON bodies, truncates long ones. */
export function previewBody(body: string, max = 2000): string {
  let text = body;
  try {
    text = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    /* not JSON */
  }
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

export function indent(text: string, pad = "  "): string {
  return text
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}

/** Left-aligned table with a dimmed header row. */
export function table(c: Colors, headers: string[], rows: string[][]): string {
  const strip = (s: string) => s.replace(/\u001b\[\d+m/g, "");
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => strip(r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell + " ".repeat(Math.max(0, (widths[i] ?? 0) - strip(cell).length))))
      .join("  ")
      .trimEnd();
  return [c.dim(line(headers)), ...rows.map(line)].join("\n");
}

/** POSIX shell single-quoting. */
export function shellQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
