/**
 * Basin Catalog (formerly R2 Data Catalog) and Basin SQL (formerly R2 SQL).
 *
 * Verified 2026-10 against developers.cloudflare.com/api/resources/r2_data_catalog,
 * developers.cloudflare.com/basin-sql/query-data/, wrangler's `basin` commands
 * and the `cloudflare` SDK 6.4 typings. A catalog is an R2 bucket with the
 * Iceberg REST catalog switched on, so it is keyed by bucket name:
 *   - GET  /accounts/{aid}/r2-catalog                       list warehouses
 *   - GET  /accounts/{aid}/r2-catalog/{bucket}              one warehouse
 *   - POST /accounts/{aid}/r2-catalog/{bucket}/enable|disable
 *   - GET/POST .../{bucket}/maintenance-configs             compaction + snapshot expiration
 *   - POST .../{bucket}/credential                          service token for maintenance jobs
 *   - GET  .../{bucket}/namespaces, .../namespaces/{ns}/tables
 *   - GET/POST .../namespaces/{ns}/tables/{table}/maintenance-configs
 * Permissions: Workers R2 Data Catalog Read/Write.
 *
 * Basin SQL is a separate host: POST
 * https://api.sql.cloudflarestorage.com/api/v1/accounts/{aid}/basin-sql/query/{bucket}
 * with `{ warehouse, query }` and a Bearer token holding Workers R2 SQL Read,
 * Workers R2 Data Catalog Read and Workers R2 Storage Read. Read-only; each
 * query is billed on bytes scanned (10 MB minimum).
 */
import type { ResourceInstance, SqlTableMeta } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";

const SCOPE = "Account · Workers R2 Data Catalog:Read";
export const BASIN_SQL_HOST = "https://api.sql.cloudflarestorage.com";
const CATALOG_HOST = "https://catalog.cloudflarestorage.com";

const TARGET_SIZES = ["64", "128", "256", "512"] as const;
type TargetSize = (typeof TARGET_SIZES)[number];

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function stamp(): string {
  return new Date().toISOString();
}

/** Iceberg multi-level namespaces travel as one path segment joined by U+001F. */
function namespacePath(namespace: string): string {
  return encodeURIComponent(namespace.split(".").join("\u001f"));
}

// ── Maintenance config ─────────────────────────────────────────────────────

export interface MaintenanceFields {
  compaction: string;
  targetSizeMb: string;
  snapshotExpiration: string;
  maxSnapshotAge: string;
  minSnapshotsToKeep: number | string;
}

function maintenanceFields(config: unknown): MaintenanceFields {
  const c = rec(config);
  const compaction = rec(c["compaction"]);
  const snap = rec(c["snapshot_expiration"]);
  return {
    compaction: str(compaction["state"]) || "disabled",
    targetSizeMb: str(compaction["target_size_mb"]),
    snapshotExpiration: str(snap["state"]) || "disabled",
    maxSnapshotAge: str(snap["max_snapshot_age"]),
    minSnapshotsToKeep:
      snap["min_snapshots_to_keep"] != null ? Number(snap["min_snapshots_to_keep"]) : "",
  };
}

/**
 * Normalise the max-snapshot-age the forms accept. Cloudflare takes a
 * duration string ("30d", "12h"); a bare number is read as days.
 */
export function normaliseSnapshotAge(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return `${v}d`;
  if (/^\d+[dhm]$/.test(v)) return v;
  throw new Error('Max snapshot age must be a duration like "30d", "12h" or a number of days.');
}

/** Build a maintenance-configs body from form fields; only keys the user set are sent. */
export function maintenanceBody(fields: Record<string, string>): {
  compaction?: { state: "enabled" | "disabled"; target_size_mb?: TargetSize };
  snapshot_expiration?: {
    state: "enabled" | "disabled";
    max_snapshot_age?: string;
    min_snapshots_to_keep?: number;
  };
} {
  const body: ReturnType<typeof maintenanceBody> = {};
  const compaction = fields["compaction"];
  if (compaction === "enabled" || compaction === "disabled") {
    const size = fields["targetSizeMb"];
    body.compaction = {
      state: compaction,
      ...((TARGET_SIZES as readonly string[]).includes(size ?? "")
        ? { target_size_mb: size as TargetSize }
        : {}),
    };
  }
  const snap = fields["snapshotExpiration"];
  if (snap === "enabled" || snap === "disabled") {
    const age = normaliseSnapshotAge(fields["maxSnapshotAge"]);
    const keep = Number(fields["minSnapshotsToKeep"]);
    body.snapshot_expiration = {
      state: snap,
      ...(age ? { max_snapshot_age: age } : {}),
      ...(fields["minSnapshotsToKeep"] && Number.isFinite(keep) && keep >= 1
        ? { min_snapshots_to_keep: Math.floor(keep) }
        : {}),
    };
  }
  return body;
}

function wantsMaintenance(fields: Record<string, string>): boolean {
  return fields["compaction"] === "enabled" || fields["snapshotExpiration"] === "enabled";
}

// ── Catalogs ───────────────────────────────────────────────────────────────

export function catalogUri(warehouseName: string): string {
  // Warehouse names are `<account id>_<bucket>`; the URI swaps the first `_` for `/`.
  return `${CATALOG_HOST}/${warehouseName.replace("_", "/")}`;
}

export function mapCatalog(w: Record<string, unknown>, accountId: string): ResourceInstance {
  const bucket = str(w["bucket"]);
  const warehouseName = str(w["name"]);
  const uri = warehouseName ? catalogUri(warehouseName) : "";
  return {
    id: `${accountId}:basin-catalog:${bucket}`,
    pluginId: "cloudflare",
    resourceTypeId: "basin-catalog",
    accountId,
    displayName: bucket,
    fields: {
      bucket,
      warehouseName,
      catalogUri: uri,
      status: str(w["status"]),
      credentialStatus: str(w["credential_status"]),
      ...maintenanceFields(w["maintenance_config"]),
      maintenanceToken: "",
    },
    resolvedOutputs: { warehouseName, catalogUri: uri, bucketName: bucket },
    secretStates: [],
    externalId: bucket,
    createdAt: stamp(),
    updatedAt: stamp(),
  };
}

export async function listCatalogs(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const res = await api.cf.r2DataCatalog.list({ account_id });
      return (res.warehouses ?? []).map((w) => mapCatalog(asRecord(w), accountId));
    },
    "Basin catalogs",
    SCOPE,
  );
}

export async function getCatalog(
  api: CloudflareApi,
  bucket: string,
  accountId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const w = await api.cf.r2DataCatalog.get(bucket, { account_id });
  return mapCatalog(asRecord(w), accountId);
}

/**
 * Store the service token maintenance jobs use. Blank means the account's own
 * API token, which then needs R2 Storage and Data Catalog write access.
 */
async function setMaintenanceCredential(
  api: CloudflareApi,
  account_id: string,
  bucket: string,
  token: string | undefined,
): Promise<void> {
  await api.cf.r2DataCatalog.credentials.create(bucket, {
    account_id,
    token: (token ?? "").trim() || api.apiToken,
  });
}

/** "Create" a catalog: enable the Iceberg catalog on an R2 bucket, then apply maintenance. */
export async function enableCatalog(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const bucket = fields["bucket"] ?? "";
  if (!bucket) throw new Error("Pick the R2 bucket to enable Basin Catalog on.");
  await api.cf.r2DataCatalog.enable(bucket, { account_id });
  if (wantsMaintenance(fields)) {
    await setMaintenanceCredential(api, account_id, bucket, fields["maintenanceToken"]);
    await api.cf.r2DataCatalog.maintenanceConfigs.update(bucket, {
      account_id,
      ...maintenanceBody(fields),
    });
  }
  return getCatalog(api, bucket, accountId);
}

/**
 * Edit catalog-wide maintenance. A non-blank token replaces the stored
 * service credential; enabling maintenance with no credential on file stores
 * the account's own token so the jobs can run.
 */
export async function editCatalog(
  api: CloudflareApi,
  accountId: string,
  bucket: string,
  merged: Record<string, string>,
  changedKeys: string[],
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const token = (merged["maintenanceToken"] ?? "").trim();
  if (
    (changedKeys.includes("maintenanceToken") && token) ||
    (wantsMaintenance(merged) && merged["credentialStatus"] !== "present")
  ) {
    await setMaintenanceCredential(api, account_id, bucket, token);
  }
  const body = maintenanceBody(merged);
  if (body.compaction || body.snapshot_expiration) {
    await api.cf.r2DataCatalog.maintenanceConfigs.update(bucket, { account_id, ...body });
  }
  return getCatalog(api, bucket, accountId);
}

/** "Delete" a catalog: disable it. The bucket and its data files stay in R2. */
export async function disableCatalog(api: CloudflareApi, bucket: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.r2DataCatalog.disable(bucket, { account_id });
}

/** R2 buckets with no catalog yet, for the enable picker. */
export async function getUncatalogedBucketOptions(
  api: CloudflareApi,
): Promise<Array<{ id: string; label: string }>> {
  const account_id = await api.getAccountId();
  const res = await api.cf.r2.buckets.list({ account_id });
  let enabled = new Set<string>();
  try {
    const cats = await api.cf.r2DataCatalog.list({ account_id });
    enabled = new Set(
      (cats.warehouses ?? []).filter((w) => w.status === "active").map((w) => w.bucket),
    );
  } catch {
    /* show every bucket */
  }
  return (res.buckets ?? [])
    .map((b) => b.name ?? "")
    .filter((n) => n && !enabled.has(n))
    .map((n) => ({ id: n, label: n }));
}

/** Buckets with an active catalog, for the Basin Catalog sink picker. */
export async function getCatalogBucketOptions(
  api: CloudflareApi,
): Promise<Array<{ id: string; label: string }>> {
  const account_id = await api.getAccountId();
  const cats = await api.cf.r2DataCatalog.list({ account_id });
  return (cats.warehouses ?? [])
    .filter((w) => w.status === "active")
    .map((w) => ({ id: w.bucket, label: w.bucket }));
}

/** Every R2 bucket, for the R2 sink picker. */
export async function getBucketOptions(
  api: CloudflareApi,
): Promise<Array<{ id: string; label: string }>> {
  const account_id = await api.getAccountId();
  const res = await api.cf.r2.buckets.list({ account_id });
  return (res.buckets ?? [])
    .map((b) => b.name ?? "")
    .filter(Boolean)
    .map((n) => ({ id: n, label: n }));
}

// ── Namespaces and tables ──────────────────────────────────────────────────

export interface CatalogTableRef {
  bucket: string;
  namespace: string;
  name: string;
  tableUuid: string;
  location: string;
  metadataLocation: string;
  createdAt: string;
  updatedAt: string;
}

/** Every namespace in a catalog (top level, following `next_page_token`). */
export async function listNamespaces(api: CloudflareApi, bucket: string): Promise<string[]> {
  const account_id = await api.getAccountId();
  const out: string[] = [];
  let page_token: string | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await api.cf.r2DataCatalog.namespaces.list(bucket, {
      account_id,
      page_size: 1000,
      ...(page_token ? { page_token } : {}),
    });
    for (const ns of res.namespaces ?? []) out.push(ns.join("."));
    page_token = res.next_page_token ?? undefined;
    if (!page_token) break;
  }
  return out;
}

/** Every table in one namespace, with details (uuid, location, timestamps). */
export async function listNamespaceTables(
  api: CloudflareApi,
  bucket: string,
  namespace: string,
): Promise<CatalogTableRef[]> {
  const account_id = await api.getAccountId();
  const out: CatalogTableRef[] = [];
  let page_token: string | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await api.cf.r2DataCatalog.namespaces.tables.list(
      bucket,
      namespacePath(namespace),
      { account_id, page_size: 1000, return_details: true, ...(page_token ? { page_token } : {}) },
    );
    const details = res.details ?? [];
    if (details.length > 0) {
      for (const d of details) {
        out.push({
          bucket,
          namespace: d.identifier.namespace.join(".") || namespace,
          name: d.identifier.name,
          tableUuid: d.table_uuid,
          location: d.location ?? "",
          metadataLocation: d.metadata_location ?? "",
          createdAt: d.created_at ?? "",
          updatedAt: d.updated_at ?? "",
        });
      }
    } else {
      for (const id of res.identifiers ?? []) {
        out.push({
          bucket,
          namespace: id.namespace.join(".") || namespace,
          name: id.name,
          tableUuid: "",
          location: "",
          metadataLocation: "",
          createdAt: "",
          updatedAt: "",
        });
      }
    }
    page_token = res.next_page_token ?? undefined;
    if (!page_token) break;
  }
  return out;
}

/** Tables across every namespace of one catalog. Per-namespace failures are skipped. */
export async function listCatalogTables(
  api: CloudflareApi,
  bucket: string,
): Promise<CatalogTableRef[]> {
  const namespaces = await listNamespaces(api, bucket);
  const out: CatalogTableRef[] = [];
  for (const ns of namespaces) {
    try {
      out.push(...(await listNamespaceTables(api, bucket, ns)));
    } catch {
      /* one unreadable namespace shouldn't hide the rest */
    }
  }
  return out;
}

/** Table resource ids: `<bucket>/<namespace>/<table>` (namespace levels dot-joined). */
export function tableExternalId(t: { bucket: string; namespace: string; name: string }): string {
  return `${t.bucket}/${t.namespace}/${t.name}`;
}

export function parseTableExternalId(
  externalId: string,
): { bucket: string; namespace: string; name: string } | null {
  const first = externalId.indexOf("/");
  const last = externalId.lastIndexOf("/");
  if (first <= 0 || last <= first || last === externalId.length - 1) return null;
  return {
    bucket: externalId.slice(0, first),
    namespace: externalId.slice(first + 1, last),
    name: externalId.slice(last + 1),
  };
}

export function mapTable(
  t: CatalogTableRef,
  accountId: string,
  maintenance?: unknown,
): ResourceInstance {
  const externalId = tableExternalId(t);
  const qualified = `${t.namespace}.${t.name}`;
  return {
    id: `${accountId}:basin-table:${externalId}`,
    pluginId: "cloudflare",
    resourceTypeId: "basin-table",
    accountId,
    parentResourceId: `${accountId}:basin-catalog:${t.bucket}`,
    displayName: qualified,
    fields: {
      name: t.name,
      namespace: t.namespace,
      bucket: t.bucket,
      tableUuid: t.tableUuid,
      location: t.location,
      metadataLocation: t.metadataLocation,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      ...(maintenance !== undefined ? maintenanceFields(maintenance) : {}),
    },
    resolvedOutputs: { tableName: qualified, bucketName: t.bucket },
    secretStates: [],
    externalId,
    createdAt: t.createdAt || stamp(),
    updatedAt: t.updatedAt || stamp(),
  };
}

/** Tables across every active catalog on the account. */
export async function listTables(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const res = await api.cf.r2DataCatalog.list({ account_id });
      const out: ResourceInstance[] = [];
      for (const w of res.warehouses ?? []) {
        if (w.status !== "active") continue;
        for (const t of await listCatalogTables(api, w.bucket)) out.push(mapTable(t, accountId));
      }
      return out;
    },
    "Basin tables",
    SCOPE,
  );
}

/** One table, with its own maintenance config folded into the fields (for the Edit form). */
export async function getTable(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const ref = parseTableExternalId(externalId);
  if (!ref) throw new Error(`Cloudflare plugin: malformed Basin table id "${externalId}"`);
  const tables = await listNamespaceTables(api, ref.bucket, ref.namespace);
  const t = tables.find((x) => x.name === ref.name);
  if (!t) throw new Error(`Basin table ${ref.namespace}.${ref.name} not found`);
  let maintenance: unknown;
  try {
    const account_id = await api.getAccountId();
    const res = await api.cf.r2DataCatalog.namespaces.tables.maintenanceConfigs.get(
      ref.bucket,
      namespacePath(ref.namespace),
      ref.name,
      { account_id },
    );
    maintenance = res.maintenance_config;
  } catch {
    maintenance = undefined;
  }
  return mapTable(t, accountId, maintenance);
}

export async function editTable(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  merged: Record<string, string>,
): Promise<ResourceInstance> {
  const ref = parseTableExternalId(externalId);
  if (!ref) throw new Error(`Cloudflare plugin: malformed Basin table id "${externalId}"`);
  const account_id = await api.getAccountId();
  const body = maintenanceBody(merged);
  if (body.compaction || body.snapshot_expiration) {
    await api.cf.r2DataCatalog.namespaces.tables.maintenanceConfigs.update(
      ref.bucket,
      namespacePath(ref.namespace),
      ref.name,
      { account_id, ...body },
    );
  }
  return getTable(api, externalId, accountId);
}

// ── Basin SQL ──────────────────────────────────────────────────────────────

interface BasinSqlResponse {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: {
    schema?: Array<{ name: string; type?: string }>;
    rows?: Array<Record<string, unknown>>;
    metrics?: { r2_requests_count?: number; files_scanned?: number; bytes_scanned?: number };
  };
}

/** Run a read-only Basin SQL query against the catalog on `bucket`. */
export async function runBasinSql(
  api: CloudflareApi,
  bucket: string,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
  const account_id = await api.getAccountId();
  const start = Date.now();
  const res = await fetch(
    `${BASIN_SQL_HOST}/api/v1/accounts/${account_id}/basin-sql/query/${encodeURIComponent(bucket)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${api.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ warehouse: `${account_id}_${bucket}`, query: sql }),
    },
  );
  const text = await res.text();
  let body: BasinSqlResponse | null = null;
  try {
    body = JSON.parse(text) as BasinSqlResponse;
  } catch {
    body = null;
  }
  if (!res.ok || !body?.success) {
    const msg = (body?.errors ?? [])
      .map((e) => (e.code != null ? `${e.message ?? ""} (code ${e.code})` : (e.message ?? "")))
      .filter(Boolean)
      .join("; ");
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Basin SQL rejected the token${msg ? `: ${msg}` : ""}. It needs Workers R2 SQL Read, Workers R2 Data Catalog Read and Workers R2 Storage Read.`,
      );
    }
    throw new Error(msg || `Basin SQL returned status ${res.status}: ${text.slice(0, 200)}`);
  }
  const rows = body.result?.rows ?? [];
  // Keep the server's column order (rows are objects; the schema lists columns in order).
  const order = (body.result?.schema ?? []).map((c) => c.name);
  const ordered =
    order.length > 0
      ? rows.map((r) => {
          const o: Record<string, unknown> = {};
          for (const k of order) o[k] = r[k] ?? null;
          return o;
        })
      : rows;
  return { rows: ordered, durationMs: Date.now() - start };
}

/**
 * SQL editor metadata for a catalog: one entry per `namespace.table`. Column
 * lists aren't in the Data Catalog REST API, and reading them through Basin
 * SQL would bill a 10 MB minimum per table, so autocomplete gets table names only.
 */
export async function introspectCatalog(
  api: CloudflareApi,
  bucket: string,
): Promise<SqlTableMeta[]> {
  const tables = await listCatalogTables(api, bucket);
  return tables.map((t) => ({ name: `${t.namespace}.${t.name}`, columns: [] }));
}
