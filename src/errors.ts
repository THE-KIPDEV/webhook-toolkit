export interface WebhookToolkitErrorOptions {
  /** HTTP status of the API response, `0` when no response was received. */
  status?: number;
  /** Machine-readable code: the API's `error` field, or a client code such as `timeout`. */
  code?: string;
  /** Present on `402` answers: where to pick a plan. */
  upgradeUrl?: string;
  cause?: unknown;
}

/**
 * Every error thrown by this package.
 *
 * API codes: `bad_request`, `unauthorized`, `upgrade_required`, `plan_limit`, `forbidden`,
 * `not_found`, `expired`, `rate_limited`, `blocked_host`.
 * Client codes (status `0`): `network_error`, `timeout`, `aborted`, `bad_response`,
 * `forward_failed`, `invalid_input`.
 */
export class WebhookToolkitError extends Error {
  override readonly name = "WebhookToolkitError";
  readonly status: number;
  readonly code: string;
  readonly upgradeUrl: string | undefined;

  constructor(message: string, options: WebhookToolkitErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = options.status ?? 0;
    this.code = options.code ?? "error";
    this.upgradeUrl = options.upgradeUrl;
  }
}

export function isWebhookToolkitError(err: unknown): err is WebhookToolkitError {
  return err instanceof WebhookToolkitError;
}

const FALLBACK_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  402: "upgrade_required",
  403: "forbidden",
  404: "not_found",
  410: "expired",
  429: "rate_limited",
};

export function codeForStatus(status: number): string {
  return FALLBACK_CODES[status] ?? (status >= 500 ? "server_error" : "http_error");
}

/** Readable explanation of a low-level network failure (`ECONNREFUSED` → "connection refused"). */
export function describeNetworkError(err: unknown): string {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | undefined;
  const code = e?.cause?.code ?? e?.code;
  switch (code) {
    case "ECONNREFUSED":
      return "connection refused";
    case "ENOTFOUND":
      return "host not found";
    case "ECONNRESET":
      return "connection reset";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return "connection timed out";
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
      return "response timed out";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return `TLS error (${code})`;
    default:
      break;
  }
  if ((e as { name?: string } | undefined)?.name === "TimeoutError") return "timed out";
  return e?.cause?.message ?? e?.message ?? String(err);
}
