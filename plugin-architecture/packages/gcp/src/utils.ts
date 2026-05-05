import type { ResourceStatus } from "@infrawrench/plugin-base";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
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
