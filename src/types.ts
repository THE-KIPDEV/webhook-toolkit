/** What a capture URL answers to the sender. */
export interface EndpointResponse {
  status: number;
  body: string;
  contentType: string;
}

/** A capture URL (`https://webhook-toolkit.com/r/<token>`). */
export interface Endpoint {
  id: string;
  /** Short capability token, e.g. `"7ETMyMMafpdj"`. Anyone holding it can read the requests. */
  token: string;
  name: string;
  /** Send webhooks here: any method, any sub-path (`<url>/stripe` works too). */
  url: string;
  /** Live web inspector for this URL. */
  inspectUrl: string;
  /** ISO date. `null` means permanent (account endpoints). Anonymous URLs last 7 days. */
  expiresAt: string | null;
  requestCount: number;
  createdAt: string;
  response: EndpointResponse;
}

/** A request received by a capture URL. */
export interface CapturedRequest {
  id: string;
  method: string;
  /** Sub-path after `/r/<token>`, `"/"` when none. */
  path: string;
  /** Raw query string, without `?`. */
  query: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Raw body as UTF-8 text (truncated to the plan's max body size, see `size`). */
  body: string;
  contentType: string;
  /** Original body size in bytes. */
  size: number;
  ip: string;
  /** ISO-3166 alpha-2, or `""`. */
  country: string;
  createdAt: string;
  /** Detected sender (`"stripe"`, `"github"`, …) or `null`. */
  provider: string | null;
  /** Detected event type (`"checkout.session.completed"`, `"push"`, …) or `null`. */
  event: string | null;
}

export type Plan = "free" | "pass" | "pro" | "business";

export interface Me {
  email: string;
  plan: Plan | (string & {});
  planActiveUntil: string | null;
  limits: Record<string, unknown>;
}

/** A paid relay (real tunnel whose responses come from your localhost). */
export interface Relay {
  id: string;
  slug: string;
  token: string;
  name: string;
  publicUrl: string;
  lastSeen: string | null;
}

/** Result of a server-side replay (`POST …/replay`). */
export interface RemoteReplayResult {
  status: number;
  statusText: string;
  ms: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export type ExplainLanguage = "node" | "python" | "php" | "go" | "ruby";

export interface ExplainAnalysis {
  mode: "explain";
  provider: string | null;
  event: string | null;
  summary: string;
  keyFields: { path: string; value: string; meaning: string }[];
  signature: { header: string | null; algorithm: string | null; howToVerify: string };
  pitfalls: string[];
}

export interface ExplainHandler {
  mode: "handler";
  language: string;
  code: string;
  notes: string[];
}

export interface ExplainResponse {
  result: ExplainAnalysis | ExplainHandler;
  /** Free AI trials left, `null` on paid plans. */
  trialsLeft: number | null;
}
