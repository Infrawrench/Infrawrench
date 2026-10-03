/**
 * Logs tab sources, both from the Cloud API:
 * - `GET /v1/organizations/{org}/activities`: the organization audit trail
 *   (service starts, stops, idling, scaling, setting changes, backups), read
 *   per service by filtering on `serviceId`.
 * - `GET /v1/organizations/{org}/postgres/{id}/logs` (beta): the Managed
 *   Postgres server log, newest first, filterable by severity.
 */

export interface CloudActivity {
  id?: string;
  createdAt?: string;
  type?: string;
  actorType?: string;
  actorDetails?: string;
  actorIpAddress?: string;
  serviceId?: string;
}

export interface PostgresLogEntry {
  timestamp?: string;
  severity?: string;
  body?: string;
}

const stamp = (iso: string | undefined) =>
  String(iso ?? "?")
    .replace("T", " ")
    .replace(/(\.\d+)?Z$/, "");

/** The newest `tail` activities for one service, printed oldest first. */
export function serviceActivityLines(
  activities: CloudActivity[],
  serviceId: string,
  tail: number,
): string {
  return activities
    .filter((a) => a.serviceId === serviceId)
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
    .slice(-tail)
    .map((a) => {
      const actor = [a.actorType, a.actorDetails].filter(Boolean).join(": ");
      const ip = a.actorIpAddress ? ` from ${a.actorIpAddress}` : "";
      return `${stamp(a.createdAt)}  ${a.type ?? "unknown"}${actor ? `  by ${actor}${ip}` : ""}\n`;
    })
    .join("");
}

/** Postgres log entries arrive newest first; print them oldest first. */
export function postgresLogLines(entries: PostgresLogEntry[]): string {
  return [...entries]
    .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")))
    .map((e) => `${stamp(e.timestamp)}  ${(e.severity ?? "LOG").padEnd(7)}  ${e.body ?? ""}\n`)
    .join("");
}

/** Severity choices offered in the Logs tab's dropdown for Managed Postgres. */
export const POSTGRES_LOG_FILTERS = ["all", "ERROR", "WARNING", "FATAL"] as const;
