import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CredentialFieldOption,
  CreditBalance,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  SidebarItemSchema,
  SqlTableMeta,
  WarehouseLoadRequest,
  WarehouseLoadResult,
  WarehouseSetupGuide,
} from "@infrawrench/plugin-base";
import { CostSetupError, decodePromptArgs, externalIdOf } from "@infrawrench/plugin-base";
import type { SnowflakeAccount } from "./account.js";
import { parseAccount, snowsightUrl } from "./account.js";
import type { QueryResult, SnowflakeContext, StatementOptions } from "./api.js";
import { ident, isNotAuthorized, literal, num, qualified, runSql, str } from "./api.js";
import { SnowflakeAuth, parseCredential } from "./auth.js";
import type { SnowflakeRates } from "./catalog.js";
import { WAREHOUSE_SIZES, findSize, parseRates } from "./catalog.js";
import { fetchSnowflakeCostData, summarizeMonth } from "./cost-data.js";
import {
  fetchAttribution,
  fetchBalances,
  fetchMonitorQuotas,
  fetchWarehouseActivity,
  monitorTriggers,
  recommendWarehouse,
  warehousesByMonitor,
} from "./insights.js";
import {
  decodeId,
  encodeId,
  instance,
  mapDatabase,
  mapDynamicTable,
  mapPipe,
  mapResourceMonitor,
  mapRole,
  mapSchema,
  mapTask,
  mapUser,
  mapWarehouse,
} from "./mappers.js";
import {
  ACCOUNT_METRICS_WINDOW_MS,
  WAREHOUSE_METRICS_WINDOW_MS,
  accountSeries,
  databaseSeries,
  rangeOrDefault,
  warehouseSeries,
} from "./metrics.js";
import type { AccountSummary, WarehouseInsights } from "./render.js";
import { OUT, renderSnowflakeDetail, renderSnowflakeSidebar } from "./render.js";
import { TYPE } from "./resource-types.js";
import {
  listSnowflakeTargetOptions,
  loadSnowflakeRows,
  snowflakeSetupGuide,
} from "./warehouse-sink.js";

/**
 * Every ACCOUNT_USAGE read needs a running warehouse, and the poller refetches
 * pinned resources' metrics every cycle. Without a cache, pinning a warehouse
 * would keep the metadata warehouse awake (and billing) around the clock. The
 * views lag up to three hours, so half an hour of staleness costs nothing.
 * Module-level because hosts build a fresh client per call.
 */
const CACHE_TTL_MS = 30 * 60_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return value;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `snowflake-task` etc. carry `DB.SCHEMA.NAME` external ids. */
const SCHEMA_OBJECTS: Record<string, { show: string; sql: string; map: typeof mapTask }> = {
  [TYPE.task]: { show: "TASKS", sql: "TASK", map: mapTask },
  [TYPE.pipe]: { show: "PIPES", sql: "PIPE", map: (a, r) => mapPipe(a, r) },
  [TYPE.dynamicTable]: { show: "DYNAMIC TABLES", sql: "DYNAMIC TABLE", map: mapDynamicTable },
};

export class SnowflakeClient implements PluginClient {
  private readonly ctx: SnowflakeContext;
  private readonly rates: SnowflakeRates;
  private readonly cacheScope: string;
  private readonly user: string;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const account: SnowflakeAccount = parseAccount(credentials["account"] ?? "");
    const user = (credentials["user"] ?? "").trim();
    if (!user) throw new Error("Snowflake plugin: missing user");
    const credential = parseCredential(credentials["credential"] ?? "");
    const caCert = credentials["caCert"] ?? "";
    const role = (credentials["role"] ?? "").trim();
    const warehouse = (credentials["warehouse"] ?? "").trim();
    this.ctx = {
      account,
      auth: new SnowflakeAuth(credential, account.jwtAccount, user),
      ...(role ? { role } : {}),
      ...(warehouse ? { warehouse } : {}),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.rates = parseRates(credentials);
    this.cacheScope = `${account.host}|${user.toUpperCase()}|${role}|${warehouse}`;
    this.user = user;
  }

  private sql(statement: string, opts?: StatementOptions): Promise<QueryResult> {
    return runSql(this.ctx, statement, opts);
  }

  private async rows(statement: string): Promise<Record<string, unknown>[]> {
    return (await this.sql(statement)).rows;
  }

  // -------------------------------------------------------------------------
  // Listing: SHOW commands only. They are served by cloud services and never
  // resume a warehouse, which matters because the poller lists every cycle.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Warehouse sink: cost exports load into a table (see warehouse-sink.ts).
  // -------------------------------------------------------------------------

  listWarehouseTargetOptions(
    _accountId: string,
    fieldKey: string,
    target: Record<string, string>,
  ): Promise<CredentialFieldOption[]> {
    return listSnowflakeTargetOptions(this.ctx, fieldKey, target);
  }

  loadWarehouseRows(
    _accountId: string,
    request: WarehouseLoadRequest,
  ): Promise<WarehouseLoadResult> {
    return loadSnowflakeRows(this.ctx, request);
  }

  async describeWarehouseSetup(
    _accountId: string,
    target: Record<string, string>,
  ): Promise<WarehouseSetupGuide> {
    let role = this.ctx.role ?? "";
    if (!role) {
      // No role on the account: the user's default role is what runs, so ask.
      role = await this.sql("SELECT CURRENT_ROLE() AS ROLE")
        .then((r) => str(r.rows[0]?.["role"]))
        .catch(() => "");
    }
    return snowflakeSetupGuide(target, role, this.user);
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case TYPE.account:
        return [await this.accountInstance(accountId)];
      case TYPE.warehouse:
        return (await this.rows("SHOW WAREHOUSES")).map((r) => mapWarehouse(accountId, r));
      case TYPE.database:
        return (await this.rows("SHOW DATABASES")).map((r) => mapDatabase(accountId, r));
      case TYPE.schema:
        return (await this.rows("SHOW SCHEMAS IN ACCOUNT"))
          .filter((r) => str(r["name"]).toUpperCase() !== "INFORMATION_SCHEMA")
          .map((r) => mapSchema(accountId, r));
      case TYPE.resourceMonitor: {
        const [monitors, warehouses] = await Promise.all([
          this.rows("SHOW RESOURCE MONITORS"),
          this.rows("SHOW WAREHOUSES").catch(() => []),
        ]);
        const byMonitor = warehousesByMonitor(warehouses);
        return monitors.map((r) =>
          mapResourceMonitor(accountId, r, byMonitor.get(str(r["name"])) ?? []),
        );
      }
      case TYPE.user:
        // SHOW USERS needs ownership or MANAGE GRANTS; without it the list is empty.
        return (await this.optional("SHOW USERS")).map((r) => mapUser(accountId, r));
      case TYPE.role:
        return (await this.rows("SHOW ROLES")).map((r) => mapRole(accountId, r));
      default: {
        const obj = SCHEMA_OBJECTS[typeId];
        if (!obj) throw new Error(`Snowflake plugin: unknown resource type "${typeId}"`);
        return (await this.rows(`SHOW ${obj.show} IN ACCOUNT`)).map((r) => obj.map(accountId, r));
      }
    }
  }

  private async optional(statement: string): Promise<Record<string, unknown>[]> {
    try {
      return await this.rows(statement);
    } catch (err) {
      if (isNotAuthorized(err)) return [];
      throw err;
    }
  }

  private async accountInstance(accountId: string): Promise<ResourceInstance> {
    const res = await this.sql(
      `SELECT CURRENT_ACCOUNT() AS LOCATOR, CURRENT_ACCOUNT_NAME() AS NAME,
         CURRENT_ORGANIZATION_NAME() AS ORG, CURRENT_REGION() AS REGION, CURRENT_ROLE() AS ROLE,
         CURRENT_WAREHOUSE() AS WAREHOUSE`,
    );
    const r = res.rows[0] ?? {};
    const name = str(r["name"]) || this.ctx.account.display;
    return instance(
      accountId,
      TYPE.account,
      this.ctx.account.display,
      str(r["org"]) ? `${str(r["org"])}-${name}`.toLowerCase() : this.ctx.account.display,
      {
        name,
        organization: str(r["org"]),
        accountLocator: str(r["locator"]),
        region: str(r["region"]),
        currentRole: str(r["role"]),
        currentWarehouse: str(r["warehouse"]),
      },
      { accountUrl: snowsightUrl(this.ctx.account), accountLocator: str(r["locator"]) },
    );
  }

  /** One object by name, from the matching SHOW command. */
  private async showOne(typeId: string, externalId: string): Promise<Record<string, unknown>> {
    const parts = decodeId(externalId);
    const like = (name: string) => `LIKE ${literal(name)}`;
    let statement: string;
    switch (typeId) {
      case TYPE.warehouse:
        statement = `SHOW WAREHOUSES ${like(parts[0]!)}`;
        break;
      case TYPE.database:
        statement = `SHOW DATABASES ${like(parts[0]!)}`;
        break;
      case TYPE.schema:
        statement = `SHOW SCHEMAS ${like(parts[1]!)} IN DATABASE ${ident(parts[0]!)}`;
        break;
      case TYPE.resourceMonitor:
        statement = `SHOW RESOURCE MONITORS ${like(parts[0]!)}`;
        break;
      case TYPE.user:
        statement = `SHOW USERS ${like(parts[0]!)}`;
        break;
      case TYPE.role:
        statement = `SHOW ROLES ${like(parts[0]!)}`;
        break;
      default: {
        const obj = SCHEMA_OBJECTS[typeId];
        if (!obj) throw new Error(`Snowflake plugin: unknown resource type "${typeId}"`);
        statement = `SHOW ${obj.show} ${like(parts[2]!)} IN SCHEMA ${qualified(parts[0]!, parts[1]!)}`;
      }
    }
    // LIKE is a case-insensitive pattern; keep the exact name.
    const wanted = parts[parts.length - 1]!;
    const found = (await this.rows(statement)).find((r) => str(r["name"]) === wanted);
    if (!found) throw new Error(`Snowflake plugin: ${typeId} "${parts.join(".")}" not found`);
    return found;
  }

  /** Cheap single read: SHOW output only, no warehouse. */
  private async getLight(typeId: string, resourceId: string, accountId: string) {
    const id = externalIdOf(resourceId);
    if (typeId === TYPE.account) return this.accountInstance(accountId);
    const row = await this.showOne(typeId, id);
    switch (typeId) {
      case TYPE.warehouse:
        return mapWarehouse(accountId, row);
      case TYPE.database:
        return mapDatabase(accountId, row);
      case TYPE.schema:
        return mapSchema(accountId, row);
      case TYPE.resourceMonitor: {
        const byMonitor = warehousesByMonitor(await this.rows("SHOW WAREHOUSES").catch(() => []));
        return mapResourceMonitor(accountId, row, byMonitor.get(str(row["name"])) ?? []);
      }
      case TYPE.user:
        return mapUser(accountId, row);
      case TYPE.role:
        return mapRole(accountId, row);
      default:
        return SCHEMA_OBJECTS[typeId]!.map(accountId, row);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const base = await this.getLight(typeId, resourceId, accountId);
    switch (typeId) {
      case TYPE.account:
        return this.withOutput(base, OUT.summary, await this.accountSummary());
      case TYPE.warehouse:
        return this.enrichWarehouse(base);
      case TYPE.database:
        return this.enrichDatabase(base);
      case TYPE.resourceMonitor: {
        const warehouses = (await this.rows("SHOW WAREHOUSES").catch(() => [])).map((w) =>
          str(w["name"]),
        );
        return this.withOutput(base, OUT.warehouses, warehouses);
      }
      case TYPE.pipe:
        return this.enrichPipe(accountId, base);
      default:
        return base;
    }
  }

  private withOutput(r: ResourceInstance, key: string, value: unknown): ResourceInstance {
    return { ...r, resolvedOutputs: { ...r.resolvedOutputs, [key]: JSON.stringify(value) } };
  }

  private async accountSummary(): Promise<AccountSummary> {
    return cached(`${this.cacheScope}|summary`, async () => {
      const now = new Date();
      const month = now.toISOString().slice(0, 7);
      const today = now.toISOString().slice(0, 10);
      const [costs, balances, attribution, warehouses] = await Promise.allSettled([
        fetchSnowflakeCostData(this.ctx, this.rates, `${month}-01`, today),
        fetchBalances(this.ctx),
        fetchAttribution(this.ctx),
        this.rows("SHOW WAREHOUSES"),
      ]);
      const summary: AccountSummary = { warehouseFlags: [] };
      if (costs.status === "fulfilled") summary.month = summarizeMonth(month, costs.value);
      else summary.monthError = `Spend could not be read: ${errorText(costs.reason)}`;
      if (balances.status === "fulfilled") summary.balances = balances.value;
      else summary.balanceError = errorText(balances.reason);
      if (attribution.status === "fulfilled") summary.attribution = attribution.value;
      else {
        summary.attributionError = isNotAuthorized(attribution.reason)
          ? "The connection's role cannot read SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY. Grant it the SNOWFLAKE database role USAGE_VIEWER (or IMPORTED PRIVILEGES on the SNOWFLAKE database)."
          : `Attribution could not be read: ${errorText(attribution.reason)}`;
      }
      if (warehouses.status === "fulfilled") {
        for (const w of warehouses.value) {
          const recs = recommendWarehouse(
            { size: str(w["size"]), autoSuspend: num(w["auto_suspend"]) ?? 0 },
            undefined,
          );
          for (const rec of recs)
            summary.warehouseFlags.push({ warehouse: str(w["name"]), title: rec.title });
        }
      }
      return summary;
    });
  }

  private async enrichWarehouse(base: ResourceInstance): Promise<ResourceInstance> {
    const name = str(base.fields["name"]);
    const [activity, monitors] = await Promise.allSettled([
      cached(`${this.cacheScope}|activity|${name}`, () => fetchWarehouseActivity(this.ctx, name)),
      this.rows("SHOW RESOURCE MONITORS"),
    ]);
    const insights: WarehouseInsights = {
      recommendations: recommendWarehouse(
        {
          size: str(base.fields["size"]),
          autoSuspend: Number(base.fields["autoSuspend"] ?? 0),
          autoResume: base.fields["autoResume"] === true,
          maxClusterCount: Number(base.fields["maxClusterCount"] ?? 1),
        },
        activity.status === "fulfilled" ? activity.value : undefined,
      ),
    };
    let r = base;
    if (activity.status === "fulfilled") {
      insights.activity = activity.value;
      r = {
        ...r,
        fields: { ...r.fields, credits30d: Math.round(activity.value.credits * 100) / 100 },
      };
    } else {
      insights.activityError = isNotAuthorized(activity.reason)
        ? "Grant the connection's role the SNOWFLAKE database role USAGE_VIEWER to see load history and sizing advice."
        : `Load history could not be read: ${errorText(activity.reason)}`;
    }
    r = this.withOutput(r, OUT.insights, insights);
    const monitorNames =
      monitors.status === "fulfilled" ? monitors.value.map((m) => str(m["name"])) : [];
    return this.withOutput(r, OUT.monitors, monitorNames);
  }

  private async enrichDatabase(base: ResourceInstance): Promise<ResourceInstance> {
    const name = str(base.fields["name"]);
    try {
      const res = await cached(`${this.cacheScope}|dbstorage|${name}`, () =>
        this.sql(
          `SELECT AVERAGE_DATABASE_BYTES AS DB, AVERAGE_FAILSAFE_BYTES AS FAILSAFE
           FROM SNOWFLAKE.ACCOUNT_USAGE.DATABASE_STORAGE_USAGE_HISTORY
           WHERE DATABASE_NAME = ${literal(name)} AND DELETED IS NULL
           ORDER BY USAGE_DATE DESC LIMIT 1`,
        ),
      );
      const row = res.rows[0];
      if (!row) return base;
      return {
        ...base,
        fields: {
          ...base.fields,
          ...(num(row["db"]) !== undefined ? { storageBytes: num(row["db"])! } : {}),
          ...(num(row["failsafe"]) !== undefined ? { failsafeBytes: num(row["failsafe"])! } : {}),
        },
      };
    } catch {
      return base;
    }
  }

  private async enrichPipe(accountId: string, base: ResourceInstance): Promise<ResourceInstance> {
    const parts = decodeId(externalIdOf(base.id));
    try {
      const res = await this.sql(`SELECT SYSTEM$PIPE_STATUS(${literal(qualified(...parts))}) AS S`);
      const status = JSON.parse(str(res.rows[0]?.["s"]) || "{}") as {
        executionState?: string;
        pendingFileCount?: number;
        lastIngestedTimestamp?: string;
      };
      const row = await this.showOne(TYPE.pipe, externalIdOf(base.id));
      return mapPipe(accountId, row, {
        ...(status.executionState ? { executionState: status.executionState } : {}),
        ...(status.pendingFileCount !== undefined
          ? { pendingFileCount: status.pendingFileCount }
          : {}),
        ...(status.lastIngestedTimestamp ? { lastIngested: status.lastIngestedTimestamp } : {}),
      });
    } catch {
      return base;
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const r = await this.getLight(typeId, resourceId, accountId);
    const resolved = r.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = r.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Snowflake plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs, credits, quotas
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId === TYPE.account) return [];
    const r = await this.getLight(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    switch (resourceTypeId) {
      case TYPE.warehouse: {
        const state = str(f["state"]);
        return [
          {
            label: "State",
            value: state.toLowerCase(),
            variant: state === "STARTED" ? "status-healthy" : "default",
          },
          { label: "Size", value: str(f["size"]) },
          { label: "Running", value: str(f["running"] ?? 0) },
          {
            label: "Queued",
            value: str(f["queued"] ?? 0),
            variant: Number(f["queued"] ?? 0) > 0 ? "status-degraded" : "default",
          },
        ];
      }
      case TYPE.resourceMonitor: {
        const quota = Number(f["creditQuota"]);
        const used = Number(f["usedCredits"] ?? 0);
        const pct = quota > 0 ? Math.round((used / quota) * 100) : undefined;
        return [
          { label: "Used", value: `${used.toFixed(1)} credits` },
          {
            label: "Of quota",
            value: pct !== undefined ? `${pct}%` : "No quota",
            variant:
              pct === undefined
                ? "default"
                : pct >= 100
                  ? "status-error"
                  : pct >= 80
                    ? "status-degraded"
                    : "status-healthy",
          },
        ];
      }
      case TYPE.task:
        return [{ label: "State", value: str(f["state"]) }];
      case TYPE.dynamicTable:
        return [
          { label: "State", value: str(f["schedulingState"]).toLowerCase() },
          { label: "Target lag", value: str(f["targetLag"]) },
        ];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalIdOf(resourceId);
    const bucket = (ms: number) => Math.floor(ms / CACHE_TTL_MS);
    switch (resourceTypeId) {
      case TYPE.warehouse: {
        const name = decodeId(id)[0]!;
        const range = rangeOrDefault(timeRange, WAREHOUSE_METRICS_WINDOW_MS);
        return cached(
          `${this.cacheScope}|wh|${name}|${bucket(range.startMs)}|${bucket(range.endMs)}`,
          () => warehouseSeries(this.ctx, name, range),
        );
      }
      case TYPE.account: {
        const range = rangeOrDefault(timeRange, ACCOUNT_METRICS_WINDOW_MS);
        return cached(
          `${this.cacheScope}|acct|${bucket(range.startMs)}|${bucket(range.endMs)}`,
          () => accountSeries(this.ctx, range),
        );
      }
      case TYPE.database: {
        const name = decodeId(id)[0]!;
        const range = rangeOrDefault(timeRange, ACCOUNT_METRICS_WINDOW_MS);
        return cached(
          `${this.cacheScope}|db|${name}|${bucket(range.startMs)}|${bucket(range.endMs)}`,
          () => databaseSeries(this.ctx, name, range),
        );
      }
      default:
        return [];
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    try {
      return (await fetchSnowflakeCostData(this.ctx, this.rates, range.fromDate, range.toDate))
        .rows;
    } catch (err) {
      if (isNotAuthorized(err)) {
        throw new CostSetupError(
          "The connection's role cannot read Snowflake usage. Grant it the SNOWFLAKE database role USAGE_VIEWER (or IMPORTED PRIVILEGES on the SNOWFLAKE database) for estimated cost, or use a role with the organization usage views for billed cost.",
          {
            label: "Account usage access",
            url: "https://docs.snowflake.com/en/sql-reference/account-usage#enabling-the-snowflake-database-usage-for-other-roles",
          },
        );
      }
      throw err;
    }
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    return fetchBalances(this.ctx);
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    return fetchMonitorQuotas(this.ctx);
  }

  // -------------------------------------------------------------------------
  // SQL editor
  // -------------------------------------------------------------------------

  /** Statement context for a resource: its warehouse, database or schema. */
  private queryContext(resourceId: string): StatementOptions {
    const [, typeId] = resourceId.split(":");
    const parts = typeId ? decodeId(externalIdOf(resourceId)) : [];
    switch (typeId) {
      case TYPE.warehouse:
        return { warehouse: parts[0]! };
      case TYPE.database:
        return { database: parts[0]! };
      case TYPE.schema:
      case TYPE.task:
      case TYPE.pipe:
      case TYPE.dynamicTable:
        return { database: parts[0]!, schema: parts[1]! };
      default:
        return {};
    }
  }

  async executeQuery(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const start = Date.now();
    const res = await this.sql(sql, {
      ...this.queryContext(resourceId),
      keepColumnCase: true,
      maxRows: 10_000,
      timeoutSec: 600,
    });
    return { rows: res.rows, durationMs: Date.now() - start };
  }

  /**
   * Autocomplete metadata from SHOW COLUMNS (cloud services, no warehouse),
   * only for databases and schemas: the host introspects whenever a detail
   * page opens, and nothing else has a natural scope.
   */
  async introspectResource(resourceId: string, _accountId: string): Promise<SqlTableMeta[]> {
    const [, typeId] = resourceId.split(":");
    if (typeId !== TYPE.database && typeId !== TYPE.schema) return [];
    const parts = decodeId(externalIdOf(resourceId));
    const scope =
      typeId === TYPE.database
        ? `IN DATABASE ${ident(parts[0]!)}`
        : `IN SCHEMA ${qualified(parts[0]!, parts[1]!)}`;
    try {
      const res = await this.sql(`SHOW COLUMNS ${scope}`, { maxRows: 5000 });
      const tables = new Map<string, SqlTableMeta>();
      for (const r of res.rows) {
        const schema = str(r["schema_name"]);
        if (schema.toUpperCase() === "INFORMATION_SCHEMA") continue;
        const name =
          typeId === TYPE.database ? `${schema}.${str(r["table_name"])}` : str(r["table_name"]);
        let table = tables.get(name);
        if (!table) tables.set(name, (table = { name, columns: [] }));
        let type = str(r["data_type"]);
        try {
          type = String((JSON.parse(type) as { type?: string }).type ?? type);
        } catch {
          /* already plain */
        }
        table.columns.push({ name: str(r["column_name"]), type });
      }
      return [...tables.values()];
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const sizeOptions = WAREHOUSE_SIZES.map((s) => ({
      id: s.sql,
      label: s.show,
      description: `${s.credits} credit${s.credits === 1 ? "" : "s"} per hour`,
    }));
    switch (typeId) {
      case TYPE.warehouse:
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "ANALYTICS_WH",
            },
            {
              key: "size",
              label: "Size",
              kind: "select",
              required: true,
              defaultValue: "XSMALL",
              options: sizeOptions,
            },
            {
              key: "autoSuspend",
              label: "Auto-suspend",
              kind: "select",
              required: true,
              defaultValue: "60",
              options: [60, 300, 600, 1800, 3600].map((s) => ({
                id: String(s),
                label: s < 60 ? `${s} s` : `${s / 60} min`,
              })),
              description:
                "Suspend after this long with no queries. Every resume bills at least 60 seconds.",
            },
            {
              key: "maxClusterCount",
              label: "Max clusters",
              kind: "number",
              required: false,
              defaultValue: "1",
              minValue: 1,
              maxValue: 300,
              description: "Above 1 adds clusters when queries queue (Enterprise edition and up).",
            },
            { key: "comment", label: "Comment", kind: "text", required: false },
          ],
        };
      case TYPE.database:
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "ANALYTICS" },
            {
              key: "transient",
              label: "Kind",
              kind: "select",
              required: true,
              defaultValue: "false",
              options: [
                {
                  id: "false",
                  label: "Permanent",
                  description: "Time Travel and 7 days of Fail-safe",
                },
                {
                  id: "true",
                  label: "Transient",
                  description: "No Fail-safe, cheaper storage for data you can reload",
                },
              ],
            },
            {
              key: "retentionTime",
              label: "Time Travel retention (days)",
              kind: "number",
              required: false,
              defaultValue: "1",
              minValue: 0,
              maxValue: 90,
            },
            { key: "comment", label: "Comment", kind: "text", required: false },
          ],
        };
      case TYPE.schema: {
        const fields: CreateResourceConfig["fields"] = [];
        if (!parentResourceId) {
          const dbs = await this.rows("SHOW DATABASES").catch(() => []);
          fields.push({
            key: "database",
            label: "Database",
            kind: "select",
            required: true,
            options: dbs
              .filter((d) => !/IMPORTED|APPLICATION/i.test(str(d["kind"])))
              .map((d) => ({ id: str(d["name"]), label: str(d["name"]) })),
          });
        }
        fields.push(
          { key: "name", label: "Name", kind: "text", required: true, placeholder: "STAGING" },
          {
            key: "managedAccess",
            label: "Access",
            kind: "select",
            required: true,
            defaultValue: "false",
            options: [
              { id: "false", label: "Standard", description: "Object owners grant access" },
              {
                id: "true",
                label: "Managed access",
                description: "Only the schema owner grants access",
              },
            ],
          },
          { key: "comment", label: "Comment", kind: "text", required: false },
        );
        return { fields };
      }
      case TYPE.resourceMonitor: {
        const warehouses = await this.rows("SHOW WAREHOUSES").catch(() => []);
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "MONTHLY_LIMIT",
            },
            {
              key: "creditQuota",
              label: "Credit quota",
              kind: "number",
              required: true,
              minValue: 1,
              description: "Credits allowed per interval.",
            },
            {
              key: "frequency",
              label: "Resets",
              kind: "select",
              required: true,
              defaultValue: "MONTHLY",
              options: ["MONTHLY", "WEEKLY", "DAILY", "YEARLY", "NEVER"].map((v) => ({
                id: v,
                label: v.charAt(0) + v.slice(1).toLowerCase(),
              })),
            },
            {
              key: "notifyAt",
              label: "Notify at (%)",
              kind: "text",
              required: false,
              defaultValue: "75,90",
              description:
                "Comma-separated percentages that send an email to account administrators.",
            },
            {
              key: "suspendAt",
              label: "Suspend at (%)",
              kind: "number",
              required: false,
              defaultValue: "100",
              description: "Suspend assigned warehouses once running queries finish.",
            },
            {
              key: "suspendImmediatelyAt",
              label: "Suspend immediately at (%)",
              kind: "number",
              required: false,
              defaultValue: "110",
              description: "Suspend and cancel running queries.",
            },
            {
              key: "assignTo",
              label: "Apply to",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                { id: "", label: "Nothing yet" },
                { id: "__account__", label: "The whole account" },
                ...warehouses.map((w) => ({
                  id: str(w["name"]),
                  label: str(w["name"]),
                  description: "Warehouse",
                })),
              ],
              description: "Creating and assigning monitors needs the ACCOUNTADMIN role.",
            },
          ],
        };
      }
      case TYPE.role:
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "ANALYST" },
            { key: "comment", label: "Comment", kind: "text", required: false },
          ],
        };
      default:
        throw new Error(`Snowflake plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const name = (fields["name"] ?? "").trim();
    if (!name) throw new Error("Snowflake plugin: a name is required");
    const comment = (fields["comment"] ?? "").trim();
    const commentSql = comment ? ` COMMENT = ${literal(comment)}` : "";
    switch (typeId) {
      case TYPE.warehouse: {
        const size = findSize(fields["size"])?.sql ?? "XSMALL";
        const autoSuspend = Math.max(0, Math.floor(Number(fields["autoSuspend"] ?? 60))) || 60;
        const maxClusters = Math.max(1, Math.floor(Number(fields["maxClusterCount"] || 1)));
        await this.sql(
          `CREATE WAREHOUSE ${ident(name)} WITH WAREHOUSE_SIZE = ${size} AUTO_SUSPEND = ${autoSuspend} AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE${maxClusters > 1 ? ` MAX_CLUSTER_COUNT = ${maxClusters}` : ""}${commentSql}`,
        );
        break;
      }
      case TYPE.database: {
        const transient = fields["transient"] === "true" ? "TRANSIENT " : "";
        const retention = Number(fields["retentionTime"]);
        await this.sql(
          `CREATE ${transient}DATABASE ${ident(name)}${Number.isInteger(retention) && retention >= 0 ? ` DATA_RETENTION_TIME_IN_DAYS = ${retention}` : ""}${commentSql}`,
        );
        break;
      }
      case TYPE.schema: {
        const database =
          (fields["database"] ?? "").trim() ||
          (parentResourceId ? decodeId(externalIdOf(parentResourceId))[0]! : "");
        if (!database) throw new Error("Snowflake plugin: pick a database");
        await this.sql(
          `CREATE SCHEMA ${qualified(database, name)}${fields["managedAccess"] === "true" ? " WITH MANAGED ACCESS" : ""}${commentSql}`,
        );
        return mapSchema(accountId, await this.showOne(TYPE.schema, encodeId(database, name)));
      }
      case TYPE.resourceMonitor: {
        const quota = Number(fields["creditQuota"]);
        if (!Number.isFinite(quota) || quota <= 0) {
          throw new Error("Snowflake plugin: enter a credit quota above zero");
        }
        const frequency = ["MONTHLY", "WEEKLY", "DAILY", "YEARLY", "NEVER"].includes(
          fields["frequency"] ?? "",
        )
          ? fields["frequency"]
          : "MONTHLY";
        const triggers = monitorTriggers(fields);
        await this.sql(
          `CREATE RESOURCE MONITOR ${ident(name)} WITH CREDIT_QUOTA = ${quota} FREQUENCY = ${frequency} START_TIMESTAMP = IMMEDIATELY${triggers ? ` ${triggers}` : ""}`,
        );
        const assign = (fields["assignTo"] ?? "").trim();
        if (assign === "__account__") {
          await this.sql(`ALTER ACCOUNT SET RESOURCE_MONITOR = ${ident(name)}`);
        } else if (assign) {
          await this.sql(`ALTER WAREHOUSE ${ident(assign)} SET RESOURCE_MONITOR = ${ident(name)}`);
        }
        break;
      }
      case TYPE.role:
        await this.sql(`CREATE ROLE ${ident(name)}${commentSql}`);
        break;
      default:
        throw new Error(`Snowflake plugin: cannot create "${typeId}" from Infrawrench`);
    }
    return this.getLight(typeId, `${accountId}:${typeId}:${encodeId(name)}`, accountId);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const parts = decodeId(externalIdOf(resourceId));
    const has = (k: string) => k in fields;
    const commentSet = has("comment")
      ? (fields["comment"] ?? "").trim()
        ? `COMMENT = ${literal(fields["comment"]!.trim())}`
        : null
      : undefined;
    const intOf = (k: string): number | undefined => {
      const n = Number(fields[k]);
      return fields[k] !== undefined && fields[k] !== "" && Number.isFinite(n)
        ? Math.floor(n)
        : undefined;
    };
    switch (typeId) {
      case TYPE.warehouse: {
        const sets: string[] = [];
        if (has("size")) {
          const size = findSize(fields["size"]);
          if (!size)
            throw new Error(`Snowflake plugin: unknown warehouse size "${fields["size"]}"`);
          sets.push(`WAREHOUSE_SIZE = ${size.sql}`);
        }
        if (has("autoSuspend")) {
          const s = intOf("autoSuspend") ?? 0;
          sets.push(`AUTO_SUSPEND = ${s > 0 ? s : "NULL"}`);
        }
        if (has("autoResume"))
          sets.push(`AUTO_RESUME = ${fields["autoResume"] === "true" ? "TRUE" : "FALSE"}`);
        // Max before min so raising both in one edit never trips min <= max.
        if (has("maxClusterCount") && intOf("maxClusterCount")) {
          sets.push(`MAX_CLUSTER_COUNT = ${intOf("maxClusterCount")}`);
        }
        if (has("minClusterCount") && intOf("minClusterCount")) {
          sets.push(`MIN_CLUSTER_COUNT = ${intOf("minClusterCount")}`);
        }
        if (has("scalingPolicy") && /^(STANDARD|ECONOMY)$/.test(fields["scalingPolicy"] ?? "")) {
          sets.push(`SCALING_POLICY = ${fields["scalingPolicy"]}`);
        }
        if (has("queryAcceleration")) {
          sets.push(
            `ENABLE_QUERY_ACCELERATION = ${fields["queryAcceleration"] === "true" ? "TRUE" : "FALSE"}`,
          );
        }
        if (commentSet) sets.push(commentSet);
        if (sets.length > 0)
          await this.sql(`ALTER WAREHOUSE ${ident(parts[0]!)} SET ${sets.join(" ")}`);
        if (commentSet === null)
          await this.sql(`ALTER WAREHOUSE ${ident(parts[0]!)} UNSET COMMENT`);
        break;
      }
      case TYPE.database:
      case TYPE.schema: {
        const kind = typeId === TYPE.database ? "DATABASE" : "SCHEMA";
        const target =
          typeId === TYPE.database ? ident(parts[0]!) : qualified(parts[0]!, parts[1]!);
        const sets: string[] = [];
        const retention = intOf("retentionTime");
        if (has("retentionTime") && retention !== undefined) {
          sets.push(`DATA_RETENTION_TIME_IN_DAYS = ${retention}`);
        }
        if (commentSet) sets.push(commentSet);
        if (sets.length > 0) await this.sql(`ALTER ${kind} ${target} SET ${sets.join(" ")}`);
        if (commentSet === null) await this.sql(`ALTER ${kind} ${target} UNSET COMMENT`);
        break;
      }
      case TYPE.resourceMonitor: {
        const current = await this.getLight(typeId, resourceId, accountId);
        const sets: string[] = [];
        if (has("creditQuota")) {
          const q = Number(fields["creditQuota"]);
          sets.push(`CREDIT_QUOTA = ${Number.isFinite(q) && q > 0 ? q : "NULL"}`);
        }
        if (
          has("frequency") &&
          /^(MONTHLY|WEEKLY|DAILY|YEARLY|NEVER)$/.test(fields["frequency"] ?? "")
        ) {
          sets.push(`FREQUENCY = ${fields["frequency"]} START_TIMESTAMP = IMMEDIATELY`);
        }
        const triggersChanged = has("notifyAt") || has("suspendAt") || has("suspendImmediatelyAt");
        // TRIGGERS replaces the whole set, so rebuild it from current + edits.
        const triggers = triggersChanged
          ? monitorTriggers({
              notifyAt: has("notifyAt") ? fields["notifyAt"] : str(current.fields["notifyAt"]),
              suspendAt: has("suspendAt") ? fields["suspendAt"] : str(current.fields["suspendAt"]),
              suspendImmediatelyAt: has("suspendImmediatelyAt")
                ? fields["suspendImmediatelyAt"]
                : str(current.fields["suspendImmediatelyAt"]),
            })
          : "";
        if (sets.length > 0 || triggers) {
          await this.sql(
            `ALTER RESOURCE MONITOR ${ident(parts[0]!)}${sets.length ? ` SET ${sets.join(" ")}` : ""}${triggers ? ` ${triggers}` : ""}`,
          );
        }
        break;
      }
      case TYPE.user: {
        const sets: string[] = [];
        if (has("defaultRole"))
          sets.push(`DEFAULT_ROLE = ${literal((fields["defaultRole"] ?? "").trim())}`);
        if (has("defaultWarehouse")) {
          sets.push(`DEFAULT_WAREHOUSE = ${literal((fields["defaultWarehouse"] ?? "").trim())}`);
        }
        if (has("comment")) sets.push(`COMMENT = ${literal((fields["comment"] ?? "").trim())}`);
        if (sets.length > 0) await this.sql(`ALTER USER ${ident(parts[0]!)} SET ${sets.join(" ")}`);
        break;
      }
      case TYPE.role:
        if (commentSet) await this.sql(`ALTER ROLE ${ident(parts[0]!)} SET ${commentSet}`);
        if (commentSet === null) await this.sql(`ALTER ROLE ${ident(parts[0]!)} UNSET COMMENT`);
        break;
      case TYPE.task: {
        const target = qualified(...parts);
        if (has("schedule")) {
          // A started task must be suspended before its schedule changes.
          const current = await this.getLight(typeId, resourceId, accountId);
          const wasStarted = str(current.fields["state"]) === "started";
          if (wasStarted) await this.sql(`ALTER TASK ${target} SUSPEND`);
          const schedule = (fields["schedule"] ?? "").trim();
          await this.sql(
            schedule
              ? `ALTER TASK ${target} SET SCHEDULE = ${literal(schedule)}`
              : `ALTER TASK ${target} UNSET SCHEDULE`,
          );
          if (wasStarted) await this.sql(`ALTER TASK ${target} RESUME`);
        }
        if (commentSet) await this.sql(`ALTER TASK ${target} SET ${commentSet}`);
        if (commentSet === null) await this.sql(`ALTER TASK ${target} UNSET COMMENT`);
        break;
      }
      case TYPE.pipe: {
        const target = qualified(...parts);
        if (commentSet) await this.sql(`ALTER PIPE ${target} SET ${commentSet}`);
        if (commentSet === null) await this.sql(`ALTER PIPE ${target} UNSET COMMENT`);
        break;
      }
      case TYPE.dynamicTable: {
        const target = qualified(...parts);
        const sets: string[] = [];
        if (has("targetLag")) {
          const lag = (fields["targetLag"] ?? "").trim();
          if (lag)
            sets.push(`TARGET_LAG = ${/^downstream$/i.test(lag) ? "DOWNSTREAM" : literal(lag)}`);
        }
        if (commentSet) sets.push(commentSet);
        if (sets.length > 0) await this.sql(`ALTER DYNAMIC TABLE ${target} SET ${sets.join(" ")}`);
        if (commentSet === null) await this.sql(`ALTER DYNAMIC TABLE ${target} UNSET COMMENT`);
        break;
      }
      default:
        throw new Error(`Snowflake plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
    return this.getLight(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const parts = decodeId(externalIdOf(resourceId));
    const drop: Record<string, string> = {
      [TYPE.warehouse]: "WAREHOUSE",
      [TYPE.database]: "DATABASE",
      [TYPE.schema]: "SCHEMA",
      [TYPE.resourceMonitor]: "RESOURCE MONITOR",
      [TYPE.role]: "ROLE",
      [TYPE.task]: "TASK",
      [TYPE.pipe]: "PIPE",
      [TYPE.dynamicTable]: "DYNAMIC TABLE",
    };
    const kind = drop[typeId];
    if (!kind) throw new Error(`Snowflake plugin: "${typeId}" cannot be deleted from Infrawrench`);
    await this.sql(`DROP ${kind} ${qualified(...parts)}`);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async setWarehouse(name: string, clause: string): Promise<void> {
    await this.sql(`ALTER WAREHOUSE ${ident(name)} ${clause}`);
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const parts = decodeId(externalIdOf(resourceId));
    const target = qualified(...parts);
    if (typeId === TYPE.warehouse) {
      const name = parts[0]!;
      if (actionId === "resume") return this.setWarehouse(name, "RESUME IF SUSPENDED");
      if (actionId === "suspend") {
        try {
          return await this.setWarehouse(name, "SUSPEND");
        } catch (err) {
          // Already suspended (or suspending) is the state the user asked for.
          if (/suspend/i.test(errorText(err)) && /cannot|already|not/i.test(errorText(err))) return;
          throw err;
        }
      }
      if (actionId.startsWith("resize:")) {
        const size = findSize(actionId.slice("resize:".length));
        if (!size) throw new Error("Snowflake plugin: unknown size");
        return this.setWarehouse(name, `SET WAREHOUSE_SIZE = ${size.sql}`);
      }
      if (actionId.startsWith("auto-suspend:")) {
        const s = Math.floor(Number(actionId.slice("auto-suspend:".length)));
        if (!Number.isFinite(s) || s < 0) throw new Error("Snowflake plugin: invalid auto-suspend");
        return this.setWarehouse(name, `SET AUTO_SUSPEND = ${s > 0 ? s : "NULL"}`);
      }
    }
    if (typeId === TYPE.user && (actionId === "disable" || actionId === "enable")) {
      await this.sql(
        `ALTER USER ${target} SET DISABLED = ${actionId === "disable" ? "TRUE" : "FALSE"}`,
      );
      return;
    }
    if (typeId === TYPE.task) {
      if (actionId === "suspend" || actionId === "resume") {
        await this.sql(`ALTER TASK ${target} ${actionId.toUpperCase()}`);
        return;
      }
      if (actionId === "execute") {
        await this.sql(`EXECUTE TASK ${target}`);
        return;
      }
    }
    if (typeId === TYPE.pipe) {
      if (actionId === "pause" || actionId === "resume") {
        await this.sql(
          `ALTER PIPE ${target} SET PIPE_EXECUTION_PAUSED = ${actionId === "pause" ? "TRUE" : "FALSE"}`,
        );
        return;
      }
      if (actionId === "refresh") {
        await this.sql(`ALTER PIPE ${target} REFRESH`);
        return;
      }
    }
    if (typeId === TYPE.dynamicTable && ["suspend", "resume", "refresh"].includes(actionId)) {
      await this.sql(`ALTER DYNAMIC TABLE ${target} ${actionId.toUpperCase()}`);
      return;
    }
    if (typeId === TYPE.resourceMonitor && actionId === "set-account-monitor") {
      await this.sql(`ALTER ACCOUNT SET RESOURCE_MONITOR = ${target}`);
      return;
    }
    throw new Error(`Snowflake plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  /** Form-backed actions (`prompt-nosql-command` in the detail view). */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const parts = decodeId(externalIdOf(resourceId));
    const form = decodePromptArgs(args);
    if (typeId === TYPE.warehouse) {
      const name = parts[0]!;
      switch (command) {
        case "resize": {
          const size = findSize(form["size"]);
          if (!size) throw new Error("Pick a size");
          await this.setWarehouse(name, `SET WAREHOUSE_SIZE = ${size.sql}`);
          return { ok: true };
        }
        case "set-auto-suspend": {
          const s = Math.floor(Number(form["seconds"]));
          if (!Number.isFinite(s) || s < 0) throw new Error("Pick a duration");
          await this.setWarehouse(name, `SET AUTO_SUSPEND = ${s > 0 ? s : "NULL"}`);
          return { ok: true };
        }
        case "assign-monitor": {
          const monitor = (form["monitor"] ?? "").trim();
          await this.setWarehouse(
            name,
            monitor ? `SET RESOURCE_MONITOR = ${ident(monitor)}` : "UNSET RESOURCE_MONITOR",
          );
          return { ok: true };
        }
      }
    }
    if (typeId === TYPE.resourceMonitor && command === "assign-warehouse") {
      const warehouse = (form["warehouse"] ?? "").trim();
      if (!warehouse) throw new Error("Pick a warehouse");
      await this.setWarehouse(warehouse, `SET RESOURCE_MONITOR = ${ident(parts[0]!)}`);
      return { ok: true };
    }
    throw new Error(`Snowflake plugin: command "${command}" not supported for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderSnowflakeDetail(resource, this.rates);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSnowflakeSidebar(resource);
  }
}
