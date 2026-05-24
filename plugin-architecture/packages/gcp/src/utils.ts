import type { ResourceStatus } from "@infrawrench/plugin-base";

/**
 * Authenticated fetch against a GCP REST endpoint. Adds the OAuth token from
 * the context and a JSON Content-Type; callers pass the absolute URL and any
 * fetch init they need. Returns the raw `Response` so callers can branch on
 * status before/after reading the body.
 */
export async function gcpFetch(
  ctx: { token: () => Promise<string> },
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const tok = await ctx.token();
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Read a GCP error response and return a single-line human message.
 * Prefers `error.message` from the standard Google API error shape, falling back
 * to raw text truncated so it doesn't dominate the UI. Activation URLs in the
 * message are preserved so the UI's link parser can turn them into buttons.
 */
export async function formatGcpError(operation: string, res: Response): Promise<string> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    return `${operation} failed: ${res.status}`;
  }
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; status?: unknown } };
    const message = typeof parsed?.error?.message === "string" ? parsed.error.message : undefined;
    const status = typeof parsed?.error?.status === "string" ? parsed.error.status : undefined;
    if (message) {
      const prefix = status ? `${status}` : `${operation} failed (${res.status})`;
      return `${prefix}: ${message}`;
    }
  } catch {
    // fall through to raw body
  }
  const truncated = body.length > 400 ? `${body.slice(0, 400)}…` : body;
  return `${operation} failed (${res.status}): ${truncated}`;
}

/**
 * Parse a JSON-encoded form-args blob (as passed by host actions) into a
 * `Record<string, string>`. Values are coerced to strings; nullish values
 * become empty strings. Returns `{}` when the input isn't a string or fails
 * to parse — matches the lenient behaviour callers rely on.
 */
export function parseFormArg(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = String(v ?? "");
    return out;
  } catch {
    return {};
  }
}

export function gcpStatus(s: string | undefined): ResourceStatus {
  switch ((s ?? "").toUpperCase()) {
    case "RUNNING":
    case "ACTIVE":
    case "READY":
    case "SERVING":
    case "DEPLOYED":
    case "SUCCEEDED":
    case "ENABLED":
      return "healthy";
    case "SUSPENDED":
    case "MAINTENANCE":
    case "FAILED_TO_START":
    case "DEGRADED":
    case "DISABLED":
    case "DESTROY_SCHEDULED":
      return "degraded";
    case "FAILED":
    case "STOPPING":
    case "TERMINATED":
    case "DELETED":
    case "DESTROYED":
      return "error";
    case "CREATING":
    case "UPDATING":
    case "DEPLOYING":
    case "PROVISIONING":
    case "PENDING":
    case "STAGING":
      return "provisioning";
    default:
      return "info";
  }
}
