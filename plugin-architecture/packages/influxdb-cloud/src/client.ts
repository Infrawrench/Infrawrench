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
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import type { Transport } from "./api.js";
import {
  DEDICATED_API,
  hostFor,
  influxJson,
  influxText,
  isUnavailable,
  parseAnnotatedCsv,
  statusOf,
} from "./api.js";
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

interface V2Bucket {
  id: string;
  name?: string;
  description?: string;
  orgID?: string;
  retentionRules?: Array<{ everySeconds?: number }>;
  schemaType?: string;
  type?: string;
  createdAt?: string;
}
interface V2Auth {
  id: string;
  description?: string;
  status?: string;
  createdAt?: string;
  user?: string;
  token?: string;
  permissions?: Array<{
    action?: string;
    resource?: { type?: string; id?: string; name?: string };
  }>;
}
interface V2Task {
  id: string;
  name?: string;
  status?: string;
  every?: string;
  cron?: string;
  offset?: string;
  description?: string;
  flux?: string;
  lastRunStatus?: string;
  lastRunError?: string;
  latestCompleted?: string;
}
interface V2Alert {
  id: string;
  name?: string;
  description?: string;
  status?: string;
  type?: string;
  every?: string;
  endpointID?: string;
  url?: string;
  lastRunStatus?: string;
  lastRunError?: string;
}
interface DedicatedDb {
  name: string;
  clusterId?: string;
  maxTables?: number;
  maxColumnsPerTable?: number;
  retentionPeriod?: number;
  partitionTemplate?: Array<{ type?: string; value?: unknown }>;
}
interface DedicatedToken {
  id: string;
  description?: string;
  permissions?: Array<{ action?: string; resource?: string }>;
  createdAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  accessToken?: string;
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
      const parsed = JSON.parse(text) as unknown;
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
  const err = new Error(`InfluxDB Cloud plugin: ${what} not found`) as Error & { status: number };
  err.status = 404;
  return err;
}

/** Flux when the text pipes (`|>`) or imports; InfluxQL otherwise. */
export function isFlux(query: string): boolean {
  return /\|>/.test(query) || /^\s*import\s+"/.test(query);
}

export class InfluxClient implements PluginClient {
  private readonly t: Transport;
  private readonly cloud: { host: string; token: string; orgId: string; region: string } | null;
  private readonly dedicated: { accountId: string; clusterId: string; token: string } | null;
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.t = services?.http ? { http: services.http } : {};
    const token = (credentials["token"] ?? "").trim();
    const region = (credentials["region"] ?? "").trim();
    const orgId = (credentials["orgId"] ?? "").trim();
    this.cloud = token && region ? { host: hostFor(region), token, orgId, region } : null;
    const accountId = (credentials["dedicatedAccountId"] ?? "").trim();
    const clusterId = (credentials["dedicatedClusterId"] ?? "").trim();
    const mgmt = (credentials["dedicatedManagementToken"] ?? "").trim();
    this.dedicated = accountId && clusterId && mgmt ? { accountId, clusterId, token: mgmt } : null;
    if (!this.cloud && !this.dedicated) {
      throw new Error(
        "InfluxDB Cloud plugin: give a region and API token, or the three Cloud Dedicated fields",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private cached<V>(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<V>;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private invalidate(): void {
    this.cache.clear();
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

  private v2<V>(method: string, path: string, body?: unknown): Promise<V> {
    const c = this.requireCloud();
    return influxJson<V>(this.t, method, `${c.host}${path}`, `Token ${c.token}`, body);
  }

  private mgmt<V>(method: string, path: string, body?: unknown): Promise<V> {
    const d = this.requireDedicated();
    return influxJson<V>(
      this.t,
      method,
      `${DEDICATED_API}/accounts/${encodeURIComponent(d.accountId)}/clusters/${encodeURIComponent(d.clusterId)}${path}`,
      `Bearer ${d.token}`,
      body,
    );
  }

  /** The organization: the configured one, or the token's only one. */
  async orgId(): Promise<string> {
    const c = this.requireCloud();
    if (c.orgId) return c.orgId;
    return this.cached("org-id", async () => {
      const res = await this.v2<{ orgs?: Array<{ id: string }> }>("GET", "/api/v2/orgs");
      const id = res?.orgs?.[0]?.id;
      if (!id) throw new Error("The token can see no organization.");
      return id;
    });
  }

  private async paged<V>(path: string, key: string, extra = ""): Promise<V[]> {
    const org = await this.orgId();
    const out: V[] = [];
    for (let page = 0; page < 50; page++) {
      const res = await this.v2<Record<string, V[] | undefined>>(
        "GET",
        `${path}?orgID=${encodeURIComponent(org)}&limit=100&offset=${page * 100}${extra}`,
      );
      const batch = res?.[key] ?? [];
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  buckets(): Promise<V2Bucket[]> {
    return this.cached("buckets", () => this.paged<V2Bucket>("/api/v2/buckets", "buckets"));
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
    return this.cached("storage", async () => {
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
    const text = await influxText(
      this.t,
      "GET",
      `${c.host}/api/v2/orgs/${encodeURIComponent(org)}/usage?start=${start}&stop=${stop}`,
      { Authorization: `Token ${c.token}`, Accept: "text/csv" },
    );
    return parseAnnotatedCsv(text);
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

  private mapBucket(accountId: string, b: V2Bucket, storage?: number): ResourceInstance {
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

  private describePermissions(a: V2Auth): { text: string; allAccess: boolean } {
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

  private mapAuth(accountId: string, a: V2Auth): ResourceInstance {
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

  private mapTask(accountId: string, t: V2Task): ResourceInstance {
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

  private mapAlert(accountId: string, typeId: string, a: V2Alert): ResourceInstance {
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

  private mapDedicatedDb(accountId: string, d: DedicatedDb): ResourceInstance {
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

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const cloudType = typeId !== T.dedicatedDatabase && typeId !== T.dedicatedToken;
    if (cloudType && !this.cloud) return [];
    if (!cloudType && !this.dedicated) return [];
    switch (typeId) {
      case T.org: {
        const org = await this.orgId();
        const [o, limits] = await Promise.all([
          this.v2<{
            id: string;
            name?: string;
            defaultStorageType?: string;
            status?: string;
            createdAt?: string;
          }>("GET", `/api/v2/orgs/${encodeURIComponent(org)}`),
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
        const res = await this.v2<{ authorizations?: V2Auth[] }>(
          "GET",
          `/api/v2/authorizations?orgID=${encodeURIComponent(org)}`,
        );
        return (res?.authorizations ?? []).map((a) => this.mapAuth(accountId, a));
      }
      case T.task:
        return (
          await this.optionalList(() => this.paged<V2Task>("/api/v2/tasks", "tasks", "&type=basic"))
        ).map((t) => this.mapTask(accountId, t));
      case T.check:
        return (await this.optionalList(() => this.paged<V2Alert>("/api/v2/checks", "checks"))).map(
          (a) => this.mapAlert(accountId, T.check, a),
        );
      case T.rule:
        return (
          await this.optionalList(() =>
            this.paged<V2Alert>("/api/v2/notificationRules", "notificationRules"),
          )
        ).map((a) => this.mapAlert(accountId, T.rule, a));
      case T.endpoint:
        return (
          await this.optionalList(() =>
            this.paged<V2Alert>("/api/v2/notificationEndpoints", "notificationEndpoints"),
          )
        ).map((a) => this.mapAlert(accountId, T.endpoint, a));
      case T.dashboard:
        return (
          await this.optionalList(() =>
            this.paged<{
              id: string;
              name?: string;
              description?: string;
              cells?: unknown[];
              meta?: { updatedAt?: string };
            }>("/api/v2/dashboards", "dashboards"),
          )
        ).map((d) =>
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
          const r = await this.v2<{
            configurations?: Array<{
              id: string;
              name?: string;
              description?: string;
              metadata?: { buckets?: string[] };
            }>;
          }>("GET", `/api/v2/telegrafs?orgID=${encodeURIComponent(org)}`);
          return r?.configurations ?? [];
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
        return ((await this.mgmt<DedicatedDb[]>("GET", "/databases")) ?? []).map((d) =>
          this.mapDedicatedDb(accountId, d),
        );
      case T.dedicatedToken:
        return ((await this.mgmt<DedicatedToken[]>("GET", "/tokens")) ?? [])
          .filter((t) => !t.revokedAt)
          .map((t) => this.mapDedicatedToken(accountId, t));
      default:
        throw new Error(`InfluxDB Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  private limits() {
    return this.cached("limits", async () => {
      const org = await this.orgId();
      return this.v2<{
        limits?: {
          bucket?: { maxBuckets?: number; maxRetentionDuration?: number };
          check?: { maxChecks?: number };
          dashboard?: { maxDashboards?: number };
          task?: { maxTasks?: number };
          notificationRule?: { maxNotifications?: number };
          rate?: { writeKBs?: number; readKBs?: number; cardinality?: number };
        };
      }>("GET", `/api/v2/orgs/${encodeURIComponent(org)}/limits`);
    });
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const found = (await this.listResources(typeId, accountId)).find((r) => r.externalId === ext);
    if (!found) throw notFound(`${typeId} ${ext}`);
    return found;
  }

  async resolveOutput(typeId: string, _resourceId: string, outputKey: string): Promise<string> {
    if (outputKey === "token" && (typeId === T.token || typeId === T.dedicatedToken)) {
      throw new Error(
        "InfluxDB shows a token only when it is created. Create a new token to get one.",
      );
    }
    throw new Error(`InfluxDB Cloud plugin: cannot resolve "${outputKey}" for "${typeId}"`);
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== T.task) return resource;
    const task = await this.v2<V2Task>(
      "GET",
      `/api/v2/tasks/${encodeURIComponent(resource.externalId ?? "")}`,
    );
    return {
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, [ENRICH.flux]: task?.flux ?? "" },
    };
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

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
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
            { key: "cron", label: "Cron", kind: "text", required: false, placeholder: "0 * * * *" },
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
        const dbs = ((await this.mgmt<DedicatedDb[]>("GET", "/databases")) ?? []).map((d) => ({
          id: d.name,
          label: d.name,
        }));
        const all = [{ id: "*", label: "All databases" }, ...dbs];
        return {
          fields: [
            { key: "description", label: "Description", kind: "text", required: true },
            { key: "read", label: "Read", kind: "policy-picker", required: false, policies: all },
            { key: "write", label: "Write", kind: "policy-picker", required: false, policies: all },
            { key: "expiresAt", label: "Expires (optional)", kind: "datetime", required: false },
          ],
        };
      }
      default:
        throw new Error(`InfluxDB Cloud plugin: creating "${typeId}" is not supported`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance | ResourceCreateResult> {
    this.invalidate();
    switch (typeId) {
      case T.bucket: {
        const days = nonNegative(fields["retentionDays"] ?? "0", "Retention");
        const b = await this.v2<V2Bucket>("POST", "/api/v2/buckets", {
          orgID: await this.orgId(),
          name: (fields["name"] ?? "").trim(),
          ...(fields["description"] ? { description: fields["description"] } : {}),
          retentionRules:
            days > 0 ? [{ type: "expire", everySeconds: Math.round(days * DAY) }] : [],
        });
        return this.mapBucket(accountId, b);
      }
      case T.token: {
        const org = await this.orgId();
        const permissions: Array<{ action: string; resource: Record<string, string> }> = [];
        for (const id of csv(fields["readBuckets"]))
          permissions.push({ action: "read", resource: { type: "buckets", id, orgID: org } });
        for (const id of csv(fields["writeBuckets"]))
          permissions.push({ action: "write", resource: { type: "buckets", id, orgID: org } });
        for (const p of csv(fields["other"])) {
          const [type, action] = p.split(":");
          if (type && action) permissions.push({ action, resource: { type, orgID: org } });
        }
        if (!permissions.length) throw new Error("Pick at least one permission.");
        const a = await this.v2<V2Auth>("POST", "/api/v2/authorizations", {
          orgID: org,
          description: (fields["description"] ?? "").trim(),
          permissions,
        });
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
        const t = await this.v2<V2Task>("POST", "/api/v2/tasks", {
          orgID: await this.orgId(),
          flux,
          ...(fields["name"] ? { name: fields["name"] } : {}),
          ...(fields["every"] ? { every: fields["every"] } : {}),
          ...(fields["cron"] ? { cron: fields["cron"] } : {}),
          ...(fields["offset"] ? { offset: fields["offset"] } : {}),
          ...(fields["description"] ? { description: fields["description"] } : {}),
          status: "active",
        });
        return this.mapTask(accountId, t);
      }
      case T.dashboard: {
        const d = await this.v2<{ id: string; name?: string; description?: string }>(
          "POST",
          "/api/v2/dashboards",
          {
            orgID: await this.orgId(),
            name: (fields["name"] ?? "").trim(),
            ...(fields["description"] ? { description: fields["description"] } : {}),
          },
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
        const d = await this.mgmt<DedicatedDb>("POST", "/databases", {
          name: (fields["name"] ?? "").trim(),
          retentionPeriod: Math.round(days * NS_PER_DAY),
          ...(fields["maxTables"] ? { maxTables: Number(fields["maxTables"]) } : {}),
          ...(fields["maxColumnsPerTable"]
            ? { maxColumnsPerTable: Number(fields["maxColumnsPerTable"]) }
            : {}),
        });
        return this.mapDedicatedDb(accountId, d);
      }
      case T.dedicatedToken: {
        const permissions = [
          ...csv(fields["read"]).map((resource) => ({ action: "read", resource })),
          ...csv(fields["write"]).map((resource) => ({ action: "write", resource })),
        ];
        if (!permissions.length) throw new Error("Pick at least one database to read or write.");
        const t = await this.mgmt<DedicatedToken>("POST", "/tokens", {
          description: (fields["description"] ?? "").trim(),
          permissions,
          ...(fields["expiresAt"] ? { expiresAt: fields["expiresAt"] } : {}),
        });
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
  }

  // -------------------------------------------------------------------------
  // Update / delete
  // -------------------------------------------------------------------------

  private alertPath(typeId: string, id: string): string {
    const base =
      typeId === T.check
        ? "checks"
        : typeId === T.rule
          ? "notificationRules"
          : "notificationEndpoints";
    return `/api/v2/${base}/${encodeURIComponent(id)}`;
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    const pick = (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]]));
    switch (typeId) {
      case T.bucket: {
        const body: Record<string, unknown> = pick(["name", "description"]);
        if (fields["retentionDays"] !== undefined && fields["retentionDays"] !== "") {
          const days = nonNegative(fields["retentionDays"], "Retention");
          body["retentionRules"] =
            days > 0 ? [{ type: "expire", everySeconds: Math.round(days * DAY) }] : [];
        }
        await this.v2("PATCH", `/api/v2/buckets/${encodeURIComponent(ext)}`, body);
        break;
      }
      case T.token:
        await this.v2(
          "PATCH",
          `/api/v2/authorizations/${encodeURIComponent(ext)}`,
          pick(["description", "status"]),
        );
        break;
      case T.task:
        await this.v2(
          "PATCH",
          `/api/v2/tasks/${encodeURIComponent(ext)}`,
          pick(["name", "status", "every", "cron", "offset", "description"]),
        );
        break;
      case T.check:
      case T.rule:
      case T.endpoint:
        await this.v2(
          "PATCH",
          this.alertPath(typeId, ext),
          pick(["name", "description", "status"]),
        );
        break;
      case T.dashboard:
        await this.v2(
          "PATCH",
          `/api/v2/dashboards/${encodeURIComponent(ext)}`,
          pick(["name", "description"]),
        );
        break;
      case T.dedicatedDatabase: {
        const body: Record<string, number> = {};
        if (fields["retentionDays"])
          body["retentionPeriod"] = Math.round(
            nonNegative(fields["retentionDays"], "Retention") * NS_PER_DAY,
          );
        if (fields["maxTables"]) body["maxTables"] = Number(fields["maxTables"]);
        if (fields["maxColumnsPerTable"])
          body["maxColumnsPerTable"] = Number(fields["maxColumnsPerTable"]);
        await this.mgmt("PATCH", `/databases/${encodeURIComponent(ext)}`, body);
        break;
      }
      case T.dedicatedToken:
        await this.mgmt("PATCH", `/tokens/${encodeURIComponent(ext)}`, pick(["description"]));
        break;
      default:
        throw new Error(`InfluxDB Cloud plugin: updating "${typeId}" is not supported`);
    }
    this.invalidate();
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const ext = encodeURIComponent(externalIdOf(resourceId));
    this.invalidate();
    switch (typeId) {
      case T.bucket:
        return void (await this.v2("DELETE", `/api/v2/buckets/${ext}`));
      case T.token:
        return void (await this.v2("DELETE", `/api/v2/authorizations/${ext}`));
      case T.task:
        return void (await this.v2("DELETE", `/api/v2/tasks/${ext}`));
      case T.check:
      case T.rule:
      case T.endpoint:
        return void (await this.v2("DELETE", this.alertPath(typeId, externalIdOf(resourceId))));
      case T.dashboard:
        return void (await this.v2("DELETE", `/api/v2/dashboards/${ext}`));
      case T.telegraf:
        return void (await this.v2("DELETE", `/api/v2/telegrafs/${ext}`));
      case T.dedicatedDatabase:
        return void (await this.mgmt("DELETE", `/databases/${ext}`));
      case T.dedicatedToken:
        return void (await this.mgmt("DELETE", `/tokens/${ext}`));
      default:
        throw new Error(`InfluxDB Cloud plugin: deleting "${typeId}" is not supported`);
    }
  }

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    if (actionId === "activate" || actionId === "deactivate") {
      const status = actionId === "activate" ? "active" : "inactive";
      const path =
        typeId === T.token
          ? `/api/v2/authorizations/${encodeURIComponent(ext)}`
          : typeId === T.task
            ? `/api/v2/tasks/${encodeURIComponent(ext)}`
            : this.alertPath(typeId, ext);
      await this.v2("PATCH", path, { status });
      return;
    }
    if (typeId === T.task && actionId === "run") {
      await this.v2("POST", `/api/v2/tasks/${encodeURIComponent(ext)}/runs`, {});
      return;
    }
    throw new Error(`InfluxDB Cloud plugin: unknown action "${actionId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const form = decodePromptArgs(args);
    this.invalidate();
    if (typeId === T.task && command === "set-flux") {
      if (!form["flux"]?.trim()) throw new Error("The Flux cannot be empty.");
      await this.v2("PATCH", `/api/v2/tasks/${encodeURIComponent(externalIdOf(resourceId))}`, {
        flux: form["flux"],
      });
      return { ok: true, message: "Flux saved." };
    }
    throw new Error(`InfluxDB Cloud plugin: command "${command}" is not supported`);
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

  async executeQuery(
    resourceId: string,
    _accountId: string,
    query: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
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
        }),
      );
      return { rows: parseAnnotatedCsv(text), durationMs: Date.now() - started };
    }
    const db = await this.bucketName(resourceId);
    const res = await influxJson<{
      results?: Array<{
        error?: string;
        series?: Array<{
          name?: string;
          columns?: string[];
          values?: unknown[][];
          tags?: Record<string, string>;
        }>;
      }>;
    }>(
      this.t,
      "GET",
      `${c.host}/query?db=${encodeURIComponent(db)}&epoch=ms&q=${encodeURIComponent(query)}`,
      `Token ${c.token}`,
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
  }

  async introspectResource(resourceId: string, accountId: string): Promise<SqlTableMeta[]> {
    const measurements = await this.executeQuery(resourceId, accountId, "SHOW MEASUREMENTS");
    const names = measurements.rows
      .map((r) => String(r["name"] ?? ""))
      .filter(Boolean)
      .slice(0, 50);
    const out: SqlTableMeta[] = [];
    for (const name of names) {
      const quoted = `"${name.replace(/"/g, '\\"')}"`;
      const [fieldKeys, tagKeys] = await Promise.all([
        this.executeQuery(resourceId, accountId, `SHOW FIELD KEYS FROM ${quoted}`).catch(() => ({
          rows: [],
        })),
        this.executeQuery(resourceId, accountId, `SHOW TAG KEYS FROM ${quoted}`).catch(() => ({
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
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
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
        if (r["bucket_id"] !== ext || r["_measurement"] !== "storage_usage_bucket_bytes") continue;
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
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
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
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const containers = ["Task log"];
    if (typeId !== T.task) return { text: "", containers, activeContainer: "Task log" };
    const res = await this.v2<{
      events?: Array<{ time?: string; runID?: string; message?: string }>;
    }>("GET", `/api/v2/tasks/${encodeURIComponent(externalIdOf(resourceId))}/logs`);
    const events = (res?.events ?? []).slice(-(params.tailLines ?? 100));
    const text = events
      .map(
        (e) =>
          `${(e.time ?? "").replace("T", " ").replace(/Z$/, "")}  ${e.runID ?? ""}  ${e.message ?? ""}\n`,
      )
      .join("");
    return { text: text || "No task log yet.\n", containers, activeContainer: "Task log" };
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
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
      push(
        "tasks",
        "Tasks",
        limits?.task?.maxTasks,
        async () => (await this.paged<V2Task>("/api/v2/tasks", "tasks", "&type=basic")).length,
      )(),
      push(
        "checks",
        "Checks",
        limits?.check?.maxChecks,
        async () => (await this.paged<V2Alert>("/api/v2/checks", "checks")).length,
      )(),
      push(
        "dashboards",
        "Dashboards",
        limits?.dashboard?.maxDashboards,
        async () => (await this.paged<V2Alert>("/api/v2/dashboards", "dashboards")).length,
      )(),
      push(
        "notification-rules",
        "Notification rules",
        limits?.notificationRule?.maxNotifications,
        async () =>
          (await this.paged<V2Alert>("/api/v2/notificationRules", "notificationRules")).length,
      )(),
    ]);
    return out;
  }
}
