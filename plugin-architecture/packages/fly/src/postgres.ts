/**
 * Fly.io Managed Postgres (MPG) through the Machines API `/v1/postgres`
 * routes. Listing returns `PostgresClusterSummary` rows; the single-cluster
 * GET adds sizing, storage, and connection endpoints. Every response wraps
 * its payload in `{ data }`.
 *
 * Clusters live on the organization's private network: the endpoints are
 * 6PN hostnames, reachable from the org's Machines or over WireGuard, not
 * from the public internet. That is why the plugin exposes the hosts as
 * outputs rather than wiring a SQL tab that could never connect.
 */

import type {
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  SectionNode,
} from "@infrawrench/plugin-base";
import { joinSubtitle } from "@infrawrench/plugin-base";
import { formatRegion } from "./regions.js";

export interface FlyPostgresEndpoint {
  host?: string;
  port?: number;
}

export interface FlyPostgresCluster {
  id: string;
  name?: string;
  status?: string;
  plan?: string;
  region?: string;
  pg_major_version?: string;
  cpu_kind?: string;
  cpus?: number;
  memory_mb?: number;
  disk_size_gb?: number;
  replicas?: number;
  postgis_enabled?: boolean;
  storage_used_bytes?: number | null;
  storage_provisioned_bytes?: number | null;
  attached_apps?: Array<{ name?: string }>;
  organization?: { name?: string; slug?: string };
  endpoints?: {
    primary?: { direct?: FlyPostgresEndpoint; pooler?: FlyPostgresEndpoint };
  };
  created_at?: string;
  deleted_at?: string;
}

export interface FlyPostgresBackup {
  id?: string;
  type?: string;
  status?: string;
  size_bytes?: number;
  started_at?: string;
  finished_at?: string;
}

/** Plans accepted by `POST /v1/postgres` (`createPostgresClusterRequest.plan`). */
export const MPG_PLANS: Array<{ id: string; label: string }> = [
  { id: "basic", label: "Basic" },
  { id: "starter", label: "Starter" },
  { id: "launch", label: "Launch" },
  { id: "scale", label: "Scale" },
  { id: "Performance", label: "Performance" },
];

export function postgresStatusDot(status: string): ResourceStatus {
  switch (status) {
    case "ready":
      return "healthy";
    case "creating":
    case "initializing":
      return "provisioning";
    case "deleting":
      return "degraded";
    case "failed":
    case "deleted":
      return "error";
    default:
      return "info";
  }
}

export function mapPostgresCluster(c: FlyPostgresCluster, accountId: string): ResourceInstance {
  const direct = c.endpoints?.primary?.direct;
  const pooler = c.endpoints?.primary?.pooler;
  const created = c.created_at ?? new Date().toISOString();
  const fields: Record<string, string | number | boolean> = {
    name: c.name ?? c.id,
    status: c.status ?? "creating",
    plan: c.plan ?? "",
    region: c.region ?? "",
    attachedApps: (c.attached_apps ?? [])
      .map((a) => a.name ?? "")
      .filter(Boolean)
      .join(", "),
  };
  const optional: Record<string, string | number | boolean | null | undefined> = {
    pgMajorVersion: c.pg_major_version,
    cpuKind: c.cpu_kind,
    cpus: c.cpus,
    memoryMb: c.memory_mb,
    diskSizeGb: c.disk_size_gb,
    replicas: c.replicas,
    postgisEnabled: c.postgis_enabled,
    storageUsedBytes: c.storage_used_bytes,
    storageProvisionedBytes: c.storage_provisioned_bytes,
    directHost: direct?.host,
    directPort: direct?.port,
    poolerHost: pooler?.host,
    poolerPort: pooler?.port,
    organization: c.organization?.slug,
    createdAt: c.created_at,
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v != null && v !== "") fields[k] = v;
  }
  return {
    id: `${accountId}:postgres-cluster:${c.id}`,
    pluginId: "fly",
    resourceTypeId: "postgres-cluster",
    accountId,
    displayName: c.name || c.id,
    fields,
    resolvedOutputs: {
      clusterId: c.id,
      ...(direct?.host ? { host: direct.host } : {}),
      ...(direct?.port != null ? { port: String(direct.port) } : {}),
      ...(pooler?.host ? { poolerHost: pooler.host } : {}),
      ...(pooler?.port != null ? { poolerPort: String(pooler.port) } : {}),
    },
    secretStates: [],
    externalId: c.id,
    createdAt: created,
    updatedAt: created,
  };
}

function formatBytes(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || raw === "" || raw == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Detail view. `enrichDetail` stashes the cluster's databases, users, and
 * backups as JSON under `__databases__` / `__users__` / `__backups__`; the
 * tables render only when those are present.
 */
export function renderPostgresClusterDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const status = String(f["status"] ?? "unknown");
  const endpoint = (host: unknown, port: unknown): string =>
    host ? `${String(host)}${port != null && port !== "" ? `:${String(port)}` : ""}` : "—";

  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Cluster",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Cluster ID", value: String(resource.externalId ?? ""), copyable: true },
            { key: "Status", value: status },
            { key: "Plan", value: String(f["plan"] || "—") },
            { key: "Region", value: formatRegion(String(f["region"] ?? "")) || "—" },
            { key: "Postgres", value: String(f["pgMajorVersion"] ?? "—") },
            {
              key: "Compute",
              value:
                f["cpus"] != null
                  ? `${String(f["cpus"])} ${String(f["cpuKind"] ?? "")} vCPU, ${String(f["memoryMb"] ?? "?")} MB`
                  : "—",
            },
            { key: "Replicas", value: String(f["replicas"] ?? "—") },
            { key: "PostGIS", value: f["postgisEnabled"] === true ? "Enabled" : "Disabled" },
            { key: "Attached Apps", value: String(f["attachedApps"] || "—") },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Storage",
      children: [
        {
          kind: "key-value-list",
          items: [
            {
              key: "Disk",
              value: f["diskSizeGb"] != null ? `${String(f["diskSizeGb"])} GB` : "—",
            },
            { key: "Used", value: formatBytes(f["storageUsedBytes"]) },
            { key: "Provisioned", value: formatBytes(f["storageProvisionedBytes"]) },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Connection (private network)",
      children: [
        {
          kind: "key-value-list",
          items: [
            {
              key: "Direct",
              value: endpoint(f["directHost"], f["directPort"]),
              copyable: Boolean(f["directHost"]),
            },
            {
              key: "Pooler (PgBouncer)",
              value: endpoint(f["poolerHost"], f["poolerPort"]),
              copyable: Boolean(f["poolerHost"]),
            },
          ],
        },
      ],
    },
  ];

  const databases = parseJsonArray<{ name?: string }>(f["__databases__"]);
  if (databases.length > 0) {
    sections.push({
      kind: "section",
      title: "Databases",
      children: [
        {
          kind: "table",
          columns: [{ key: "name", label: "Name" }],
          rows: databases.map((d) => ({ cells: { name: d.name ?? "" } })),
        },
      ],
    });
  }

  const users = parseJsonArray<{ username?: string; role?: string }>(f["__users__"]);
  if (users.length > 0) {
    sections.push({
      kind: "section",
      title: "Users",
      children: [
        {
          kind: "table",
          columns: [
            { key: "username", label: "Username" },
            { key: "role", label: "Role" },
          ],
          rows: users.map((u) => ({ cells: { username: u.username ?? "", role: u.role ?? "" } })),
        },
      ],
    });
  }

  const backups = parseJsonArray<FlyPostgresBackup>(f["__backups__"]);
  if (backups.length > 0) {
    sections.push({
      kind: "section",
      title: "Backups",
      children: [
        {
          kind: "table",
          columns: [
            { key: "id", label: "Backup" },
            { key: "type", label: "Type" },
            { key: "status", label: "Status" },
            { key: "size", label: "Size" },
            { key: "started", label: "Started" },
            { key: "finished", label: "Finished" },
          ],
          rows: backups.map((b) => ({
            cells: {
              id: b.id ?? "",
              type: b.type ?? "",
              status: b.status ?? "",
              size: formatBytes(b.size_bytes),
              started: b.started_at ?? "",
              finished: b.finished_at ?? "",
            },
          })),
        },
      ],
    });
  }

  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Managed Postgres", f["plan"]),
    status: { kind: "status-dot", status: postgresStatusDot(status) },
    sections,
    headerActions: [
      ...(status === "ready"
        ? [
            {
              kind: "action" as const,
              label: "Back Up Now",
              action: {
                type: "plugin-action" as const,
                actionId: "backup",
                successMessage: "Full backup started.",
              },
            },
          ]
        : []),
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ],
  };
}
