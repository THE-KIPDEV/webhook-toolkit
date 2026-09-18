/**
 * Anything that carries HTTP headers: a Fetch `Headers`, Node's `IncomingHttpHeaders`,
 * a plain object (any casing) or a list of `[name, value]` pairs.
 */
export type HeadersLike =
  | { get(name: string): string | null; forEach(cb: (value: string, key: string) => void): void }
  | Record<string, string | string[] | number | undefined>
  | Iterable<readonly [string, string]>;

function isFetchHeaders(h: HeadersLike): h is Extract<HeadersLike, { get: unknown }> {
  return typeof (h as { get?: unknown }).get === "function" && typeof (h as { forEach?: unknown }).forEach === "function";
}

/** Normalises any `HeadersLike` to a plain object with lower-cased names. Repeated values are joined with `, `. */
export function toHeaderRecord(headers: HeadersLike | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const add = (key: string, value: string) => {
    const k = key.toLowerCase();
    out[k] = out[k] === undefined ? value : `${out[k]}, ${value}`;
  };
  if (isFetchHeaders(headers)) {
    headers.forEach((value, key) => add(key, value));
    return out;
  }
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === "function") {
    for (const [key, value] of headers as Iterable<readonly [string, string]>) add(key, String(value));
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | number | undefined>)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => add(key, v));
    else add(key, String(value));
  }
  return out;
}

/** Parses `"Name: value"` lines (curl `-H` style). Throws on a line without a colon. */
export function parseHeaderLines(lines: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0) throw new Error(`Invalid header "${line}": expected "Name: value".`);
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    out[key] = out[key] === undefined ? value : `${out[key]}, ${value}`;
  }
  return out;
}
