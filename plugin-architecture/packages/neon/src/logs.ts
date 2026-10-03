/**
 * The Logs tab on a branch, from Neon's branch logs API
 * (`POST /projects/{project_id}/branches/{branch_id}/logs/query`; Private
 * Beta, verified against the v2 OpenAPI spec, October 2026). Records are
 * OpenTelemetry logs from the services running on the branch: Postgres
 * computes (`pg_endpoint`), Object Storage and Functions.
 *
 * `@neondatabase/api-client@2.7.3` predates the endpoint, so the request goes
 * through the SDK's own `request` (same auth and base URL) rather than a
 * generated method.
 */

import type { Api, ContentType } from "@neondatabase/api-client";
import type { LogsFetchParams, LogsFetchResult } from "@infrawrench/plugin-base";

/** Dropdown entry → the API's `source` filter (`undefined` means every source). */
const SOURCES: Record<string, string | undefined> = {
  all: undefined,
  postgres: "pg_endpoint",
  storage: "storage",
  functions: "function",
};
export const NEON_LOG_CONTAINERS = Object.keys(SOURCES);

/** How far back the tail looks; the API allows at most seven days. */
const WINDOW = "24h";

interface LogRecord {
  timestamp?: string;
  message?: string;
  source?: string;
  severity_text?: string;
  service_name?: string;
}

export async function fetchBranchLogs(
  api: Api<unknown>,
  projectId: string,
  branchId: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const container =
    params.container && params.container in SOURCES ? params.container : NEON_LOG_CONTAINERS[0]!;
  const source = SOURCES[container];
  const limit = Math.min(Math.max(params.tailLines ?? 200, 1), 1000);
  const result = (text: string): LogsFetchResult => ({
    text,
    containers: NEON_LOG_CONTAINERS,
    activeContainer: container,
  });

  let records: LogRecord[];
  try {
    const resp = await api.request<{ logs?: LogRecord[] }>({
      path: `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/logs/query`,
      method: "POST",
      body: {
        since: WINDOW,
        limit,
        // Newest first so a truncated page is the latest records.
        sort_order: "desc",
        ...(source ? { source } : {}),
      },
      secure: true,
      // A type-only import: `ContentType.Json` is this string, and reading the
      // enum at runtime would tie the module to the SDK's value exports.
      type: "application/json" as ContentType,
      format: "json",
    });
    records = Array.isArray(resp.data.logs) ? resp.data.logs : [];
  } catch (err) {
    const unavailable = unavailableReason(err);
    if (unavailable) return result(unavailable);
    throw err;
  }

  if (records.length === 0) return result(`No log records in the last ${WINDOW}.\n`);
  const lines = records
    .slice()
    .reverse()
    .map((r) => {
      const severity = (r.severity_text ?? "").toUpperCase();
      const origin = r.service_name || r.source || "";
      return [r.timestamp ?? "", severity, origin ? `[${origin}]` : "", r.message ?? ""]
        .filter(Boolean)
        .join("  ");
    });
  return result(lines.join("\n") + "\n");
}

/**
 * The API answers 404 with a `reason` when a branch has no logs to serve;
 * that is a state to explain in the tab rather than an error. Branch logs are
 * also a Private Beta, so an organization without access gets the same note.
 */
function unavailableReason(err: unknown): string | null {
  const response = prop(err, "response");
  const status = prop(response, "status");
  if (status !== 403 && status !== 404) return null;
  const reason = prop(prop(response, "data"), "reason");
  if (reason === "telemetry_not_enabled") {
    return "This branch is not collecting telemetry, so it has no logs to show.\n";
  }
  return "Branch logs are not available for this branch. Neon's logs API is in Private Beta.\n";
}

function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}
