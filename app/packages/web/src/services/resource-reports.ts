/**
 * Resource reports: CRUD, the picker options, and running a report over the
 * synced inventory with per-resource cost.
 *
 * Shared by the HTTP routes (api/routes/resource-reports.ts) and anything
 * else that runs a report (the CLI goes through the routes). The CRUD half
 * mirrors services/cost-reports.ts: soft delete, the creator as implicit
 * owner for sharing, filed in the cost-report folder tree.
 *
 * ## How a run reads
 *
 * Resources live in Postgres (`resources`, one row per synced resource, the
 * provider's fields as `fields_json`); spend lives in ClickHouse, keyed by
 * the provider's resource id. A run is two or three steps so an org with tens
 * of thousands of resources never ships every `fields_json` anywhere:
 *
 * 1. **Select.** Every filter Postgres can answer is a WHERE clause: provider,
 *    account, type, region and status (read from the fields with the same
 *    keys `client-core` names), and the name. When nothing else is asked for
 *    and the sort is a column Postgres can order (name, account, region,
 *    status, provider id), the page is `ORDER BY … LIMIT/OFFSET` plus a
 *    `count(*)` and that is the whole run.
 * 2. **Scan** (only when needed). Tag conditions, the created date and sorting
 *    by a type label, a metadata field, a tag, a virtual tag or a cost column
 *    need values Postgres cannot compare well, so the matching rows are read
 *    lean (ids, names and only the JSON keys the run needs, extracted in SQL),
 *    filtered and sorted in memory, capped at `RESOURCE_REPORT_LIMITS.maxScan`.
 * 3. **Fill the page.** Only the page's rows load their fields, and cost and
 *    virtual tag columns are one ClickHouse read each, narrowed to the page's
 *    provider ids.
 *
 * Cost and virtual tag values come from `cost_daily` through the readers that
 * build `costDailyOrgCondition`, so a caller's cost visibility scope applies to
 * them like any other cost figure; callers without `costs:read` get the
 * columns empty with a reason, never somebody else's numbers.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  RESOURCE_CREATED_FIELD_KEYS,
  RESOURCE_REGION_FIELD_KEYS,
  RESOURCE_REPORT_LIMITS,
  RESOURCE_STATUS_FIELD_KEYS,
  RESOURCE_TAG_FIELD_KEYS,
  compareResourceReportCost,
  compareResourceReportText,
  dominantValues,
  effectiveResourceReportSort,
  extractRecordTags,
  parseResourceReportColumn,
  primaryResourceReportCurrency,
  resolveCostDateRange,
  resourceCreatedFromFields,
  resourceFieldText,
  resourceReportColumnLabel,
  resourceReportCostWindows,
  resourceReportTagFilterMatches,
  resourceReportUsesCostData,
  resourceReportVirtualTagKeys,
  buildResourceReportCsv,
  type CostReportFolder,
  type ObjectAccessLevel,
  type ResourceReport,
  type ResourceReportColumn,
  type ResourceReportConfig,
  type ResourceReportCostInfo,
  type ResourceReportCostWindow,
  type ResourceReportFieldOption,
  type ResourceReportInput,
  type ResourceReportMoney,
  type ResourceReportOptions,
  type ResourceReportRow,
  type ResourceReportRowsResult,
  type ResourceReportSort,
  type ResourceReportTagFilter,
} from "@infrawrench/client-core";
import {
  getCostDimensionValues,
  getResourceCostWindows,
  getResourceVirtualTagValues,
} from "@infrawrench/server-core/clickhouse/cost-readers";
import { isClickHouseConfigured } from "@infrawrench/server-core/clickhouse/client";
import { VirtualTagUnresolvedError } from "@infrawrench/server-core/clickhouse/virtual-tag-sql";
import { getOrgTagKeySettings } from "@infrawrench/server-core/cost/tag-key-settings";
import { db } from "../db/client";
import { accounts, resourceReports, resources } from "../db/schema";
import { loadPlugins } from "../plugins/loader";
import {
  deleteObjectSharing,
  filterVisibleObjects,
  ObjectNotVisibleError,
  requireObjectAccess,
} from "./object-sharing";
import {
  assertCanFileIntoCostReportFolder,
  listVisibleCostReportFolders,
} from "./cost-report-folders";
import { orderTagKeysForPicker } from "./tag-keys";

/** A run the caller asked for cannot be answered: a 400 with this message. */
export class ResourceReportError extends Error {
  override readonly name = "ResourceReportError";
}

type ReportRow = typeof resourceReports.$inferSelect;

/* ------------------------------------------------------------------ *
 * CRUD
 * ------------------------------------------------------------------ */

function toResourceReport(row: ReportRow): ResourceReport {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config: row.config as ResourceReportConfig,
    folderId: row.folderId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The org's reports the caller's sharing lets them open, alphabetically. */
export async function listResourceReports(organizationId: string): Promise<ResourceReport[]> {
  const rows = await db
    .select()
    .from(resourceReports)
    .where(
      and(eq(resourceReports.organizationId, organizationId), isNull(resourceReports.deletedAt)),
    )
    .orderBy(asc(resourceReports.name));
  const visible = await filterVisibleObjects(
    organizationId,
    "resource_report",
    rows,
    (r) => r.id,
    (r) => ({ createdByUserId: r.createdByUserId, folderId: r.folderId }),
  );
  return visible.map(toResourceReport);
}

async function loadReportRow(
  organizationId: string,
  reportId: string,
  needed: ObjectAccessLevel | "delete" = "viewer",
): Promise<ReportRow | null> {
  const [row] = await db
    .select()
    .from(resourceReports)
    .where(
      and(
        eq(resourceReports.id, reportId),
        eq(resourceReports.organizationId, organizationId),
        isNull(resourceReports.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  try {
    await requireObjectAccess(
      organizationId,
      "resource_report",
      row.id,
      { createdByUserId: row.createdByUserId, folderId: row.folderId },
      needed,
    );
  } catch (e) {
    // Below viewer reads as "no such report", exactly like a deleted one.
    if (e instanceof ObjectNotVisibleError) return null;
    throw e;
  }
  return row;
}

export async function getResourceReport(
  organizationId: string,
  reportId: string,
): Promise<ResourceReport | null> {
  const row = await loadReportRow(organizationId, reportId);
  return row ? toResourceReport(row) : null;
}

export async function createResourceReport(
  organizationId: string,
  input: ResourceReportInput,
  createdByUserId: string | null,
): Promise<ResourceReport> {
  if (input.folderId) await assertCanFileIntoCostReportFolder(organizationId, input.folderId);
  const [created] = await db
    .insert(resourceReports)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      config: input.config,
      folderId: input.folderId ?? null,
      createdByUserId,
    })
    .returning();
  return toResourceReport(created!);
}

/** Replace name, description, config and folder (the cost report's full-replace rule). */
export async function updateResourceReport(
  organizationId: string,
  reportId: string,
  input: ResourceReportInput,
): Promise<ResourceReport | null> {
  const current = await loadReportRow(organizationId, reportId, "editor");
  if (!current) return null;
  if (input.folderId && input.folderId !== current.folderId) {
    await assertCanFileIntoCostReportFolder(organizationId, input.folderId);
  }
  const [updated] = await db
    .update(resourceReports)
    .set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      config: input.config,
      folderId: input.folderId ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resourceReports.id, reportId),
        eq(resourceReports.organizationId, organizationId),
        isNull(resourceReports.deletedAt),
      ),
    )
    .returning();
  return updated ? toResourceReport(updated) : null;
}

export async function softDeleteResourceReport(
  organizationId: string,
  reportId: string,
): Promise<boolean> {
  if (!(await loadReportRow(organizationId, reportId, "delete"))) return false;
  const now = new Date();
  const [deleted] = await db
    .update(resourceReports)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(resourceReports.id, reportId),
        eq(resourceReports.organizationId, organizationId),
        isNull(resourceReports.deletedAt),
      ),
    )
    .returning({ id: resourceReports.id });
  if (!deleted) return false;
  await deleteObjectSharing(organizationId, "resource_report", reportId);
  return true;
}

/** The report folders the caller can see (the tree cost reports use). */
export async function listResourceReportFolders(
  organizationId: string,
): Promise<CostReportFolder[]> {
  return listVisibleCostReportFolders(organizationId);
}

/* ------------------------------------------------------------------ *
 * SQL over the stored record
 * ------------------------------------------------------------------ */

/** `fields_json ->> key`, the key bound as a parameter. */
function fieldText(key: string): SQL<string | null> {
  return sql<string | null>`(${resources.fieldsJson} ->> ${key})`;
}

/** The region expression: the first non-empty of the region keys, as client-core reads it. */
export function regionExpr(): SQL<string | null> {
  const parts = RESOURCE_REGION_FIELD_KEYS.map((k) => sql`NULLIF(TRIM(${fieldText(k)}), '')`);
  return sql<string | null>`COALESCE(${sql.join(parts, sql`, `)})`;
}

/** The status expression: the first short string of the status keys (`resourceStatusFromFields`). */
export function statusExpr(): SQL<string | null> {
  const parts = RESOURCE_STATUS_FIELD_KEYS.map(
    (k) =>
      sql`CASE WHEN jsonb_typeof(${resources.fieldsJson} -> ${k}) = 'string' AND length(TRIM(${fieldText(k)})) BETWEEN 1 AND 40 THEN TRIM(${fieldText(k)}) END`,
  );
  return sql<string | null>`COALESCE(${sql.join(parts, sql`, `)})`;
}

/** The column when it holds a JSON object, `{}` otherwise: `jsonb_each` throws on anything else. */
function objectOrEmpty(column: typeof resources.fieldsJson | typeof resources.outputsJson): SQL {
  return sql`(CASE WHEN jsonb_typeof(${column}) = 'object' THEN ${column} ELSE '{}'::jsonb END)`;
}

/** The tag-carrying keys of outputs then fields (fields win), as one small object. */
function tagSubsetExpr(): SQL<Record<string, unknown> | null> {
  const keys = sql.join(
    RESOURCE_TAG_FIELD_KEYS.map((k) => sql`${k}`),
    sql`, `,
  );
  return sql<Record<
    string,
    unknown
  > | null>`(SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(${objectOrEmpty(resources.outputsJson)} || ${objectOrEmpty(resources.fieldsJson)}) AS e WHERE lower(e.key) IN (${keys}))`;
}

/** Only the created keys of the fields, as one small object. */
function createdSubsetExpr(): SQL<Record<string, unknown>> {
  const pairs = RESOURCE_CREATED_FIELD_KEYS.map(
    (k) => sql`${k}::text, ${resources.fieldsJson} -> ${k}`,
  );
  return sql<
    Record<string, unknown>
  >`jsonb_strip_nulls(jsonb_build_object(${sql.join(pairs, sql`, `)}))`;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The WHERE clause for every filter Postgres answers. */
function baseConditions(organizationId: string, config: ResourceReportConfig): SQL[] {
  const f = config.filters;
  const conds: SQL[] = [
    eq(resources.organizationId, organizationId),
    isNull(resources.deletedAt),
    isNull(accounts.deletedAt),
  ];
  if (f.pluginIds.length > 0) conds.push(inArray(resources.pluginId, f.pluginIds));
  if (f.accountIds.length > 0) conds.push(inArray(resources.accountId, f.accountIds));
  if (f.resourceTypes.length > 0) {
    const pairs = f.resourceTypes.map(
      (t) =>
        sql`(${resources.pluginId} = ${t.pluginId} AND ${resources.resourceTypeId} = ${t.resourceTypeId})`,
    );
    conds.push(sql`(${sql.join(pairs, sql` OR `)})`);
  }
  if (f.regions.length > 0) {
    conds.push(
      sql`${regionExpr()} IN (${sql.join(
        f.regions.map((r) => sql`${r}`),
        sql`, `,
      )})`,
    );
  }
  if (f.statuses.length > 0) {
    const lowered = f.statuses.map((s) => sql`${s.toLowerCase()}`);
    conds.push(sql`lower(${statusExpr()}) IN (${sql.join(lowered, sql`, `)})`);
  }
  const name = f.nameContains?.trim();
  if (name) conds.push(ilike(resources.displayName, `%${escapeLike(name)}%`));
  return conds;
}

/* ------------------------------------------------------------------ *
 * Plugin metadata
 * ------------------------------------------------------------------ */

interface TypeMeta {
  label: string;
  fields: Array<{ key: string; label: string }>;
}

interface PluginMeta {
  label: string;
  types: Map<string, TypeMeta>;
}

async function pluginMetadata(): Promise<Map<string, PluginMeta>> {
  const out = new Map<string, PluginMeta>();
  for (const { plugin } of await loadPlugins()) {
    out.set(plugin.manifest.id, {
      label: plugin.manifest.displayName,
      types: new Map(
        plugin.resourceTypes.map((rt) => [
          rt.id,
          {
            label: rt.displayName,
            fields: (rt.fields ?? []).map((f) => ({ key: f.key, label: f.label })),
          },
        ]),
      ),
    });
  }
  return out;
}

function isTagKey(key: string): boolean {
  return (RESOURCE_TAG_FIELD_KEYS as readonly string[]).includes(key.toLowerCase());
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/** Newest resources sampled for field and tag keys (the tag-keys bound). */
const KEY_SAMPLE_LIMIT = 2000;
const OPTION_VALUE_LIMIT = 500;

/** Everything the editor's pickers offer, from the org's own synced data. */
export async function getResourceReportOptions(
  organizationId: string,
  opts: { types?: ResourceReportConfig["filters"]["resourceTypes"]; includeCosts: boolean },
): Promise<ResourceReportOptions> {
  const meta = await pluginMetadata();
  const live = and(
    eq(resources.organizationId, organizationId),
    isNull(resources.deletedAt),
    isNull(accounts.deletedAt),
  )!;

  const [counts, regionRows, statusRows] = await Promise.all([
    db
      .select({
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        accountName: accounts.displayName,
        count: sql<number>`count(*)::int`,
      })
      .from(resources)
      .innerJoin(accounts, eq(accounts.id, resources.accountId))
      .where(live)
      .groupBy(
        resources.pluginId,
        resources.resourceTypeId,
        resources.accountId,
        accounts.displayName,
      ),
    db
      .select({ value: regionExpr(), count: sql<number>`count(*)::int` })
      .from(resources)
      .innerJoin(accounts, eq(accounts.id, resources.accountId))
      .where(and(live, sql`${regionExpr()} IS NOT NULL`))
      // By position: the select-list expression binds its JSON keys as
      // parameters, and a second copy with different parameter numbers is
      // not one Postgres can prove equal to it.
      .groupBy(sql`1`)
      .orderBy(desc(sql`count(*)`))
      .limit(OPTION_VALUE_LIMIT),
    db
      .select({ value: statusExpr(), count: sql<number>`count(*)::int` })
      .from(resources)
      .innerJoin(accounts, eq(accounts.id, resources.accountId))
      .where(and(live, sql`${statusExpr()} IS NOT NULL`))
      .groupBy(sql`1`)
      .orderBy(desc(sql`count(*)`))
      .limit(OPTION_VALUE_LIMIT),
  ]);

  const providers = new Map<string, number>();
  const accountCounts = new Map<string, { label: string; pluginId: string; count: number }>();
  const typeCounts = new Map<string, { pluginId: string; resourceTypeId: string; count: number }>();
  for (const r of counts) {
    providers.set(r.pluginId, (providers.get(r.pluginId) ?? 0) + r.count);
    const acct = accountCounts.get(r.accountId) ?? {
      label: r.accountName,
      pluginId: r.pluginId,
      count: 0,
    };
    acct.count += r.count;
    accountCounts.set(r.accountId, acct);
    const typeKey = `${r.pluginId}\u0000${r.resourceTypeId}`;
    const t = typeCounts.get(typeKey) ?? {
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      count: 0,
    };
    t.count += r.count;
    typeCounts.set(typeKey, t);
  }

  // Fields: what the selected types declare, plus what their synced rows carry.
  const selectedTypes =
    opts.types && opts.types.length > 0
      ? opts.types
      : [...typeCounts.values()].map((t) => ({
          pluginId: t.pluginId,
          resourceTypeId: t.resourceTypeId,
        }));
  const declared = new Map<string, string>();
  for (const t of selectedTypes) {
    for (const f of meta.get(t.pluginId)?.types.get(t.resourceTypeId)?.fields ?? []) {
      if (!isTagKey(f.key) && !declared.has(f.key)) declared.set(f.key, f.label);
    }
  }
  const typeCondition =
    opts.types && opts.types.length > 0
      ? sql`(${sql.join(
          opts.types.map(
            (t) =>
              sql`(${resources.pluginId} = ${t.pluginId} AND ${resources.resourceTypeId} = ${t.resourceTypeId})`,
          ),
          sql` OR `,
        )})`
      : sql`TRUE`;
  // Keys the newest synced rows of those types actually carry. One sample
  // feeds both the field keys and the tag keys.
  const [observedResult, tagRows, settings] = await Promise.all([
    db.execute(sql`
      SELECT k AS key, count(*)::int AS count
      FROM (
        SELECT ${resources.fieldsJson} AS fields
        FROM ${resources}
        INNER JOIN ${accounts} ON ${accounts.id} = ${resources.accountId}
        WHERE ${live} AND ${typeCondition}
          AND jsonb_typeof(${resources.fieldsJson}) = 'object'
        ORDER BY ${resources.updatedAt} DESC
        LIMIT ${KEY_SAMPLE_LIMIT}
      ) AS sample, jsonb_object_keys(sample.fields) AS k
      GROUP BY k
      ORDER BY count(*) DESC
      LIMIT ${OPTION_VALUE_LIMIT}
    `),
    db
      .select({ tags: tagSubsetExpr() })
      .from(resources)
      .innerJoin(accounts, eq(accounts.id, resources.accountId))
      .where(and(live, typeCondition))
      .orderBy(desc(resources.updatedAt))
      .limit(KEY_SAMPLE_LIMIT),
    getOrgTagKeySettings(organizationId),
  ]);
  const observed = new Map(
    Array.from(observedResult as Iterable<Record<string, unknown>>, (r) => [
      String(r["key"]),
      Number(r["count"]),
    ]),
  );
  const fields: ResourceReportFieldOption[] = [];
  for (const [key, label] of declared) {
    fields.push({ key, label, count: observed.get(key) ?? 0, declared: true });
  }
  for (const [key, count] of observed) {
    if (declared.has(key) || isTagKey(key)) continue;
    fields.push({ key, label: key, count, declared: false });
  }
  fields.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const tagKeySet = new Set<string>();
  for (const r of tagRows) {
    for (const key of Object.keys(extractRecordTags(r.tags ?? {}) ?? {})) tagKeySet.add(key);
  }
  const { tagKeys, preferredTagKeys } = orderTagKeysForPicker([...tagKeySet].sort(), settings);

  let virtualTagKeys: string[] = [];
  const costAvailable = opts.includeCosts && isClickHouseConfigured();
  if (opts.includeCosts) {
    const { listVirtualTags } = await import("@infrawrench/server-core/cost/virtual-tags");
    virtualTagKeys = (await listVirtualTags(organizationId)).map((t) => t.key);
  }

  const counted = (rows: Array<{ value: string | null; count: number }>) =>
    rows
      .filter((r): r is { value: string; count: number } => typeof r.value === "string")
      .map((r) => ({ value: r.value, label: r.value, count: r.count }));

  return {
    providers: [...providers.entries()]
      .map(([value, count]) => ({ value, label: meta.get(value)?.label ?? value, count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    accounts: [...accountCounts.entries()]
      .map(([value, a]) => ({ value, label: a.label, pluginId: a.pluginId, count: a.count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    resourceTypes: [...typeCounts.values()]
      .map((t) => ({
        ...t,
        label: meta.get(t.pluginId)?.types.get(t.resourceTypeId)?.label ?? t.resourceTypeId,
      }))
      .sort(
        (a, b) =>
          (meta.get(a.pluginId)?.label ?? a.pluginId).localeCompare(
            meta.get(b.pluginId)?.label ?? b.pluginId,
          ) || a.label.localeCompare(b.label),
      ),
    regions: counted(regionRows),
    statuses: counted(statusRows),
    fields,
    tagKeys,
    preferredTagKeys,
    virtualTagKeys,
    costAvailable,
  };
}

/** Values a tag condition can pick from: provider tags from inventory, virtual tags from spend. */
export async function getResourceReportTagValues(
  organizationId: string,
  source: ResourceReportTagFilter["source"],
  key: string,
  includeCosts: boolean,
): Promise<string[]> {
  if (source === "virtual_tag") {
    if (!includeCosts) return [];
    const values = await getCostDimensionValues(organizationId, "virtual_tag", { tagKey: key });
    return values.filter((v) => v !== "").slice(0, OPTION_VALUE_LIMIT);
  }
  const rows = await db
    .select({ tags: tagSubsetExpr() })
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
        isNull(accounts.deletedAt),
      ),
    )
    .orderBy(desc(resources.updatedAt))
    .limit(RESOURCE_REPORT_LIMITS.maxScan);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const tags = extractRecordTags(r.tags ?? {});
    if (tags && Object.hasOwn(tags, key)) {
      const v = tags[key]!;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, OPTION_VALUE_LIMIT)
    .map(([v]) => v);
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

export interface RunOptions {
  offset?: number | undefined;
  limit?: number | undefined;
  /** Overrides the config's sort for this run only. */
  sort?: ResourceReportSort | undefined;
  /** The caller holds `costs:read`. Without it cost and virtual tag cells are empty. */
  includeCosts: boolean;
  today?: Date | undefined;
  /** CSV export: one page of up to `maxCsvRows` instead of `maxPageSize`. */
  exportAll?: boolean | undefined;
}

/** Light row: what the select and scan carry for every matching resource. */
interface LightRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  accountName: string;
  displayName: string;
  externalId: string | null;
  createdAt: Date;
  region: string | null;
  status: string | null;
  tags?: Record<string, unknown> | null;
  created?: Record<string, unknown> | null;
  sortField?: unknown;
}

/** Ids per Postgres bind list or ClickHouse IN list when filling a page. */
const FILL_CHUNK = 1000;

const SQL_SORTABLE = new Set([
  "core:name",
  "core:account",
  "core:region",
  "core:status",
  "core:external_id",
]);

function resourceKey(accountId: string, externalId: string): string {
  return `${accountId}\u0000${externalId}`;
}

function createdIso(row: LightRow, fields?: Record<string, unknown> | null): string {
  return resourceCreatedFromFields(fields ?? row.created) ?? row.createdAt.toISOString();
}

function tagValue(tags: Record<string, string> | null, key: string): string | null {
  return tags && Object.hasOwn(tags, key) ? tags[key]! : null;
}

function costUnavailableReason(includeCosts: boolean): string | null {
  if (!includeCosts) return "Cost columns need the costs:read permission.";
  if (!isClickHouseConfigured()) return "No cost data is configured on this server.";
  return null;
}

/** Group window rows by resource into one cell per window. */
function costCells(
  rows: Awaited<ReturnType<typeof getResourceCostWindows>>,
  windowCount: number,
): Map<string, ResourceReportMoney[][]> {
  const out = new Map<string, ResourceReportMoney[][]>();
  for (const r of rows) {
    const key = resourceKey(r.accountId, r.resourceId);
    const cells = out.get(key) ?? Array.from({ length: windowCount }, () => []);
    r.amounts.forEach((amount, i) => {
      if (amount !== 0) cells[i]!.push({ currency: r.currency, amount });
    });
    out.set(key, cells);
  }
  for (const cells of out.values()) for (const c of cells) c.sort((a, b) => b.amount - a.amount);
  return out;
}

/**
 * Run a config: the page of rows, the total, and what the cost columns mean.
 * Throws {@link ResourceReportError} for a run that cannot be answered.
 */
export async function runResourceReport(
  organizationId: string,
  config: ResourceReportConfig,
  opts: RunOptions,
): Promise<ResourceReportRowsResult> {
  const today = opts.today ?? new Date();
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(
    opts.exportAll ? RESOURCE_REPORT_LIMITS.maxCsvRows : RESOURCE_REPORT_LIMITS.maxPageSize,
    Math.max(1, opts.limit ?? config.pageSize),
  );
  const sort = opts.sort ?? effectiveResourceReportSort(config);
  const sortCol = parseResourceReportColumn(sort.column);
  if (!sortCol) throw new ResourceReportError(`"${sort.column}" is not a column to sort by.`);

  const usesCost = resourceReportUsesCostData(config) || sortCol.kind === "cost";
  const costReason = usesCost ? costUnavailableReason(opts.includeCosts) : null;
  const costOk = usesCost && costReason === null;
  const vtagFilters = config.filters.tags.filter((t) => t.source === "virtual_tag");
  if (vtagFilters.length > 0 && !costOk) {
    throw new ResourceReportError(
      `This report filters on virtual tags, which are read from cost data. ${costReason ?? ""}`.trim(),
    );
  }

  const range = resolveCostDateRange(config.costRange, today);
  const allWindows = resourceReportCostWindows(range, today);
  const meta = await pluginMetadata();
  const typeLabel = (r: { pluginId: string; resourceTypeId: string }) =>
    meta.get(r.pluginId)?.types.get(r.resourceTypeId)?.label ?? r.resourceTypeId;
  const pluginLabel = (pluginId: string) => meta.get(pluginId)?.label ?? pluginId;

  const conds = baseConditions(organizationId, config);
  const tagFilters = config.filters.tags.filter((t) => t.source === "tag");
  const createdFilter = config.filters.createdFrom !== null || config.filters.createdTo !== null;
  const needsScan =
    tagFilters.length > 0 ||
    vtagFilters.length > 0 ||
    createdFilter ||
    !SQL_SORTABLE.has(sort.column);

  const lightSelection = {
    id: resources.id,
    pluginId: resources.pluginId,
    resourceTypeId: resources.resourceTypeId,
    accountId: resources.accountId,
    accountName: accounts.displayName,
    displayName: resources.displayName,
    externalId: resources.externalId,
    createdAt: resources.createdAt,
    region: regionExpr(),
    status: statusExpr(),
  };

  let page: LightRow[];
  let total: number;
  let truncated = false;
  /** Cost cells already loaded for every candidate, when the sort needed them. */
  let scannedCosts: Map<string, ResourceReportMoney[][]> | null = null;
  let scannedCostWindows: ResourceReportCostWindow[] = [];

  if (!needsScan) {
    const sortExpr: SQL =
      sort.column === "core:account"
        ? sql`lower(${accounts.displayName})`
        : sort.column === "core:region"
          ? regionExpr()
          : sort.column === "core:status"
            ? sql`lower(${statusExpr()})`
            : sort.column === "core:external_id"
              ? sql`${resources.externalId}`
              : sql`lower(${resources.displayName})`;
    const dir = sort.direction === "asc" ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
    const [rows, [countRow]] = await Promise.all([
      db
        .select(lightSelection)
        .from(resources)
        .innerJoin(accounts, eq(accounts.id, resources.accountId))
        .where(and(...conds))
        .orderBy(sql`${sortExpr} ${dir}`, sql`lower(${resources.displayName}) ASC`, resources.id)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(resources)
        .innerJoin(accounts, eq(accounts.id, resources.accountId))
        .where(and(...conds)),
    ]);
    page = rows;
    total = countRow?.count ?? 0;
  } else {
    const needTags = tagFilters.length > 0 || sortCol.kind === "tag";
    const needCreated = createdFilter || sort.column === "core:created";
    const scanned: LightRow[] = await db
      .select({
        ...lightSelection,
        ...(needTags ? { tags: tagSubsetExpr() } : {}),
        ...(needCreated ? { created: createdSubsetExpr() } : {}),
        ...(sortCol.kind === "field"
          ? { sortField: sql<unknown>`${resources.fieldsJson} -> ${sortCol.key}` }
          : {}),
      })
      .from(resources)
      .innerJoin(accounts, eq(accounts.id, resources.accountId))
      .where(and(...conds))
      .orderBy(resources.id)
      .limit(RESOURCE_REPORT_LIMITS.maxScan + 1);
    if (scanned.length > RESOURCE_REPORT_LIMITS.maxScan) {
      truncated = true;
      scanned.length = RESOURCE_REPORT_LIMITS.maxScan;
    }

    // In-memory filters.
    let matched = scanned;
    if (tagFilters.length > 0) {
      matched = matched.filter((row) => {
        const tags = extractRecordTags(row.tags ?? {});
        return tagFilters.every((f) => resourceReportTagFilterMatches(f, tagValue(tags, f.key)));
      });
    }
    if (createdFilter) {
      const { createdFrom, createdTo } = config.filters;
      matched = matched.filter((row) => {
        const day = createdIso(row).slice(0, 10);
        return (!createdFrom || day >= createdFrom) && (!createdTo || day <= createdTo);
      });
    }
    const accountScope =
      config.filters.accountIds.length > 0 ? config.filters.accountIds : undefined;
    const vtagByKey = new Map<string, Map<string, string>>();
    const loadVtag = async (key: string) => {
      if (vtagByKey.has(key)) return vtagByKey.get(key)!;
      const rows = await getResourceVirtualTagValues(organizationId, key, range.from, range.to, {
        accountIds: accountScope,
      });
      const values = dominantValues(
        rows.map((r) => ({
          key: resourceKey(r.accountId, r.resourceId),
          value: r.value,
          amount: r.amount,
        })),
      );
      vtagByKey.set(key, values);
      return values;
    };
    for (const f of vtagFilters) {
      const values = await loadVtag(f.key);
      matched = matched.filter((row) =>
        resourceReportTagFilterMatches(
          f,
          row.externalId ? (values.get(resourceKey(row.accountId, row.externalId)) ?? null) : null,
        ),
      );
    }

    // In-memory sort.
    let sortText: ((row: LightRow) => string | null) | null = null;
    switch (sortCol.kind) {
      case "core":
        sortText = (row) => {
          switch (sortCol.key) {
            case "name":
              return row.displayName;
            case "type":
              return typeLabel(row);
            case "provider":
              return pluginLabel(row.pluginId);
            case "account":
              return row.accountName;
            case "region":
              return row.region;
            case "status":
              return row.status;
            case "created":
              return createdIso(row);
            default:
              return row.externalId;
          }
        };
        break;
      case "field":
        sortText = (row) => resourceFieldText(row.sortField);
        break;
      case "tag":
        sortText = (row) => tagValue(extractRecordTags(row.tags ?? {}), sortCol.key);
        break;
      case "vtag": {
        if (!costOk) {
          sortText = () => null;
          break;
        }
        const values = await loadVtag(sortCol.key);
        sortText = (row) =>
          row.externalId ? (values.get(resourceKey(row.accountId, row.externalId)) ?? null) : null;
        break;
      }
      case "cost":
        break;
    }
    const tieBreak = (a: LightRow, b: LightRow) =>
      compareResourceReportText(a.displayName, b.displayName, "asc") || a.id.localeCompare(b.id);
    if (sortText) {
      const keyed = matched.map((row) => ({ row, text: sortText!(row) }));
      keyed.sort(
        (a, b) =>
          compareResourceReportText(a.text, b.text, sort.direction) || tieBreak(a.row, b.row),
      );
      matched = keyed.map((k) => k.row);
    } else if (costOk) {
      // Sort by a cost column: every candidate's spend in that window, one read.
      const windowRange = allWindows.find((w) => w.window === sortCol.key)!;
      scannedCostWindows = [windowRange.window];
      scannedCosts = costCells(
        await getResourceCostWindows(organizationId, [windowRange], {
          costBasis: config.costBasis,
          accountIds: accountScope,
        }),
        1,
      );
      const cellOf = (row: LightRow) =>
        row.externalId
          ? (scannedCosts!.get(resourceKey(row.accountId, row.externalId))?.[0] ?? [])
          : [];
      const currency = primaryResourceReportCurrency(matched.map(cellOf)) ?? "USD";
      matched = [...matched].sort(
        (a, b) =>
          compareResourceReportCost(cellOf(a), cellOf(b), currency, sort.direction) ||
          tieBreak(a, b),
      );
    } else {
      matched = [...matched].sort(tieBreak);
    }
    total = matched.length;
    page = matched.slice(offset, offset + limit);
  }

  // Fill the page.
  const columns: ResourceReportColumn[] = config.columns.map((id) => {
    const parsed = parseResourceReportColumn(id)!;
    let fieldLabel: string | null = null;
    if (parsed.kind === "field") {
      for (const p of meta.values()) {
        for (const t of p.types.values()) {
          const f = t.fields.find((x) => x.key === parsed.key);
          if (f) {
            fieldLabel = f.label;
            break;
          }
        }
        if (fieldLabel) break;
      }
    }
    return {
      id,
      kind: parsed.kind,
      key: parsed.key,
      label: resourceReportColumnLabel(id, fieldLabel),
    };
  });

  const ids = page.map((r) => r.id);
  const needRecord = columns.some(
    (c) => c.kind === "field" || c.kind === "tag" || (c.kind === "core" && c.key === "created"),
  );
  const records = new Map<
    string,
    { fields: Record<string, unknown>; outputs: Record<string, unknown> }
  >();
  // Chunked: a CSV export fills one "page" of up to 50,000 rows, and a bind
  // list that long would pass Postgres's 65,535-parameter ceiling.
  for (let i = 0; needRecord && i < ids.length; i += FILL_CHUNK) {
    const rows = await db
      .select({ id: resources.id, fields: resources.fieldsJson, outputs: resources.outputsJson })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          inArray(resources.id, ids.slice(i, i + FILL_CHUNK)),
        ),
      );
    for (const r of rows) records.set(r.id, { fields: r.fields, outputs: r.outputs });
  }

  const pageExternal = page.filter((r) => r.externalId);
  const pageResourceIds = [...new Set(pageExternal.map((r) => r.externalId!))];
  const pageAccountIds = [...new Set(pageExternal.map((r) => r.accountId))];
  // A page narrows the cost reads to its own provider ids; an export-sized
  // page reads its accounts whole instead of shipping a 50,000-element IN list.
  const narrowToPage = pageResourceIds.length <= FILL_CHUNK;
  const pageResourceFilter = narrowToPage ? pageResourceIds : undefined;

  const costColumns = columns.filter((c) => c.kind === "cost");
  const pageWindows = allWindows.filter((w) => costColumns.some((c) => c.key === w.window));
  let pageCosts = new Map<string, ResourceReportMoney[][]>();
  let pageCostWindows: ResourceReportCostWindow[] = [];
  if (costOk && pageWindows.length > 0) {
    const sameAsScan =
      scannedCosts !== null &&
      pageWindows.length === 1 &&
      pageWindows[0]!.window === scannedCostWindows[0];
    if (sameAsScan) {
      pageCosts = scannedCosts!;
      pageCostWindows = scannedCostWindows;
    } else if (pageResourceIds.length > 0) {
      pageCosts = costCells(
        await getResourceCostWindows(organizationId, pageWindows, {
          costBasis: config.costBasis,
          accountIds: pageAccountIds,
          resourceIds: pageResourceFilter,
        }),
        pageWindows.length,
      );
      pageCostWindows = pageWindows.map((w) => w.window);
    }
  }

  const vtagColumns = columns.filter((c) => c.kind === "vtag");
  const pageVtags = new Map<string, Map<string, string>>();
  if (costOk) {
    for (const c of vtagColumns) {
      if (pageResourceIds.length === 0) {
        pageVtags.set(c.key, new Map());
        continue;
      }
      const rows = await getResourceVirtualTagValues(organizationId, c.key, range.from, range.to, {
        accountIds: pageAccountIds,
        resourceIds: pageResourceFilter,
      });
      pageVtags.set(
        c.key,
        dominantValues(
          rows.map((r) => ({
            key: resourceKey(r.accountId, r.resourceId),
            value: r.value,
            amount: r.amount,
          })),
        ),
      );
    }
  }

  const outRows: ResourceReportRow[] = page.map((row) => {
    const record = records.get(row.id);
    const tags = record ? extractRecordTags({ ...record.outputs, ...record.fields }) : null;
    const key = row.externalId ? resourceKey(row.accountId, row.externalId) : null;
    const values: Record<string, string | null> = {};
    const costs: Record<string, ResourceReportMoney[]> = {};
    for (const c of columns) {
      switch (c.kind) {
        case "core":
          values[c.id] =
            c.key === "name"
              ? row.displayName
              : c.key === "type"
                ? typeLabel(row)
                : c.key === "provider"
                  ? pluginLabel(row.pluginId)
                  : c.key === "account"
                    ? row.accountName
                    : c.key === "region"
                      ? row.region
                      : c.key === "status"
                        ? row.status
                        : c.key === "created"
                          ? createdIso(row, record?.fields)
                          : row.externalId;
          break;
        case "field":
          values[c.id] = resourceFieldText(record?.fields[c.key]);
          break;
        case "tag":
          values[c.id] = tagValue(tags, c.key);
          break;
        case "vtag":
          values[c.id] = key ? (pageVtags.get(c.key)?.get(key) ?? null) : null;
          break;
        case "cost": {
          const idx = pageCostWindows.indexOf(c.key as ResourceReportCostWindow);
          costs[c.id] = key && idx >= 0 ? (pageCosts.get(key)?.[idx] ?? []) : [];
          break;
        }
      }
    }
    return {
      id: row.id,
      accountId: row.accountId,
      pluginId: row.pluginId,
      resourceTypeId: row.resourceTypeId,
      values,
      costs,
    };
  });

  const cost: ResourceReportCostInfo | null = usesCost
    ? {
        available: costOk,
        reason: costReason,
        basis: config.costBasis,
        windows: allWindows,
      }
    : null;

  return { columns, rows: outRows, total, offset, limit, truncated, sort, cost };
}

/**
 * The whole report as CSV, up to `maxCsvRows`, in one run (so a report that
 * needs the in-memory scan scans once, not once per page). The last line says
 * when the file was cut, so a truncated export is never mistaken for a
 * complete one.
 */
export async function resourceReportCsv(
  organizationId: string,
  config: ResourceReportConfig,
  opts: { includeCosts: boolean; today?: Date | undefined },
): Promise<string> {
  const result = await runResourceReport(organizationId, config, {
    offset: 0,
    limit: RESOURCE_REPORT_LIMITS.maxCsvRows,
    includeCosts: opts.includeCosts,
    today: opts.today,
    exportAll: true,
  });
  let csv = buildResourceReportCsv(result.columns, result.rows);
  if (result.rows.length < result.total || result.truncated) {
    csv += `# Truncated: ${result.rows.length} of ${result.truncated ? "more than " : ""}${
      result.total
    } resources\r\n`;
  }
  return csv;
}

export { VirtualTagUnresolvedError };
