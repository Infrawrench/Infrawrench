import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceCreateResult,
  ResourceInstance,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import {
  QuotaAccessError,
  decodePromptArgs,
  externalIdOf,
  pathEncode,
  requireListPage,
  withMetricsCapability,
  type ApiBody,
} from "@infrawrench/plugin-base";
import type {
  AlertRow,
  Authorization,
  Bucket,
  CloudApi,
  DedicatedApi,
  DedicatedDatabase,
  DedicatedPermission,
  DedicatedToken,
  Limits,
  Permission,
  RetentionRule,
  Task,
  Transport,
} from "./api.js";
import {
  cloudApi,
  dedicatedApi,
  hostFor,
  influxCall,
  influxText,
  isUnavailable,
  parseAnnotatedCsv,
  statusOf,
  usageApi,
} from "./api.js";
import type { operations } from "./api-types.cloud.gen.js";
import { ENRICH, renderInfluxDetail, renderInfluxSidebar } from "./render.js";
import { RESOURCE_TYPES, T } from "./resource-types.js";

const CACHE_MS = 20_000;
const DAY = 86_400;
const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
const NS_PER_DAY = 86_400_000_000_000;

/** Resource types an API token can be scoped to (the Cloud OpenAPI `Resource.type` enum, minus `instance`). */
export const PERMISSION_TYPES = [
  "authorizations",
  "buckets",
  "checks",
  "dashboards",
  "dbrp",
  "labels",
  "notificationEndpoints",
  "notificationRules",
  "orgs",
  "secrets",
  "tasks",
  "telegrafs",
  "users",
  "variables",
];

type Fields = Record<string, string | number | boolean>;

/** One cached answer, kept for {@link CACHE_MS}; a failure is forgotten rather than cached. */
class Cached<V> {
  private slot: { at: number; value: Promise<V> } | null = null;

  get(load: () => Promise<V>): Promise<V> {
    if (this.slot && Date.now() - this.slot.at < CACHE_MS) return this.slot.value;
    const value = load();
    this.slot = { at: Date.now(), value };
    value.catch(() => {
      this.slot = null;
    });
    return value;
  }

  clear(): void {
    this.slot = null;
  }
}

/** What an update to a check, notification rule or notification endpoint can change. */
interface AlertUpdate {
  name?: string | undefined;
  description?: string | undefined;
  status?: string | undefined;
}

function compact(fields: Record<string, string | number | boolean | null | undefined>): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

function csv(raw: string | undefined): string[] {
  const text = String(raw ?? "").trim();
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed))
        return parsed
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function nonNegative(raw: string | undefined, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be zero or more.`);
  return n;
}

function notFound(what: string): Error {
  return Object.assign(new Error(`InfluxDB Cloud plugin: ${what} not found`), { status: 404 });
}

function retentionRules(days: number): RetentionRule[] {
  return days > 0 ? [{ type: "expire", everySeconds: Math.round(days * DAY) }] : [];
}

/** Flux when the text pipes (`|>`) or imports; InfluxQL otherwise. */
export function isFlux(query: string): boolean {
  return /\|>/.test(query) || /^\s*import\s+"/.test(query);
}

export class InfluxClient implements PluginClient {
  private readonly t: Transport;
  private readonly cloud: {
    host: string;
    token: string;
    orgId: string;
    region: string;
    api: CloudApi;
  } | null;
  private readonly dedicated: { clusterId: string; api: DedicatedApi } | null;
  private readonly orgIdCache = new Cached<string>();
  private readonly bucketCache = new Cached<Bucket[]>();
  private readonly storageCache = new Cached<Map<string, number>>();
  private readonly limitsCache = new Cached<Limits>();

  constructor(credentials: Credentials, services?: HostServices) {
    this.t = services?.http ? { http: services.http } : {};
    const token = (credentials["token"] ?? "").trim();
    const region = (credentials["region"] ?? "").trim();
    const orgId = (credentials["orgId"] ?? "").trim();
    if (token && region) {
      const host = hostFor(region);
      this.cloud = { host, token, orgId, region, api: cloudApi(this.t, host, token) };
    } else {
      this.cloud = null;
    }
    const accountId = (credentials["dedicatedAccountId"] ?? "").trim();
    const clusterId = (credentials["dedicatedClusterId"] ?? "").trim();
    const mgmt = (credentials["dedicatedManagementToken"] ?? "").trim();
    this.dedicated =
      accountId && clusterId && mgmt
        ? { clusterId, api: dedicatedApi(this.t, accountId, clusterId, mgmt) }
        : null;
    if (!this.cloud && !this.dedicated) {
      throw new Error(
        "InfluxDB Cloud plugin: give a region and API token, or the three Cloud Dedicated fields",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private invalidate(): void {
    this.orgIdCache.clear();
    this.bucketCache.clear();
    this.storageCache.clear();
    this.limitsCache.clear();
  }

  private requireCloud() {
    if (!this.cloud) throw new Error("This account has no InfluxDB Cloud token configured.");
    return this.cloud;
  }

  private requireDedicated() {
    if (!this.dedicated)
      throw new Error("This account has no Cloud Dedicated management token configured.");
    return this.dedicated;
  }

  private v2<V>(call: (api: CloudApi) => Promise<V>): Promise<V> {
    const { api } = this.requireCloud();
    return influxCall(() => call(api));
  }

  private mgmt<V>(call: (api: DedicatedApi) => Promise<V>): Promise<V> {
    const { api } = this.requireDedicated();
    return influxCall(() => call(api));
  }

  /** The organization: the configured one, or the token's only one. */
  async orgId(): Promise<string> {
    const c = this.requireCloud();
    if (c.orgId) return c.orgId;
    return this.orgIdCache.get(async () => {
      const res = await this.v2((api) => api.get("/api/v2/orgs"));
      const id = res?.orgs?.[0]?.id;
      if (!id) throw new Error("The token can see no organization.");
      return id;
    });
  }

  buckets(): Promise<Bucket[]> {
    return this.bucketCache.get(async () => {
      const orgID = await this.orgId();
      return this.v2((api) => api.getAll("/api/v2/buckets", "buckets", { query: { orgID } }));
    });
  }

  private async tasks() {
    const orgID = await this.orgId();
    return this.v2((api) =>
      api.getAll("/api/v2/tasks", "tasks", {
        query: { orgID, type: "basic" },
        // The one list the document lets go past 100 a page: 20 pages is 10,000 rows.
        pageSize: 500,
        maxPages: 20,
      }),
    );
  }

  private async checks() {
    const orgID = await this.orgId();
    return this.v2((api) => api.getAll("/api/v2/checks", "checks", { query: { orgID } }));
  }

  private async notificationRules() {
    const orgID = await this.orgId();
    return this.v2((api) =>
      api.getAll("/api/v2/notificationRules", "notificationRules", { query: { orgID } }),
    );
  }

  private async notificationEndpoints() {
    const orgID = await this.orgId();
    return this.v2((api) =>
      api.getAll("/api/v2/notificationEndpoints", "notificationEndpoints", { query: { orgID } }),
    );
  }

  private async dashboards() {
    const orgID = await this.orgId();
    return this.v2((api) => api.getAll("/api/v2/dashboards", "dashboards", { query: { orgID } }));
  }

  private async dedicatedDatabases() {
    const answer = await this.mgmt((api) => api.get("/databases"));
    return requireListPage(answer, { vendor: "InfluxDB", path: "/databases", key: null });
  }

  private async optionalList<V>(load: () => Promise<V[]>): Promise<V[]> {
    try {
      return await load();
    } catch (err) {
      if (isUnavailable(err)) return [];
      throw err;
    }
  }

  /** Latest stored bytes per bucket from the usage CSV, empty when the endpoint refuses. */
  private storageByBucket(): Promise<Map<string, number>> {
    return this.storageCache.get(async () => {
      const out = new Map<string, { at: string; value: number }>();
      try {
        const now = Math.floor(Date.now() / 1000);
        const rows = await this.usageRows(now - 3 * 3600, now);
        for (const r of rows) {
          if (r["_measurement"] !== "storage_usage_bucket_bytes" || !r["bucket_id"]) continue;
          const value = Number(r["_value"]);
          const prev = out.get(r["bucket_id"]);
          if (Number.isFinite(value) && (!prev || (r["_time"] ?? "") > prev.at)) {
            out.set(r["bucket_id"], { at: r["_time"] ?? "", value });
          }
        }
      } catch (err) {
        if (statusOf(err) === 401) throw err;
      }
      return new Map([...out].map(([k, v]) => [k, v.value]));
    });
  }

  private async usageRows(start: number, stop: number): Promise<Record<string, string>[]> {
    const c = this.requireCloud();
    const org = await this.orgId();
    const { body } = await usageApi(this.t, c.host, c.token).getText(
      `/api/v2/orgs/${pathEncode(org)}/usage`,
      { query: { start, stop } },
    );
    return parseAnnotatedCsv(body);
  }

  private inst(
    accountId: string,
    typeId: string,
    externalId: string,
    name: string,
    fields: Fields,
  ): ResourceInstance {
    const now = new Date().toISOString();
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: "influxdb-cloud",
      resourceTypeId: typeId,
      accountId,
      displayName: name || externalId,
      fields,
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: now,
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Mappers
  // -------------------------------------------------------------------------

  private mapBucket(accountId: string, b: Bucket, storage?: number): ResourceInstance {
    const every = b.retentionRules?.[0]?.everySeconds;
    return this.inst(
      accountId,
      T.bucket,
      b.id,
      b.name ?? b.id,
      compact({
        name: b.name,
        description: b.description,
        bucketId: b.id,
        orgId: b.orgID,
        region: this.cloud?.region,
        retentionDays: every === undefined ? 0 : Math.round((every / DAY) * 1000) / 1000,
        schemaType: b.schemaType,
        type: b.type,
        storageBytes: storage,
        createdAt: b.createdAt,
      }),
    );
  }

  private describePermissions(a: Authorization): { text: string; allAccess: boolean } {
    const perms = a.permissions ?? [];
    const types = new Set(
      perms
        .filter((p) => !p.resource?.id && !p.resource?.name)
        .map((p) => `${p.resource?.type}:${p.action}`),
    );
    const allAccess = PERMISSION_TYPES.every(
      (t) => types.has(`${t}:read`) && types.has(`${t}:write`),
    );
    const text = allAccess
      ? "All access"
      : perms
          .map(
            (p) =>
              `${p.action ?? "?"} ${p.resource?.type ?? "?"}${p.resource?.name ? ` ${p.resource.name}` : p.resource?.id ? ` ${p.resource.id}` : ""}`,
          )
          .join(", ");
    return { text, allAccess };
  }

  private mapAuth(accountId: string, a: Authorization): ResourceInstance {
    const { text, allAccess } = this.describePermissions(a);
    return this.inst(
      accountId,
      T.token,
      a.id,
      a.description || a.id,
      compact({
        description: a.description,
        tokenId: a.id,
        status: a.status,
        permissions: text,
        allAccess,
        user: a.user,
        region: this.cloud?.region,
        createdAt: a.createdAt,
      }),
    );
  }

  private mapTask(accountId: string, t: Task): ResourceInstance {
    return this.inst(
      accountId,
      T.task,
      t.id,
      t.name ?? t.id,
      compact({
        name: t.name,
        taskId: t.id,
        status: t.status,
        every: t.every,
        cron: t.cron,
        offset: t.offset,
        description: t.description,
        lastRunStatus: t.lastRunStatus,
        lastRunError: t.lastRunError,
        latestCompleted: t.latestCompleted,
        region: this.cloud?.region,
      }),
    );
  }

  private mapAlert(accountId: string, typeId: string, a: AlertRow): ResourceInstance {
    return this.inst(
      accountId,
      typeId,
      a.id,
      a.name ?? a.id,
      compact({
        name: a.name,
        description: a.description,
        status: a.status,
        kind: a.type,
        every: a.every,
        endpointId: a.endpointID,
        url: a.url,
        lastRunStatus: a.lastRunStatus,
        lastRunError: a.lastRunError,
        region: this.cloud?.region,
      }),
    );
  }

  private mapDedicatedDb(accountId: string, d: DedicatedDatabase): ResourceInstance {
    return this.inst(
      accountId,
      T.dedicatedDatabase,
      d.name,
      d.name,
      compact({
        name: d.name,
        clusterId: d.clusterId ?? this.dedicated?.clusterId,
        retentionDays:
          d.retentionPeriod !== undefined
            ? Math.round((d.retentionPeriod / NS_PER_DAY) * 1000) / 1000
            : undefined,
        maxTables: d.maxTables,
        maxColumnsPerTable: d.maxColumnsPerTable,
        partitionTemplate: (d.partitionTemplate ?? [])
          .map(
            (p) => `${p.type}:${typeof p.value === "string" ? p.value : JSON.stringify(p.value)}`,
          )
          .join(", "),
      }),
    );
  }

  private mapDedicatedToken(accountId: string, t: DedicatedToken): ResourceInstance {
    const perms = t.permissions ?? [];
    return this.inst(
      accountId,
      T.dedicatedToken,
      t.id,
      t.description || t.id,
      compact({
        description: t.description,
        tokenId: t.id,
        permissions: perms.map((p) => `${p.action} ${p.resource}`).join(", "),
        allDatabases: perms.some((p) => p.resource === "*"),
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      const cloudType = typeId !== T.dedicatedDatabase && typeId !== T.dedicatedToken;
      if (cloudType && !this.cloud) return [];
      if (!cloudType && !this.dedicated) return [];
      switch (typeId) {
        case T.org: {
          const org = await this.orgId();
          const [o, limits] = await Promise.all([
            this.v2((api) => api.get(`/api/v2/orgs/${pathEncode(org)}`)),
            this.limits().catch(() => undefined),
          ]);
          const l = limits?.limits;
          return [
            this.inst(
              accountId,
              T.org,
              o.id,
              o.name ?? o.id,
              compact({
                name: o.name,
                orgId: o.id,
                storageEngine:
                  o.defaultStorageType === "iox"
                    ? "InfluxDB 3 (Serverless)"
                    : o.defaultStorageType === "tsm"
                      ? "TSM"
                      : o.defaultStorageType,
                region: this.cloud?.region,
                status: o.status,
                maxBuckets: l?.bucket?.maxBuckets,
                maxRetentionDays: l?.bucket?.maxRetentionDuration
                  ? Math.round(l.bucket.maxRetentionDuration / NS_PER_DAY)
                  : undefined,
                maxTasks: l?.task?.maxTasks,
                maxChecks: l?.check?.maxChecks,
                writeKBs: l?.rate?.writeKBs,
                readKBs: l?.rate?.readKBs,
                cardinality: l?.rate?.cardinality,
                createdAt: o.createdAt,
              }),
            ),
          ];
        }
        case T.bucket: {
          const [buckets, storage] = await Promise.all([this.buckets(), this.storageByBucket()]);
          return buckets
            .filter((b) => b.type !== "system")
            .map((b) => this.mapBucket(accountId, b, storage.get(b.id)));
        }
        case T.token: {
          const org = await this.orgId();
          const res = await this.v2((api) =>
            api.get("/api/v2/authorizations", { query: { orgID: org } }),
          );
          return requireListPage(res?.authorizations, {
            vendor: "InfluxDB",
            path: "/api/v2/authorizations",
            key: "authorizations",
          }).map((a) => this.mapAuth(accountId, a));
        }
        case T.task:
          return (await this.optionalList(() => this.tasks())).map((t) =>
            this.mapTask(accountId, t),
          );
        case T.check:
          return (await this.optionalList(() => this.checks())).map((a) =>
            this.mapAlert(accountId, T.check, a),
          );
        case T.rule:
          return (await this.optionalList(() => this.notificationRules())).map((a) =>
            this.mapAlert(accountId, T.rule, a),
          );
        case T.endpoint:
          return (await this.optionalList(() => this.notificationEndpoints())).map((a) =>
            this.mapAlert(accountId, T.endpoint, a),
          );
        case T.dashboard:
          return (await this.optionalList(() => this.dashboards())).map((d) =>
            this.inst(
              accountId,
              T.dashboard,
              d.id,
              d.name ?? d.id,
              compact({
                name: d.name,
                description: d.description,
                cells: d.cells?.length ?? 0,
                region: this.cloud?.region,
                updatedAt: d.meta?.updatedAt,
              }),
            ),
          );
        case T.telegraf: {
          const org = await this.orgId();
          const res = await this.optionalList(async () => {
            const r = await this.v2((api) =>
              api.get("/api/v2/telegrafs", { query: { orgID: org } }),
            );
            return requireListPage(r?.configurations, {
              vendor: "InfluxDB",
              path: "/api/v2/telegrafs",
              key: "configurations",
            });
          });
          return res.map((t) =>
            this.inst(
              accountId,
              T.telegraf,
              t.id,
              t.name ?? t.id,
              compact({
                name: t.name,
                description: t.description,
                buckets: (t.metadata?.buckets ?? []).join(", "),
                region: this.cloud?.region,
              }),
            ),
          );
        }
        case T.dedicatedDatabase:
          return (await this.dedicatedDatabases()).map((d) => this.mapDedicatedDb(accountId, d));
        case T.dedicatedToken: {
          const tokens = await this.mgmt((api) => api.get("/tokens"));
          return requireListPage(tokens, { vendor: "InfluxDB", path: "/tokens", key: null })
            .filter((t) => !t.revokedAt)
            .map((t) => this.mapDedicatedToken(accountId, t));
        }
        default:
          throw new Error(`InfluxDB Cloud plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private limits() {
    return this.limitsCache.get(async () => {
      const org = await this.orgId();
      return this.v2((api) => api.get(`/api/v2/orgs/${pathEncode(org)}/limits`));
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      const found = (await runPluginEffect(this.listResources(typeId, accountId))).find(
        (r) => r.externalId === ext,
      );
      if (!found) throw notFound(`${typeId} ${ext}`);
      return found;
    });
  }

  resolveOutput(typeId: string, _resourceId: string, outputKey: string): PluginEffect<string> {
    return attempt(async () => {
      if (outputKey === "token" && (typeId === T.token || typeId === T.dedicatedToken)) {
        throw new Error(
          "InfluxDB shows a token only when it is created. Create a new token to get one.",
        );
      }
      throw new Error(`InfluxDB Cloud plugin: cannot resolve "${outputKey}" for "${typeId}"`);
    });
  }

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (resource.resourceTypeId !== T.task) return resource;
      const task = await this.v2((api) =>
        api.get(`/api/v2/tasks/${pathEncode(resource.externalId ?? "")}`),
      );
      return {
        ...resource,
        resolvedOutputs: { ...resource.resolvedOutputs, [ENRICH.flux]: task?.flux ?? "" },
      };
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderInfluxDetail(resource),
      RESOURCE_TYPES,
      resource.resourceTypeId,
      METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderInfluxSidebar(resource);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case T.bucket:
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              { key: "description", label: "Description", kind: "text", required: false },
              {
                key: "retentionDays",
                label: "Retention (days)",
                kind: "number",
                required: true,
                minValue: 0,
                defaultValue: "30",
                description: "0 keeps data forever. The Free plan allows at most 30 days.",
              },
            ],
          };
        case T.token: {
          const buckets = (await this.buckets())
            .filter((b) => b.type !== "system")
            .map((b) => ({ id: b.id, label: b.name ?? b.id }));
          return {
            fields: [
              {
                key: "description",
                label: "Description",
                kind: "text",
                required: true,
                placeholder: "telegraf on web-1",
              },
              {
                key: "readBuckets",
                label: "Read buckets",
                kind: "policy-picker",
                required: false,
                policies: buckets,
              },
              {
                key: "writeBuckets",
                label: "Write buckets",
                kind: "policy-picker",
                required: false,
                policies: buckets,
              },
              {
                key: "other",
                label: "Other permissions",
                kind: "policy-picker",
                required: false,
                policies: PERMISSION_TYPES.flatMap((t) => [
                  { id: `${t}:read`, label: `Read ${t}`, category: t },
                  { id: `${t}:write`, label: `Write ${t}`, category: t },
                ]),
                description: "Pick every entry for an all-access token.",
              },
            ],
          };
        }
        case T.task:
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "every",
                label: "Every",
                kind: "text",
                required: false,
                placeholder: "1h",
                description: "Leave empty to use Cron.",
              },
              {
                key: "cron",
                label: "Cron",
                kind: "text",
                required: false,
                placeholder: "0 * * * *",
              },
              { key: "offset", label: "Offset", kind: "text", required: false, placeholder: "5m" },
              {
                key: "flux",
                label: "Flux",
                kind: "code",
                codeLanguage: "plaintext",
                required: true,
                defaultValue:
                  'from(bucket: "example")\n  |> range(start: -task.every)\n  |> aggregateWindow(every: 1m, fn: mean)\n  |> to(bucket: "example-downsampled")',
              },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case T.dashboard:
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case T.dedicatedDatabase:
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "retentionDays",
                label: "Retention (days)",
                kind: "number",
                required: false,
                minValue: 0,
                defaultValue: "0",
                description: "0 keeps data forever.",
              },
              {
                key: "maxTables",
                label: "Max tables",
                kind: "number",
                required: false,
                minValue: 1,
                defaultValue: "500",
              },
              {
                key: "maxColumnsPerTable",
                label: "Max columns per table",
                kind: "number",
                required: false,
                minValue: 1,
                defaultValue: "200",
              },
            ],
          };
        case T.dedicatedToken: {
          const dbs = (await this.dedicatedDatabases()).map((d) => ({ id: d.name, label: d.name }));
          const all = [{ id: "*", label: "All databases" }, ...dbs];
          return {
            fields: [
              { key: "description", label: "Description", kind: "text", required: true },
              { key: "read", label: "Read", kind: "policy-picker", required: false, policies: all },
              {
                key: "write",
                label: "Write",
                kind: "policy-picker",
                required: false,
                policies: all,
              },
              { key: "expiresAt", label: "Expires (optional)", kind: "datetime", required: false },
            ],
          };
        }
        default:
          throw new Error(`InfluxDB Cloud plugin: creating "${typeId}" is not supported`);
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance | ResourceCreateResult> {
    return attempt(async () => {
      this.invalidate();
      switch (typeId) {
        case T.bucket: {
          const days = nonNegative(fields["retentionDays"] ?? "0", "Retention");
          const orgID = await this.orgId();
          const b = await this.v2((api) =>
            api.post("/api/v2/buckets", {
              body: {
                orgID,
                name: (fields["name"] ?? "").trim(),
                ...(fields["description"] ? { description: fields["description"] } : {}),
                retentionRules: retentionRules(days),
              },
            }),
          );
          return this.mapBucket(accountId, b);
        }
        case T.token: {
          const org = await this.orgId();
          const permissions: Permission[] = [];
          for (const id of csv(fields["readBuckets"]))
            permissions.push({ action: "read", resource: { type: "buckets", id, orgID: org } });
          for (const id of csv(fields["writeBuckets"]))
            permissions.push({ action: "write", resource: { type: "buckets", id, orgID: org } });
          for (const p of csv(fields["other"])) {
            const [type, action] = p.split(":");
            if (type && action) permissions.push({ action, resource: { type, orgID: org } });
          }
          if (!permissions.length) throw new Error("Pick at least one permission.");
          const a = await this.v2((api) =>
            api.post("/api/v2/authorizations", {
              body: {
                orgID: org,
                description: (fields["description"] ?? "").trim(),
                permissions,
              },
            }),
          );
          const r = this.mapAuth(accountId, a);
          if (a.token) r.resolvedOutputs["token"] = a.token;
          return {
            resource: r,
            warnings: [
              {
                code: "token-shown-once",
                message: "Copy the token from its outputs now: InfluxDB will not show it again.",
              },
            ],
          };
        }
        case T.task: {
          const flux = fields["flux"] ?? "";
          if (!flux.trim()) throw new Error("Give the task's Flux.");
          if (!fields["every"] && !fields["cron"] && !/option\s+task/.test(flux)) {
            throw new Error("Give Every or Cron, or an `option task = {…}` block in the Flux.");
          }
          const orgID = await this.orgId();
          const t = await this.v2((api) =>
            api.post("/api/v2/tasks", {
              body: {
                orgID,
                flux,
                ...(fields["name"] ? { name: fields["name"] } : {}),
                ...(fields["every"] ? { every: fields["every"] } : {}),
                ...(fields["cron"] ? { cron: fields["cron"] } : {}),
                ...(fields["offset"] ? { offset: fields["offset"] } : {}),
                ...(fields["description"] ? { description: fields["description"] } : {}),
                status: "active",
              },
            }),
          );
          return this.mapTask(accountId, t);
        }
        case T.dashboard: {
          const orgID = await this.orgId();
          const d = await this.v2((api) =>
            api.post("/api/v2/dashboards", {
              body: {
                orgID,
                name: (fields["name"] ?? "").trim(),
                ...(fields["description"] ? { description: fields["description"] } : {}),
              },
            }),
          );
          return this.inst(
            accountId,
            T.dashboard,
            d.id,
            d.name ?? d.id,
            compact({
              name: d.name,
              description: d.description,
              cells: 0,
              region: this.cloud?.region,
            }),
          );
        }
        case T.dedicatedDatabase: {
          const days = nonNegative(fields["retentionDays"] || "0", "Retention");
          const d = await this.mgmt((api) =>
            api.post("/databases", {
              body: {
                name: (fields["name"] ?? "").trim(),
                retentionPeriod: Math.round(days * NS_PER_DAY),
                ...(fields["maxTables"] ? { maxTables: Number(fields["maxTables"]) } : {}),
                ...(fields["maxColumnsPerTable"]
                  ? { maxColumnsPerTable: Number(fields["maxColumnsPerTable"]) }
                  : {}),
              },
            }),
          );
          return this.mapDedicatedDb(accountId, d);
        }
        case T.dedicatedToken: {
          const permission = (action: string, resource: string): DedicatedPermission => ({
            action,
            resource,
          });
          const permissions = [
            ...csv(fields["read"]).map((resource) => permission("read", resource)),
            ...csv(fields["write"]).map((resource) => permission("write", resource)),
          ];
          if (!permissions.length) throw new Error("Pick at least one database to read or write.");
          const t = await this.mgmt((api) =>
            api.post("/tokens", {
              body: {
                description: (fields["description"] ?? "").trim(),
                permissions,
                ...(fields["expiresAt"] ? { expiresAt: fields["expiresAt"] } : {}),
              },
            }),
          );
          const r = this.mapDedicatedToken(accountId, t);
          if (t.accessToken) r.resolvedOutputs["token"] = t.accessToken;
          return {
            resource: r,
            warnings: [
              {
                code: "token-shown-once",
                message: "Copy the token from its outputs now: it is not shown again.",
              },
            ],
          };
        }
        default:
          throw new Error(`InfluxDB Cloud plugin: creating "${typeId}" is not supported`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Update / delete
  // -------------------------------------------------------------------------

  private patchAlert(typeId: string, id: string, body: AlertUpdate): Promise<void> {
    const segment = pathEncode(id);
    return this.v2(async (api) => {
      if (typeId === T.check) await api.patch(`/api/v2/checks/${segment}`, { body });
      else if (typeId === T.rule) await api.patch(`/api/v2/notificationRules/${segment}`, { body });
      else await api.patch(`/api/v2/notificationEndpoints/${segment}`, { body });
    });
  }

  private deleteAlert(typeId: string, id: string): Promise<void> {
    const segment = pathEncode(id);
    return this.v2(async (api) => {
      if (typeId === T.check) await api.delete(`/api/v2/checks/${segment}`);
      else if (typeId === T.rule) await api.delete(`/api/v2/notificationRules/${segment}`);
      else await api.delete(`/api/v2/notificationEndpoints/${segment}`);
    });
  }

  private patchToken(id: string, body: ApiBody<operations["PatchAuthorizationsID"]>) {
    return this.v2((api) => api.patch(`/api/v2/authorizations/${pathEncode(id)}`, { body }));
  }

  private patchTask(id: string, body: ApiBody<operations["PatchTasksID"]>) {
    return this.v2((api) => api.patch(`/api/v2/tasks/${pathEncode(id)}`, { body }));
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      this.invalidate();
      const segment = pathEncode(ext);
      switch (typeId) {
        case T.bucket: {
          const rules =
            fields["retentionDays"] !== undefined && fields["retentionDays"] !== ""
              ? retentionRules(nonNegative(fields["retentionDays"], "Retention"))
              : undefined;
          await this.v2((api) =>
            api.patch(`/api/v2/buckets/${segment}`, {
              body: {
                name: fields["name"],
                description: fields["description"],
                retentionRules: rules,
              },
            }),
          );
          break;
        }
        case T.token:
          await this.patchToken(ext, {
            description: fields["description"],
            status: fields["status"],
          });
          break;
        case T.task:
          await this.patchTask(ext, {
            name: fields["name"],
            status: fields["status"],
            every: fields["every"],
            cron: fields["cron"],
            offset: fields["offset"],
            description: fields["description"],
          });
          break;
        case T.check:
        case T.rule:
        case T.endpoint:
          await this.patchAlert(typeId, ext, {
            name: fields["name"],
            description: fields["description"],
            status: fields["status"],
          });
          break;
        case T.dashboard:
          await this.v2((api) =>
            api.patch(`/api/v2/dashboards/${segment}`, {
              body: { name: fields["name"], description: fields["description"] },
            }),
          );
          break;
        case T.dedicatedDatabase: {
          const retentionPeriod = fields["retentionDays"]
            ? Math.round(nonNegative(fields["retentionDays"], "Retention") * NS_PER_DAY)
            : undefined;
          await this.mgmt((api) =>
            api.patch(`/databases/${segment}`, {
              body: {
                retentionPeriod,
                maxTables: fields["maxTables"] ? Number(fields["maxTables"]) : undefined,
                maxColumnsPerTable: fields["maxColumnsPerTable"]
                  ? Number(fields["maxColumnsPerTable"])
                  : undefined,
              },
            }),
          );
          break;
        }
        case T.dedicatedToken:
          await this.mgmt((api) =>
            api.patch(`/tokens/${segment}`, { body: { description: fields["description"] } }),
          );
          break;
        default:
          throw new Error(`InfluxDB Cloud plugin: updating "${typeId}" is not supported`);
      }
      this.invalidate();
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      const ext = pathEncode(externalIdOf(resourceId));
      this.invalidate();
      switch (typeId) {
        case T.bucket:
          return void (await this.v2((api) => api.delete(`/api/v2/buckets/${ext}`)));
        case T.token:
          return void (await this.v2((api) => api.delete(`/api/v2/authorizations/${ext}`)));
        case T.task:
          return void (await this.v2((api) => api.delete(`/api/v2/tasks/${ext}`)));
        case T.check:
        case T.rule:
        case T.endpoint:
          return this.deleteAlert(typeId, externalIdOf(resourceId));
        case T.dashboard:
          return void (await this.v2((api) => api.delete(`/api/v2/dashboards/${ext}`)));
        case T.telegraf:
          return void (await this.v2((api) => api.delete(`/api/v2/telegrafs/${ext}`)));
        case T.dedicatedDatabase:
          return void (await this.mgmt((api) => api.delete(`/databases/${ext}`)));
        case T.dedicatedToken:
          return void (await this.mgmt((api) => api.delete(`/tokens/${ext}`)));
        default:
          throw new Error(`InfluxDB Cloud plugin: deleting "${typeId}" is not supported`);
      }
    });
  }

  invokeAction(typeId: string, resourceId: string, actionId: string): PluginEffect<void> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      this.invalidate();
      if (actionId === "activate" || actionId === "deactivate") {
        const status = actionId === "activate" ? "active" : "inactive";
        if (typeId === T.token) await this.patchToken(ext, { status });
        else if (typeId === T.task) await this.patchTask(ext, { status });
        else await this.patchAlert(typeId, ext, { status });
        return;
      }
      if (typeId === T.task && actionId === "run") {
        await this.v2((api) => api.post(`/api/v2/tasks/${pathEncode(ext)}/runs`, { body: {} }));
        return;
      }
      throw new Error(`InfluxDB Cloud plugin: unknown action "${actionId}"`);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const form = decodePromptArgs(args);
      this.invalidate();
      if (typeId === T.task && command === "set-flux") {
        if (!form["flux"]?.trim()) throw new Error("The Flux cannot be empty.");
        await this.patchTask(externalIdOf(resourceId), { flux: form["flux"] });
        return { ok: true, message: "Flux saved." };
      }
      throw new Error(`InfluxDB Cloud plugin: command "${command}" is not supported`);
    });
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  private async bucketName(resourceId: string): Promise<string> {
    const ext = externalIdOf(resourceId);
    const b = (await this.buckets()).find((x) => x.id === ext);
    if (!b?.name) throw notFound(`bucket ${ext}`);
    return b.name;
  }

  executeQuery(
    resourceId: string,
    _accountId: string,
    query: string,
  ): PluginEffect<{ rows: Record<string, unknown>[]; durationMs: number }> {
    return attempt(async () => {
      const c = this.requireCloud();
      const started = Date.now();
      if (isFlux(query)) {
        const text = await influxText(
          this.t,
          "POST",
          `${c.host}/api/v2/query?orgID=${encodeURIComponent(await this.orgId())}`,
          {
            Authorization: `Token ${c.token}`,
            "Content-Type": "application/json",
            Accept: "application/csv",
          },
          JSON.stringify({
            query,
            type: "flux",
            dialect: { annotations: ["datatype", "group", "default"] },
          } satisfies ApiBody<operations["PostQuery"]>),
        );
        return { rows: parseAnnotatedCsv(text), durationMs: Date.now() - started };
      }
      const db = await this.bucketName(resourceId);
      const res = await influxCall(() =>
        c.api.get("/query", { query: { db, epoch: "ms", q: query } }),
      );
      const rows: Record<string, unknown>[] = [];
      for (const result of res?.results ?? []) {
        if (result.error) throw new Error(result.error);
        for (const s of result.series ?? []) {
          for (const v of s.values ?? []) {
            const row: Record<string, unknown> = {
              ...(s.name ? { measurement: s.name } : {}),
              ...(s.tags ?? {}),
            };
            (s.columns ?? []).forEach((col, i) => {
              row[col] = v[i];
            });
            rows.push(row);
          }
        }
      }
      return { rows, durationMs: Date.now() - started };
    });
  }

  introspectResource(resourceId: string, accountId: string): PluginEffect<SqlTableMeta[]> {
    return attempt(async () => {
      const measurements = await runPluginEffect(
        this.executeQuery(resourceId, accountId, "SHOW MEASUREMENTS"),
      );
      const names = measurements.rows
        .map((r) => String(r["name"] ?? ""))
        .filter(Boolean)
        .slice(0, 50);
      const out: SqlTableMeta[] = [];
      for (const name of names) {
        const quoted = `"${name.replace(/"/g, '\\"')}"`;
        const [fieldKeys, tagKeys] = await Promise.all([
          runPluginEffect(
            this.executeQuery(resourceId, accountId, `SHOW FIELD KEYS FROM ${quoted}`),
          ).catch(() => ({
            rows: [],
          })),
          runPluginEffect(
            this.executeQuery(resourceId, accountId, `SHOW TAG KEYS FROM ${quoted}`),
          ).catch(() => ({
            rows: [],
          })),
        ]);
        out.push({
          name,
          columns: [
            { name: "time", type: "timestamp" },
            ...tagKeys.rows.map((r) => ({ name: String(r["tagKey"] ?? ""), type: "tag" })),
            ...fieldKeys.rows.map((r) => ({
              name: String(r["fieldKey"] ?? ""),
              type: String(r["fieldType"] ?? "field"),
            })),
          ].filter((c) => c.name),
        });
      }
      return out;
    });
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (!this.cloud || (resourceTypeId !== T.bucket && resourceTypeId !== T.org)) return [];
      const end = timeRange?.endMs ?? Date.now();
      const start = timeRange?.startMs ?? end - METRICS_WINDOW_MS;
      let rows: Record<string, string>[];
      try {
        rows = await this.usageRows(Math.floor(start / 1000), Math.floor(end / 1000));
      } catch (err) {
        if (isUnavailable(err)) return [];
        throw err;
      }
      const ext = externalIdOf(resourceId);
      const groups = new Map<string, Map<number, number>>();
      for (const r of rows) {
        const t = Date.parse(r["_time"] ?? "");
        const v = Number(r["_value"]);
        if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
        let label: string;
        if (resourceTypeId === T.bucket) {
          if (r["bucket_id"] !== ext || r["_measurement"] !== "storage_usage_bucket_bytes")
            continue;
          label = "Storage";
        } else {
          label =
            r["_measurement"] === "storage_usage_bucket_bytes"
              ? "Storage (all buckets)"
              : `${r["_measurement"]} ${r["_field"] ?? ""}`.trim();
        }
        const series = groups.get(label) ?? new Map<number, number>();
        series.set(t, (series.get(t) ?? 0) + v);
        groups.set(label, series);
      }
      return [...groups.entries()].map(([label, points]) => ({
        label,
        ...(label.startsWith("Storage") ? { unit: "bytes" } : {}),
        points: [...points.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([timestamp, value]) => ({ timestamp, value })),
      }));
    });
  }

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      const f = r.fields;
      if (resourceTypeId === T.bucket) {
        const days = Number(f["retentionDays"] ?? 0);
        return [
          { label: "Retention", value: days ? `${days} d` : "Forever" },
          {
            label: "Storage",
            value:
              f["storageBytes"] !== undefined
                ? `${Math.round(Number(f["storageBytes"]) / 1048576)} MB`
                : "",
          },
        ];
      }
      const s = String(f["status"] ?? "");
      return [
        {
          label: "Status",
          value: s,
          variant: s === "active" ? "status-healthy" : s ? "status-degraded" : "default",
        },
      ];
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      const containers = ["Task log"];
      if (typeId !== T.task) return { text: "", containers, activeContainer: "Task log" };
      const res = await this.v2((api) =>
        api.get(`/api/v2/tasks/${pathEncode(externalIdOf(resourceId))}/logs`),
      );
      const events = (res?.events ?? []).slice(-(params.tailLines ?? 100));
      const text = events
        .map(
          (e) =>
            `${(e.time ?? "").replace("T", " ").replace(/Z$/, "")}  ${e.runID ?? ""}  ${e.message ?? ""}\n`,
        )
        .join("");
      return { text: text || "No task log yet.\n", containers, activeContainer: "Task log" };
    });
  }

  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      if (!this.cloud) return [];
      let limits;
      try {
        limits = (await this.limits())?.limits;
      } catch (err) {
        if (isUnavailable(err))
          throw new QuotaAccessError(
            "This organization's plan limits are not readable with this token.",
          );
        throw err;
      }
      const out: QuotaUsage[] = [];
      const push =
        (id: string, name: string, limit: number | undefined, used: () => Promise<number>) =>
        async () => {
          if (!limit || limit <= 0) return;
          out.push({
            id,
            service: "InfluxDB Cloud",
            name,
            region: this.cloud!.region,
            limit,
            used: await used(),
          });
        };
      await Promise.all([
        push(
          "buckets",
          "Buckets",
          limits?.bucket?.maxBuckets,
          async () => (await this.buckets()).filter((b) => b.type !== "system").length,
        )(),
        push("tasks", "Tasks", limits?.task?.maxTasks, async () => (await this.tasks()).length)(),
        push(
          "checks",
          "Checks",
          limits?.check?.maxChecks,
          async () => (await this.checks()).length,
        )(),
        push(
          "dashboards",
          "Dashboards",
          limits?.dashboard?.maxDashboards,
          async () => (await this.dashboards()).length,
        )(),
        push(
          "notification-rules",
          "Notification rules",
          limits?.notificationRule?.maxNotifications,
          async () => (await this.notificationRules()).length,
        )(),
      ]);
      return out;
    });
  }
}
