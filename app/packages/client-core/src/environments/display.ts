/** Small display helpers shared by every surface that lists instances. */
import type { EnvironmentInstance } from "./types";

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Human countdown for a TTL: "2d 4h", "45m", "expired". */
export function formatTimeRemaining(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return "unknown";
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const remainderMinutes = minutes % 60;
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours > 0 ? `${days}d ${remainderHours}h` : `${days}d`;
}

/** True while an instance still owns cloud resources worth tearing down. */
export function instanceIsLive(instance: Pick<EnvironmentInstance, "status">): boolean {
  return (
    instance.status === "creating" ||
    instance.status === "active" ||
    instance.status === "partial" ||
    instance.status === "tearing-down"
  );
}
