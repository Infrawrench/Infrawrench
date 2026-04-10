import type { ResourceStatus } from "@infrawrench/plugin-base";

// ─── Shared utility functions ───────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

export function gcpStatus(
  s: string | undefined,
): ResourceStatus {
  switch ((s ?? "").toUpperCase()) {
    case "RUNNING":
    case "ACTIVE":
    case "READY":
    case "SERVING":
    case "DEPLOYED":
    case "SUCCEEDED":
      return "healthy";
    case "SUSPENDED":
    case "MAINTENANCE":
    case "FAILED_TO_START":
    case "DEGRADED":
      return "degraded";
    case "FAILED":
    case "STOPPING":
    case "TERMINATED":
    case "DELETED":
      return "error";
    case "CREATING":
    case "UPDATING":
    case "DEPLOYING":
    case "PROVISIONING":
    case "PENDING":
    case "STAGING":
      return "provisioning";
    default:
      return "unknown";
  }
}
