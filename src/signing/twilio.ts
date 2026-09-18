// Twilio canonicalisation helpers, ported from webhook-toolkit.com (src/lib/signer/twilio-debug.ts).
//
// Reference algorithm (twilio-node `validateRequest`):
//   data = url + concat(key + value for each key, keys sorted)
//   signature = base64(HMAC-SHA1(data, authToken))
// Repeated keys arrive as an array and are coerced to a string by JS, i.e. joined with a
// comma: that coercion is the root of twilio-node issue #722.

export type ParamEntry = [string, string];
export type UrlDelta = "scheme" | "port" | "query" | "slash";

export interface UrlVariant {
  url: string;
  /** Differences from the URL as given. Empty = the URL as given. */
  deltas: UrlDelta[];
}

const DEFAULT_PORT: Record<string, string> = { "https:": "443", "http:": "80" };

function decodeFormComponent(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    // Not percent-encoded (an already-decoded value was pasted): keep it as is.
    return s.replace(/\+/g, " ");
  }
}

/** Parses an urlencoded body (`A=1&B=2`) or one `A=1` per line. Duplicates are preserved. */
export function parseFormBody(raw: string): ParamEntry[] {
  const out: ParamEntry[] = [];
  for (const chunk of raw.split(/[&\n\r]+/)) {
    const part = chunk.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawVal = eq === -1 ? "" : part.slice(eq + 1);
    out.push([decodeFormComponent(rawKey), decodeFormComponent(rawVal)]);
  }
  return out;
}

/** True when at least one key appears more than once (group messaging, Conversations). */
export function hasRepeatedKeys(entries: readonly ParamEntry[]): boolean {
  const seen = new Set<string>();
  for (const [k] of entries) {
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/**
 * Rebuilds the exact string Twilio runs through HMAC-SHA1.
 * `sortRepeated` reproduces the `params["X"].sort()` workaround for issue #722.
 */
export function buildCanonical(url: string, entries: readonly ParamEntry[], sortRepeated = false): string {
  const grouped = new Map<string, string[]>();
  for (const [k, v] of entries) {
    const cur = grouped.get(k);
    if (cur) cur.push(v);
    else grouped.set(k, [v]);
  }
  let data = url;
  for (const key of [...grouped.keys()].sort()) {
    const values = grouped.get(key) ?? [];
    // One value → the value itself. Several → JS array coercion, i.e. comma-joined.
    const joined = values.length === 1 ? (values[0] ?? "") : (sortRepeated ? [...values].sort() : values).join(",");
    data += key + joined;
  }
  return data;
}

/** The port literally present in the URL ("" when implicit), default ports included. */
function explicitPort(raw: string): string {
  const afterScheme = raw.indexOf("//");
  if (afterScheme === -1) return "";
  const authority = raw.slice(afterScheme + 2).split(/[/?#]/)[0] ?? "";
  const m = authority.match(/:(\d+)$/);
  return m?.[1] ?? "";
}

function toggleSlash(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return null;
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname + "/";
}

/**
 * Every URL form a reverse proxy, a framework or a tunnel could plausibly hand your code,
 * starting from the one given. The variant that matches IS the diagnosis.
 */
export function urlVariants(raw: string): UrlVariant[] {
  const u = new URL(raw);
  const givenScheme = u.protocol === "http:" ? "http:" : "https:";
  // `u.port` is "" for https://host:443 (the URL parser drops default ports), but the
  // port *as typed* is what gets hashed.
  const givenPort = explicitPort(raw);
  const givenPath = u.pathname || "/";
  const givenQuery = u.search;

  const paths = [givenPath, toggleSlash(givenPath)].filter((p): p is string => p !== null);
  const queries = givenQuery ? [givenQuery, ""] : [""];

  const seen = new Set<string>();
  const out: UrlVariant[] = [];
  for (const scheme of ["https:", "http:"]) {
    const ports = new Set<string>(["", DEFAULT_PORT[scheme] ?? ""]);
    if (givenPort) ports.add(givenPort);
    for (const port of ports) {
      for (const path of paths) {
        for (const query of queries) {
          const url = `${scheme}//${u.hostname}${port ? ":" + port : ""}${path}${query}`;
          if (seen.has(url)) continue;
          seen.add(url);
          const deltas: UrlDelta[] = [];
          if (scheme !== givenScheme) deltas.push("scheme");
          if (port !== givenPort) deltas.push("port");
          if (query !== givenQuery) deltas.push("query");
          if (path !== givenPath) deltas.push("slash");
          out.push({ url, deltas });
        }
      }
    }
  }
  // The URL exactly as given first, then the closest variants.
  return out.sort((a, b) => a.deltas.length - b.deltas.length);
}
