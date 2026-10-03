/**
 * Cluster administration surfaces beyond indices and nodes: snapshots inside
 * each repository, Snapshot Management (SM) policies, Index State Management
 * (ISM) policies, aliases, data streams, unassigned shards, and Query
 * Insights top queries.
 *
 * Endpoints are from the OpenSearch documentation (docs.opensearch.org,
 * checked 2026-10). The `_plugins/...` and `_insights` endpoints belong to
 * OpenSearch plugins that Elasticsearch and some managed offerings lack, so
 * every read here is best-effort: a refused call renders as "not available"
 * rather than failing the page.
 */
import type { ActionNode, SectionNode, TableNode, TableRow } from "@infrawrench/plugin-base";

export interface SnapshotInfo {
  snapshot: string;
  state?: string;
  indices?: string[];
  start_time_in_millis?: number;
  end_time_in_millis?: number;
  duration_in_millis?: number;
  shards?: { total?: number; failed?: number; successful?: number };
}

export interface SmPolicyEntry {
  _id?: string;
  sm_policy?: {
    name?: string;
    description?: string;
    enabled?: boolean;
    creation?: { schedule?: { cron?: { expression?: string; timezone?: string } } };
    deletion?: { condition?: { max_age?: string; max_count?: number; min_count?: number } };
    snapshot_config?: { repository?: string; indices?: string };
  };
}

export interface IsmPolicyEntry {
  _id?: string;
  policy?: {
    policy_id?: string;
    description?: string;
    default_state?: string;
    last_updated_time?: number;
    states?: Array<{ name?: string }>;
    ism_template?: Array<{ index_patterns?: string[] }> | { index_patterns?: string[] } | null;
  };
}

export interface CatAlias {
  alias: string;
  index: string;
  filter?: string;
  "routing.index"?: string;
  "routing.search"?: string;
  is_write_index?: string;
}

export interface DataStreamInfo {
  name: string;
  generation?: number;
  status?: string;
  template?: string;
  timestamp_field?: { name?: string };
  indices?: Array<{ index_name?: string }>;
}

export interface CatShard {
  index: string;
  shard: string;
  prirep: string;
  state: string;
  "unassigned.reason"?: string;
  node?: string;
}

export interface TopQuery {
  id?: string;
  timestamp?: number;
  indices?: string[];
  source?: string | Record<string, unknown>;
  search_type?: string;
  total_shards?: number;
  group_by?: string;
  measurements?: Record<string, { number?: number; count?: number }>;
}

/** A row action whose id is `verb:arg`, the convention invokeAction parses. */
function rowAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; danger?: boolean; destructive?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.danger ? { variant: "danger" as const } : {}),
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function muted(content: string): SectionNode["children"][number] {
  return { kind: "text", variant: "muted", content };
}

function isoMinute(ms: number | undefined): string {
  if (!ms) return "-";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function seconds(ms: number | undefined): string {
  if (!ms) return "-";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** Newest first, capped: repositories can hold thousands of snapshots. */
export const SNAPSHOTS_PER_REPO = 25;

export function buildSnapshotsSection(
  repo: string,
  snapshots: SnapshotInfo[] | undefined,
): SectionNode {
  if (!snapshots) {
    return {
      kind: "section",
      title: `Snapshots in ${repo}`,
      children: [muted("Snapshots could not be read from this repository.")],
    };
  }
  const sorted = [...snapshots]
    .sort((a, b) => (b.start_time_in_millis ?? 0) - (a.start_time_in_millis ?? 0))
    .slice(0, SNAPSHOTS_PER_REPO);
  const rows: TableRow[] = sorted.map((s) => {
    const id = `${repo}/${s.snapshot}`;
    return {
      cells: {
        snapshot: s.snapshot,
        state: s.state ?? "-",
        started: isoMinute(s.start_time_in_millis),
        duration: seconds(s.duration_in_millis),
        indices: String(s.indices?.length ?? 0),
        shards: s.shards
          ? `${s.shards.successful ?? 0}/${s.shards.total ?? 0}${s.shards.failed ? ` (${s.shards.failed} failed)` : ""}`
          : "-",
        restore: rowAction("Restore", `restore-snapshot:${id}`, {
          confirm: `Restore every index in "${s.snapshot}"? Indices are restored under a "restored-" prefix so existing indices are not touched.`,
          success: `Started restoring "${s.snapshot}".`,
        }),
        del: rowAction("Delete", `delete-snapshot:${id}`, {
          confirm: `Delete snapshot "${s.snapshot}" from "${repo}"? Its data is removed from the repository.`,
          success: `Deleted snapshot "${s.snapshot}".`,
          danger: true,
          destructive: true,
        }),
      },
    };
  });
  const title =
    snapshots.length > sorted.length
      ? `Snapshots in ${repo} (newest ${sorted.length} of ${snapshots.length})`
      : `Snapshots in ${repo} (${snapshots.length})`;
  return {
    kind: "section",
    title,
    children:
      rows.length === 0
        ? [muted("No snapshots yet.")]
        : [
            {
              kind: "table",
              columns: [
                { key: "snapshot", label: "Snapshot" },
                { key: "state", label: "State" },
                { key: "started", label: "Started (UTC)" },
                { key: "duration", label: "Duration" },
                { key: "indices", label: "Indices" },
                { key: "shards", label: "Shards" },
                { key: "restore", label: "", width: "narrow" },
                { key: "del", label: "", width: "narrow" },
              ],
              rows,
              emphasizeFirstColumn: true,
            },
          ],
  };
}

export function buildSmPoliciesSection(policies: SmPolicyEntry[] | undefined): SectionNode {
  if (!policies) {
    return {
      kind: "section",
      title: "Snapshot policies",
      children: [
        muted(
          "Snapshot Management is not available on this cluster (it needs the OpenSearch Index Management plugin).",
        ),
      ],
    };
  }
  const rows: TableRow[] = policies.map((p) => {
    const sm = p.sm_policy ?? {};
    const name = sm.name ?? p._id ?? "";
    const cron = sm.creation?.schedule?.cron;
    const cond = sm.deletion?.condition;
    const retention = [
      cond?.max_age ? `max age ${cond.max_age}` : "",
      cond?.max_count ? `max ${cond.max_count}` : "",
      cond?.min_count ? `min ${cond.min_count}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      cells: {
        name,
        repository: sm.snapshot_config?.repository ?? "-",
        schedule: cron?.expression ? `${cron.expression} (${cron.timezone ?? "UTC"})` : "-",
        retention: retention || "Keep all",
        enabled: sm.enabled ? "Enabled" : "Stopped",
        toggle: sm.enabled
          ? rowAction("Stop", `stop-sm-policy:${name}`, { success: `Stopped "${name}".` })
          : rowAction("Start", `start-sm-policy:${name}`, { success: `Started "${name}".` }),
        del: rowAction("Delete", `delete-sm-policy:${name}`, {
          confirm: `Delete snapshot policy "${name}"? Snapshots it already took are kept.`,
          success: `Deleted "${name}".`,
          danger: true,
        }),
      },
    };
  });
  return {
    kind: "section",
    title: `Snapshot policies (${rows.length})`,
    children:
      rows.length === 0
        ? [muted("No snapshot policies. Create one to take snapshots on a schedule.")]
        : [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Policy" },
                { key: "repository", label: "Repository" },
                { key: "schedule", label: "Schedule" },
                { key: "retention", label: "Retention" },
                { key: "enabled", label: "Status" },
                { key: "toggle", label: "", width: "narrow" },
                { key: "del", label: "", width: "narrow" },
              ],
              rows,
              emphasizeFirstColumn: true,
            },
          ],
  };
}

function ismPatterns(policy: IsmPolicyEntry["policy"]): string {
  const template = policy?.ism_template;
  if (!template) return "";
  const list = Array.isArray(template) ? template : [template];
  return list.flatMap((t) => t.index_patterns ?? []).join(", ");
}

export function buildIsmPoliciesSection(policies: IsmPolicyEntry[] | undefined): SectionNode {
  if (!policies) {
    return {
      kind: "section",
      title: "Index State Management policies",
      children: [
        muted(
          "Index State Management is not available on this cluster (it needs the OpenSearch Index Management plugin).",
        ),
      ],
    };
  }
  const rows: TableRow[] = policies.map((p) => {
    const id = p.policy?.policy_id ?? p._id ?? "";
    return {
      cells: {
        policy: id,
        description: p.policy?.description || "-",
        states: (p.policy?.states ?? []).map((s) => s.name ?? "").join(" > ") || "-",
        patterns: ismPatterns(p.policy) || "-",
        updated: isoMinute(p.policy?.last_updated_time),
        del: rowAction("Delete", `delete-ism-policy:${id}`, {
          confirm: `Delete ISM policy "${id}"? Indices it manages keep their data but stop transitioning.`,
          success: `Deleted "${id}".`,
          danger: true,
        }),
      },
    };
  });
  return {
    kind: "section",
    title: `Index State Management policies (${rows.length})`,
    children:
      rows.length === 0
        ? [muted("No ISM policies.")]
        : [
            {
              kind: "table",
              columns: [
                { key: "policy", label: "Policy" },
                { key: "description", label: "Description" },
                { key: "states", label: "States" },
                { key: "patterns", label: "Auto-applies to" },
                { key: "updated", label: "Updated (UTC)" },
                { key: "del", label: "", width: "narrow" },
              ],
              rows,
              emphasizeFirstColumn: true,
            },
          ],
  };
}

export function buildAliasesSection(aliases: CatAlias[] | undefined): SectionNode {
  if (!aliases) {
    return { kind: "section", title: "Aliases", children: [muted("Aliases could not be read.")] };
  }
  const visible = aliases.filter((a) => !a.alias.startsWith("."));
  const rows: TableRow[] = visible.map((a) => ({
    cells: {
      alias: a.alias,
      index: a.index,
      write: a.is_write_index === "true" ? "Yes" : "-",
      filter: a.filter && a.filter !== "-" ? "Yes" : "-",
      routing:
        [a["routing.index"], a["routing.search"]].filter((r) => r && r !== "-").join(" / ") || "-",
      remove: rowAction("Remove", `remove-alias:${a.index}/${a.alias}`, {
        confirm: `Remove alias "${a.alias}" from "${a.index}"? Clients using the alias stop reaching this index.`,
        success: `Removed "${a.alias}" from "${a.index}".`,
        danger: true,
      }),
    },
  }));
  return {
    kind: "section",
    title: `Aliases (${rows.length})`,
    children:
      rows.length === 0
        ? [muted("No aliases.")]
        : [
            {
              kind: "table",
              columns: [
                { key: "alias", label: "Alias" },
                { key: "index", label: "Index" },
                { key: "write", label: "Write index" },
                { key: "filter", label: "Filtered" },
                { key: "routing", label: "Routing" },
                { key: "remove", label: "", width: "narrow" },
              ],
              rows,
              emphasizeFirstColumn: true,
            },
          ],
  };
}

export function buildDataStreamsSection(streams: DataStreamInfo[] | undefined): SectionNode {
  if (!streams) {
    return {
      kind: "section",
      title: "Data streams",
      children: [muted("Data streams could not be read.")],
    };
  }
  const rows: TableRow[] = streams.map((d) => ({
    cells: {
      name: d.name,
      status: d.status ?? "-",
      generation: String(d.generation ?? "-"),
      backing: String(d.indices?.length ?? 0),
      template: d.template ?? "-",
      rollover: rowAction("Roll over", `rollover:${d.name}`, {
        confirm: `Roll over "${d.name}"? New writes go to a fresh backing index.`,
        success: `Rolled over "${d.name}".`,
      }),
      del: rowAction("Delete", `delete-data-stream:${d.name}`, {
        confirm: `Delete data stream "${d.name}" and all of its backing indices? This cannot be undone.`,
        success: `Deleted "${d.name}".`,
        danger: true,
        destructive: true,
      }),
    },
  }));
  return {
    kind: "section",
    title: `Data streams (${rows.length})`,
    children:
      rows.length === 0
        ? [muted("No data streams.")]
        : [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Data stream" },
                { key: "status", label: "Health" },
                { key: "generation", label: "Generation" },
                { key: "backing", label: "Backing indices" },
                { key: "template", label: "Template" },
                { key: "rollover", label: "", width: "narrow" },
                { key: "del", label: "", width: "narrow" },
              ],
              rows,
              emphasizeFirstColumn: true,
            },
          ],
  };
}

export function buildUnassignedShardsSection(shards: CatShard[]): SectionNode | null {
  const unassigned = shards.filter((s) => s.state === "UNASSIGNED");
  if (unassigned.length === 0) return null;
  const table: TableNode = {
    kind: "table",
    columns: [
      { key: "index", label: "Index" },
      { key: "shard", label: "Shard" },
      { key: "role", label: "Role" },
      { key: "reason", label: "Reason" },
    ],
    rows: unassigned.slice(0, 50).map((s) => ({
      cells: {
        index: s.index,
        shard: s.shard,
        role: s.prirep === "p" ? "primary" : "replica",
        reason: s["unassigned.reason"] ?? "-",
      },
    })),
    emphasizeFirstColumn: true,
  };
  return {
    kind: "section",
    title: `Unassigned shards (${unassigned.length})`,
    children: [
      {
        kind: "text",
        variant: "muted",
        content:
          "Replicas stay unassigned when there are fewer data nodes than copies; primaries mean data is unavailable. Retry allocation once the cause is fixed.",
      },
      table,
    ],
  };
}

function querySource(source: TopQuery["source"]): string {
  const text = typeof source === "string" ? source : JSON.stringify(source ?? {});
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

export function buildTopQueriesSection(queries: TopQuery[] | undefined): SectionNode {
  if (!queries) {
    return {
      kind: "section",
      title: "Top queries by latency",
      children: [
        muted(
          "Query Insights is not available on this cluster. It ships with OpenSearch 2.12 and later as the query-insights plugin.",
        ),
      ],
    };
  }
  const rows: TableRow[] = queries.slice(0, 20).map((q) => ({
    cells: {
      latency:
        q.measurements?.["latency"]?.number != null
          ? `${q.measurements["latency"].number} ms`
          : "-",
      cpu:
        q.measurements?.["cpu"]?.number != null
          ? `${Math.round(q.measurements["cpu"].number / 1e6)} ms`
          : "-",
      memory:
        q.measurements?.["memory"]?.number != null
          ? `${Math.round(q.measurements["memory"].number / 1024)} KB`
          : "-",
      indices: (q.indices ?? []).join(", ") || "-",
      shards: String(q.total_shards ?? "-"),
      when: isoMinute(q.timestamp),
      query: querySource(q.source),
    },
  }));
  return {
    kind: "section",
    title: "Top queries by latency",
    children:
      rows.length === 0
        ? [
            muted(
              "No queries recorded in the current window. Top N monitoring may be disabled for latency (search.insights.top_queries.latency.enabled).",
            ),
          ]
        : [
            {
              kind: "table",
              columns: [
                { key: "latency", label: "Latency" },
                { key: "cpu", label: "CPU" },
                { key: "memory", label: "Memory" },
                { key: "indices", label: "Indices" },
                { key: "shards", label: "Shards" },
                { key: "when", label: "At (UTC)" },
                { key: "query", label: "Query", width: "wide" },
              ],
              rows,
            },
          ],
  };
}
