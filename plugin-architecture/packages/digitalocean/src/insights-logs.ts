/**
 * Logs tabs backed by DO's newer observability endpoints:
 *
 * - Droplets read DigitalOcean Insights (`POST /v2/insights/query/{region}/logs/search`,
 *   public preview since October 2026). Records only exist for Droplets
 *   running the Observability agent, in an Insights region, and the token
 *   needs the `insights:read` scope.
 *   https://docs.digitalocean.com/reference/api/reference/insights/
 * - DOKS clusters read the cluster's lifecycle status messages
 *   (`GET /v2/kubernetes/clusters/{id}/status_messages`).
 */
import type { LogsFetchResult, ResourceInstance } from "@infrawrench/plugin-base";

export interface DoLogsContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
}

/** Dropdown entries for the Droplet Logs tab. */
export const DROPLET_LOG_VIEWS = ["all", "errors"] as const;

/** How far back the Droplet Logs tab looks. Insights caps a query at 7 days. */
const DROPLET_LOG_LOOKBACK = "24h";

/** OpenTelemetry severity number where ERROR starts (ERROR=17..20, FATAL=21..24). */
const OTEL_SEVERITY_ERROR = 17;

interface InsightsLogRecord {
  timestamp?: string;
  severity_text?: string;
  severity_number?: number;
  body?: string;
  service_name?: string;
}

/** Insights clamps `pagination.limit` to 1000. */
function clampLimit(tail: number): number {
  return Math.min(Math.max(Math.floor(tail), 1), 1000);
}

/**
 * The Insights logs request body for one Droplet: records whose resource URN
 * is the Droplet's (`do:droplet:{id}`) or whose `do.droplet.id` resource
 * attribute matches, newest first. `errors` narrows to severity ERROR and up.
 */
export function buildDropletLogSearch(
  dropletId: string,
  view: (typeof DROPLET_LOG_VIEWS)[number],
  tail: number,
): Record<string, unknown> {
  const byDroplet = {
    or: {
      expressions: [
        {
          condition: {
            field: { name: "resource.urn" },
            operator: "FILTER_OPERATOR_EQ",
            value: { string_value: `do:droplet:${dropletId}` },
          },
        },
        {
          condition: {
            field: { name: "ResourceAttributes['do.droplet.id']" },
            operator: "FILTER_OPERATOR_EQ",
            value: { string_value: dropletId },
          },
        },
      ],
    },
  };
  const filter =
    view === "errors"
      ? {
          and: {
            expressions: [
              byDroplet,
              {
                condition: {
                  field: { name: "severity_number" },
                  operator: "FILTER_OPERATOR_GTE",
                  value: { number_value: OTEL_SEVERITY_ERROR },
                },
              },
            ],
          },
        }
      : byDroplet;
  return {
    time_range: { from: { relative: DROPLET_LOG_LOOKBACK }, to: { relative: "now" } },
    filter,
    order_by: [{ field: { name: "timestamp" }, direction: "SORT_DIRECTION_DESC" }],
    pagination: { limit: clampLimit(tail) },
  };
}

function formatRecord(r: InsightsLogRecord): string {
  return [r.timestamp ?? "?", r.severity_text || "-", r.service_name || "-", r.body ?? ""]
    .join("  ")
    .trimEnd();
}

export async function fetchDropletInsightsLogs(
  ctx: DoLogsContext,
  droplet: ResourceInstance,
  params: { tailLines?: number; container?: string },
): Promise<LogsFetchResult> {
  const containers = [...DROPLET_LOG_VIEWS];
  const view = params.container === "errors" ? "errors" : "all";
  const dropletId = droplet.externalId ?? droplet.id.split(":").pop() ?? "";
  const region = String(droplet.fields["region"] ?? "");
  if (!dropletId || !region) {
    return {
      text: "This Droplet has no region on record, so its Insights logs can't be queried.\n",
      containers,
      activeContainer: view,
    };
  }
  const tail = params.tailLines ?? 200;
  let records: InsightsLogRecord[];
  try {
    const resp = await ctx.fetch<{ data?: InsightsLogRecord[] }>(
      `/insights/query/${encodeURIComponent(region)}/logs/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDropletLogSearch(dropletId, view, tail)),
      },
    );
    records = resp.data ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = /\b403\b/.test(message)
      ? "The API token needs the `insights:read` scope; mint one at https://cloud.digitalocean.com/account/api/tokens."
      : `DigitalOcean Insights (public preview) may not be available in ${region} yet.`;
    return {
      text: `Couldn't load Insights logs: ${message}\n${hint}\n`,
      containers,
      activeContainer: view,
    };
  }
  // Newest first from the API; the Logs tab reads top to bottom, oldest first.
  const lines = records.slice(0, tail).reverse().map(formatRecord);
  const text =
    lines.length > 0
      ? `${lines.join("\n")}\n`
      : view === "errors"
        ? `No error logs from this Droplet in the last ${DROPLET_LOG_LOOKBACK}.\n`
        : `No Insights logs from this Droplet in the last ${DROPLET_LOG_LOOKBACK}. Logs are collected by the DigitalOcean Observability agent; install it on the Droplet to see them here.\n`;
  return { text, containers, activeContainer: view };
}

export async function fetchDoksStatusMessages(
  ctx: DoLogsContext,
  clusterId: string,
  params: { tailLines?: number },
): Promise<LogsFetchResult> {
  const containers = ["status"];
  let messages: Array<{ message?: string; timestamp?: string }>;
  try {
    const resp = await ctx.fetch<{
      messages?: Array<{ message?: string; timestamp?: string }> | null;
    }>(`/kubernetes/clusters/${encodeURIComponent(clusterId)}/status_messages`);
    messages = resp.messages ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: `Couldn't load status messages: ${message}\n`,
      containers,
      activeContainer: "status",
    };
  }
  const tail = params.tailLines ?? 200;
  const lines = [...messages]
    .sort((a, b) => Date.parse(a.timestamp ?? "") - Date.parse(b.timestamp ?? ""))
    .slice(-tail)
    .map((m) => `${m.timestamp ?? "?"}  ${m.message ?? ""}`.trimEnd());
  const text =
    lines.length > 0
      ? `${lines.join("\n")}\n`
      : "No status messages. DigitalOcean posts one here when something affects the cluster's lifecycle, such as delayed provisioning.\n";
  return { text, containers, activeContainer: "status" };
}
