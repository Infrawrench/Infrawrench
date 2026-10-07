import type {
  CostFetchRange,
  CostFetchResult,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PublishMessagePayload,
  PublishMessageResult,
  QuotaUsage,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf, withMetricsCapability } from "@infrawrench/plugin-base";
import type { UpstashContext } from "./api.js";
import { devFetch, qstashBase, qstashFetch } from "./api.js";
import { fetchUpstashCostData } from "./cost-data.js";
import {
  iso,
  mapQStash,
  mapQueue,
  mapRedis,
  mapSchedule,
  mapSearch,
  mapTeam,
  mapUrlGroup,
  mapVector,
  instance,
  pointsToSeries,
  redisConnectionString,
  redisHost,
  splitChild,
} from "./mappers.js";
import { ENRICH, renderUpstashDetail, renderUpstashSidebar } from "./render.js";
import { REDIS_PLANS, REDIS_REGIONS, RESOURCE_TYPES, T } from "./resource-types.js";
import type {
  Point,
  UpAuditLog,
  UpBackup,
  UpDlqMessage,
  UpIndexStats,
  UpLog,
  UpQStashStats,
  UpQStashUser,
  UpQueue,
  UpRedis,
  UpRedisStats,
  UpSchedule,
  UpSearch,
  UpTeam,
  UpTeamMember,
  UpUrlGroup,
  UpVector,
} from "./types.js";

const CACHE_MS = 20_000;
export const METRICS_WINDOW_MS = 60 * 60 * 1000;

function bool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function list(raw: string | undefined): string[] {
  const s = String(raw ?? "").trim();
  if (s.startsWith("[")) {
    try {
      return (JSON.parse(s) as unknown[]).map(String).filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  return s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function stamp(ms: number | undefined): string {
  const s = iso(ms);
  return s ? s.replace("T", " ").slice(0, 19) : "";
}

/** The stats `period` that covers a time range (Upstash returns 60 points per period). */
export function statsPeriod(rangeMs: number): string {
  const h = 3_600_000;
  if (rangeMs <= h) return "1h";
  if (rangeMs <= 3 * h) return "3h";
  if (rangeMs <= 12 * h) return "12h";
  if (rangeMs <= 24 * h) return "1d";
  if (rangeMs <= 72 * h) return "3d";
  if (rangeMs <= 168 * h) return "7d";
  return "30d";
}

function notFound(what: string): Error {
  const err = new Error(`Upstash plugin: ${what} not found`) as Error & { status: number };
  err.status = 404;
  return err;
}

export class UpstashClient implements PluginClient {
  readonly ctx: UpstashContext;
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const email = (credentials["email"] ?? "").trim();
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!email) throw new Error("Upstash plugin: missing email credential");
    if (!apiKey) throw new Error("Upstash plugin: missing apiKey credential");
    const caCert = (credentials["caCert"] ?? "").trim();
    this.ctx = {
      email,
      apiKey,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

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

  private dev<V>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<V> {
    return devFetch<V>(this.ctx, method, path, {
      ...(body !== undefined ? { body } : {}),
      ...(query ? { query } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Listings
  // -------------------------------------------------------------------------

  private redisList() {
    return this.cached(
      "redis",
      async () => (await this.dev<UpRedis[]>("GET", "/redis/databases")) ?? [],
    );
  }
  private vectorList() {
    return this.cached(
      "vector",
      async () => (await this.dev<UpVector[]>("GET", "/vector/index")) ?? [],
    );
  }
  private searchList() {
    return this.cached("search", async () => (await this.dev<UpSearch[]>("GET", "/search")) ?? []);
  }
  private teams() {
    return this.cached("teams", async () => (await this.dev<UpTeam[]>("GET", "/teams")) ?? []);
  }
  /** Regional QStash accounts, including their tokens. */
  qstashUsers() {
    return this.cached("qstash", async () =>
      ((await this.dev<UpQStashUser[]>("GET", "/qstash/users")) ?? []).filter(
        (u) => !u.deletion_time,
      ),
    );
  }

  private async qstashAccount(id: string): Promise<UpQStashUser & { token: string }> {
    const user = (await this.qstashUsers()).find((u) => u.id === id);
    if (!user?.token) throw notFound(`QStash account ${id}`);
    return user as UpQStashUser & { token: string };
  }

  private async q<V>(
    qstashId: string,
    method: string,
    path: string,
    options: Parameters<typeof qstashFetch>[4] = {},
  ): Promise<V> {
    const acct = await this.qstashAccount(qstashId);
    return qstashFetch<V>(
      this.ctx,
      { token: acct.token, region: acct.region },
      method,
      path,
      options,
    );
  }

  private async perQStash<V>(
    key: string,
    load: (id: string) => Promise<V[]>,
  ): Promise<Array<{ qstashId: string; item: V }>> {
    return this.cached(key, async () => {
      const out: Array<{ qstashId: string; item: V }> = [];
      for (const u of await this.qstashUsers()) {
        if (!u.id) continue;
        for (const item of (await load(u.id)) ?? []) out.push({ qstashId: u.id, item });
      }
      return out;
    });
  }

  private schedules() {
    return this.perQStash<UpSchedule>("schedules", (id) =>
      this.q<UpSchedule[]>(id, "GET", "/v2/schedules"),
    );
  }
  private queues() {
    return this.perQStash<UpQueue>("queues", (id) => this.q<UpQueue[]>(id, "GET", "/v2/queues"));
  }
  private urlGroups() {
    return this.perQStash<UpUrlGroup>("groups", (id) =>
      this.q<UpUrlGroup[]>(id, "GET", "/v2/topics"),
    );
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case T.account: {
        const [redis, vector, search, teams] = await Promise.all([
          this.redisList().catch(() => undefined),
          this.vectorList().catch(() => undefined),
          this.searchList().catch(() => undefined),
          this.teams().catch(() => undefined),
        ]);
        return [
          instance(accountId, T.account, this.ctx.email, this.ctx.email, {
            email: this.ctx.email,
            redisCount: redis?.length,
            vectorCount: vector?.length,
            searchCount: search?.length,
            teamCount: teams?.length,
          }),
        ];
      }
      case T.redis:
        return (await this.redisList()).map((d) => mapRedis(accountId, d));
      case T.vector:
        return (await this.vectorList()).map((v) => mapVector(accountId, v));
      case T.search:
        return (await this.searchList()).map((s) => mapSearch(accountId, s));
      case T.qstash:
        return (await this.qstashUsers()).map((u) => mapQStash(accountId, u));
      case T.schedule:
        return (await this.schedules()).map(({ qstashId, item }) =>
          mapSchedule(accountId, qstashId, item),
        );
      case T.queue:
        return (await this.queues()).map(({ qstashId, item }) =>
          mapQueue(accountId, qstashId, item),
        );
      case T.urlGroup:
        return (await this.urlGroups()).map(({ qstashId, item }) =>
          mapUrlGroup(accountId, qstashId, item),
        );
      case T.team: {
        const teams = await this.teams();
        return Promise.all(
          teams.map(async (t) => {
            const members = await this.dev<UpTeamMember[]>(
              "GET",
              `/teams/${encodeURIComponent(t.team_id ?? "")}`,
            ).catch(() => undefined);
            const me = members?.find(
              (m) => m.member_email?.toLowerCase() === this.ctx.email.toLowerCase(),
            );
            return mapTeam(accountId, t, members?.length, me?.member_role);
          }),
        );
      }
      default:
        throw new Error(`Upstash plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    switch (typeId) {
      case T.redis:
        return mapRedis(accountId, await this.redis(ext));
      case T.vector:
        return mapVector(
          accountId,
          await this.dev<UpVector>("GET", `/vector/index/${encodeURIComponent(ext)}`),
        );
      case T.search:
        return mapSearch(
          accountId,
          await this.dev<UpSearch>("GET", `/search/${encodeURIComponent(ext)}`),
        );
      case T.schedule: {
        const { qstashId, key } = splitChild(ext);
        const s = await this.q<UpSchedule>(
          qstashId,
          "GET",
          `/v2/schedules/${encodeURIComponent(key)}`,
        );
        return mapSchedule(accountId, qstashId, s);
      }
      case T.queue: {
        const { qstashId, key } = splitChild(ext);
        const q = await this.q<UpQueue>(qstashId, "GET", `/v2/queues/${encodeURIComponent(key)}`);
        return mapQueue(accountId, qstashId, q);
      }
      case T.urlGroup: {
        const { qstashId, key } = splitChild(ext);
        const g = await this.q<UpUrlGroup>(
          qstashId,
          "GET",
          `/v2/topics/${encodeURIComponent(key)}`,
        );
        return mapUrlGroup(accountId, qstashId, g);
      }
      default: {
        const found = (await this.listResources(typeId, accountId)).find(
          (r) => r.id === resourceId,
        );
        if (!found) throw notFound(`${typeId}/${ext}`);
        return found;
      }
    }
  }

  private redis(id: string): Promise<UpRedis> {
    return this.dev<UpRedis>("GET", `/redis/database/${encodeURIComponent(id)}`);
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    const ext = externalIdOf(resourceId);
    switch (typeId) {
      case T.redis: {
        const db = await this.redis(ext);
        const host = redisHost(db.endpoint);
        const values: Record<string, string> = {
          host,
          port: String(db.port ?? 6379),
          password: db.password ?? "",
          connectionString: redisConnectionString(db),
          restUrl: host ? `https://${host}` : "",
          restToken: db.rest_token ?? "",
          readOnlyRestToken: db.read_only_rest_token ?? "",
        };
        if (outputKey in values) return values[outputKey]!;
        break;
      }
      case T.vector:
      case T.search: {
        const idx = await this.dev<UpVector | UpSearch>(
          "GET",
          typeId === T.vector
            ? `/vector/index/${encodeURIComponent(ext)}`
            : `/search/${encodeURIComponent(ext)}`,
        );
        const host = idx.endpoint ?? "";
        const values: Record<string, string> = {
          restUrl: host ? (host.startsWith("http") ? host : `https://${host}`) : "",
          token: idx.token ?? "",
          readOnlyToken: idx.read_only_token ?? "",
        };
        if (outputKey in values) return values[outputKey]!;
        break;
      }
      case T.qstash: {
        const acct = await this.qstashAccount(ext);
        if (outputKey === "url") return qstashBase(acct.region);
        if (outputKey === "token") return acct.token;
        if (outputKey === "readOnlyToken") return acct.read_only_token ?? "";
        if (outputKey === "currentSigningKey" || outputKey === "nextSigningKey") {
          const keys = await this.q<{ current?: string; next?: string }>(ext, "GET", "/v2/keys");
          return (outputKey === "currentSigningKey" ? keys?.current : keys?.next) ?? "";
        }
        break;
      }
    }
    throw new Error(`Upstash plugin: cannot resolve "${outputKey}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const out: ResourceInstance = { ...resource, resolvedOutputs: { ...resource.resolvedOutputs } };
    const put = (key: string, value: unknown) => {
      if (value !== undefined) out.resolvedOutputs[key] = JSON.stringify(value);
    };
    const settle = async <V>(p: Promise<V>): Promise<V | undefined> => {
      try {
        return await p;
      } catch {
        return undefined;
      }
    };
    const ext = resource.externalId ?? externalIdOf(resource.id);
    const teamOptions = async () =>
      (await settle(this.teams()))?.map((t) => ({
        id: t.team_id ?? "",
        label: t.team_name ?? t.team_id ?? "",
      }));
    switch (resource.resourceTypeId) {
      case T.redis: {
        const [stats, backups, teams] = await Promise.all([
          settle(this.dev<UpRedisStats>("GET", `/redis/stats/${encodeURIComponent(ext)}`)),
          settle(this.dev<UpBackup[]>("GET", `/redis/list-backup/${encodeURIComponent(ext)}`)),
          teamOptions(),
        ]);
        if (stats) {
          put(ENRICH.stats, {
            storage: stats.current_storage,
            monthlyRequests: stats.total_monthly_requests,
            monthlyBandwidth: stats.total_monthly_bandwidth,
            monthlyCost: stats.total_monthly_billing,
            todayCommands: stats.daily_net_commands,
          });
        }
        put(
          ENRICH.backups,
          backups
            ?.slice()
            .sort((a, b) => Number(b.creation_time ?? 0) - Number(a.creation_time ?? 0))
            .map((b) => ({
              id: b.backup_id ?? "",
              name: b.name ?? b.backup_id ?? "",
              state: b.state ?? "",
              created: stamp(b.creation_time),
              size: b.backup_size ? `${Math.round(b.backup_size / 1024)} KB` : "",
            })),
        );
        put(ENRICH.teams, teams);
        break;
      }
      case T.vector:
      case T.search: {
        const base =
          resource.resourceTypeId === T.vector
            ? `/vector/index/${encodeURIComponent(ext)}`
            : `/search/${encodeURIComponent(ext)}`;
        const [stats, teams] = await Promise.all([
          settle(this.dev<UpIndexStats>("GET", `${base}/stats`, undefined, { period: "1d" })),
          teamOptions(),
        ]);
        if (stats) {
          put(ENRICH.stats, {
            count: stats.current_vector_count,
            pending: stats.pending_index_count,
            dailyQueries: stats.daily_query_count,
            monthlyQueries: stats.monthly_query_count,
            monthlyUpdates: stats.monthly_update_count,
            bandwidth: stats.monthly_bandwidth_usage,
            storage: stats.storage_usage,
            monthlyCost: stats.monthly_cost,
          });
        }
        put(ENRICH.teams, teams);
        break;
      }
      case T.qstash: {
        const [dlq, schedules, queues, groups, teams, stats] = await Promise.all([
          settle(
            this.q<{ messages?: UpDlqMessage[] }>(ext, "GET", "/v2/dlq", { query: { count: 25 } }),
          ),
          settle(this.q<UpSchedule[]>(ext, "GET", "/v2/schedules")),
          settle(this.q<UpQueue[]>(ext, "GET", "/v2/queues")),
          settle(this.q<UpUrlGroup[]>(ext, "GET", "/v2/topics")),
          teamOptions(),
          settle(
            this.dev<UpQStashStats>("GET", `/qstash/stats/${encodeURIComponent(ext)}`, undefined, {
              period: "30d",
            }),
          ),
        ]);
        put(
          ENRICH.dlq,
          dlq?.messages?.map((m) => ({
            id: m.dlqId ?? "",
            url: m.url ?? "",
            status: m.responseStatus !== undefined ? String(m.responseStatus) : "",
            created: stamp(m.createdAt),
            source: m.scheduleId
              ? `schedule ${m.scheduleId}`
              : m.queueName
                ? `queue ${m.queueName}`
                : m.topicName
                  ? `group ${m.topicName}`
                  : "",
          })),
        );
        put(ENRICH.counts, {
          schedules: schedules?.length,
          queues: queues?.length,
          groups: groups?.length,
        });
        put(ENRICH.teams, teams);
        if (stats?.daily_billings?.length) {
          put(ENRICH.stats, {
            monthlyCost: stats.daily_billings.reduce((n, p) => n + Number(p.y ?? 0), 0),
          });
        }
        break;
      }
      case T.team: {
        const members = await settle(
          this.dev<UpTeamMember[]>("GET", `/teams/${encodeURIComponent(ext)}`),
        );
        put(
          ENRICH.members,
          members?.map((m) => ({ email: m.member_email ?? "", role: m.member_role ?? "" })),
        );
        break;
      }
    }
    return out;
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderUpstashDetail(resource),
      RESOURCE_TYPES,
      resource.resourceTypeId,
      METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderUpstashSidebar(resource);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async qstashField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const users = await this.qstashUsers();
    return [
      {
        key: "qstashId",
        label: "QStash region",
        kind: "select",
        required: true,
        options: users.map((u) => ({
          id: u.id ?? "",
          label: u.region ?? u.id ?? "",
          description: u.type ?? "",
        })),
        defaultValue: users[0]?.id ?? "",
      },
    ];
  }

  private qstashOf(fields: Record<string, string>, parentResourceId?: string): string {
    const id = fields["qstashId"] || (parentResourceId ? externalIdOf(parentResourceId) : "");
    if (!id) throw new Error("Pick a QStash region.");
    return id;
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case T.redis:
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "my-cache" },
            {
              key: "platform",
              label: "Cloud",
              kind: "select",
              required: true,
              defaultValue: "aws",
              options: [
                { id: "aws", label: "AWS" },
                { id: "gcp", label: "Google Cloud" },
              ],
            },
            {
              key: "region",
              label: "Primary region",
              kind: "region-picker",
              required: true,
              regions: REDIS_REGIONS.map((r) => ({
                id: r.id,
                label: r.id,
                location: r.label,
                availableFor: [r.platform],
              })),
              filterByFieldKey: "platform",
              defaultValue: "us-east-1",
            },
            {
              key: "readRegions",
              label: "Read regions (optional)",
              kind: "policy-picker",
              required: false,
              description:
                "Replicas that serve reads near your users. Must be on the same cloud as the primary.",
              policies: REDIS_REGIONS.map((r) => ({
                id: r.id,
                label: r.id,
                description: r.label,
                category: r.platform.toUpperCase(),
              })),
            },
            {
              key: "plan",
              label: "Plan",
              kind: "select",
              required: true,
              defaultValue: "payg",
              options: REDIS_PLANS.map((p) => ({
                id: p,
                label:
                  p === "payg"
                    ? "Pay as you go"
                    : p === "free"
                      ? "Free"
                      : `Fixed ${p.replace("fixed_", "").toUpperCase()}`,
              })),
            },
            {
              key: "budget",
              label: "Monthly budget (USD)",
              kind: "number",
              required: false,
              defaultValue: "20",
              showWhen: { fieldKey: "plan", fieldValue: "payg" },
            },
            {
              key: "eviction",
              label: "When full",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "Reject writes" },
                { id: "true", label: "Evict keys (cache)" },
              ],
            },
          ],
        };
      case T.vector:
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "embeddings" },
            {
              key: "region",
              label: "Region",
              kind: "select",
              required: true,
              defaultValue: "us-east-1",
              options: [
                { id: "us-east-1", label: "AWS us-east-1" },
                { id: "eu-west-1", label: "AWS eu-west-1" },
                { id: "us-central1", label: "GCP us-central1" },
              ],
            },
            {
              key: "indexType",
              label: "Index type",
              kind: "select",
              required: true,
              defaultValue: "DENSE",
              options: [
                { id: "DENSE", label: "Dense" },
                { id: "SPARSE", label: "Sparse" },
                { id: "HYBRID", label: "Hybrid (dense + sparse)" },
              ],
            },
            {
              key: "embeddingModel",
              label: "Embedding model",
              kind: "select",
              required: false,
              defaultValue: "",
              description: "Let Upstash embed plain text for you, or bring your own vectors.",
              options: [
                { id: "", label: "Bring my own vectors" },
                { id: "BGE_SMALL_EN_V1_5", label: "BGE small en v1.5 (384 dims)" },
                { id: "BGE_BASE_EN_V1_5", label: "BGE base en v1.5 (768 dims)" },
                { id: "BGE_LARGE_EN_V1_5", label: "BGE large en v1.5 (1024 dims)" },
                { id: "BGE_M3", label: "BGE M3 (1024 dims)" },
              ],
              showWhen: { fieldKey: "indexType", fieldValues: ["DENSE", "HYBRID"] },
            },
            {
              key: "sparseEmbeddingModel",
              label: "Sparse embedding model",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                { id: "", label: "Bring my own sparse vectors" },
                { id: "BM25", label: "BM25" },
                { id: "BGE_M3", label: "BGE M3" },
              ],
              showWhen: { fieldKey: "indexType", fieldValues: ["SPARSE", "HYBRID"] },
            },
            {
              key: "dimensions",
              label: "Dimensions",
              kind: "number",
              required: false,
              defaultValue: "1536",
              description: "Ignored when Upstash embeds for you (the model fixes it).",
              minValue: 1,
            },
            {
              key: "similarity",
              label: "Similarity",
              kind: "select",
              required: true,
              defaultValue: "COSINE",
              options: [
                { id: "COSINE", label: "Cosine" },
                { id: "EUCLIDEAN", label: "Euclidean" },
                { id: "DOT_PRODUCT", label: "Dot product" },
              ],
            },
            {
              key: "plan",
              label: "Plan",
              kind: "select",
              required: true,
              defaultValue: "payg",
              options: [
                { id: "payg", label: "Pay as you go" },
                { id: "fixed", label: "Fixed" },
              ],
            },
          ],
        };
      case T.search:
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "docs" },
            {
              key: "region",
              label: "Region",
              kind: "select",
              required: true,
              defaultValue: "us-central1",
              options: [
                { id: "us-central1", label: "GCP us-central1" },
                { id: "eu-west-1", label: "AWS eu-west-1" },
              ],
            },
            {
              key: "plan",
              label: "Plan",
              kind: "select",
              required: true,
              defaultValue: "payg",
              options: [
                { id: "free", label: "Free" },
                { id: "payg", label: "Pay as you go" },
              ],
            },
          ],
        };
      case T.schedule: {
        const groups = parentResourceId
          ? (await this.urlGroups().catch(() => [])).filter(
              (g) => g.qstashId === externalIdOf(parentResourceId),
            )
          : [];
        return {
          fields: [
            ...(await this.qstashField(parentResourceId)),
            {
              key: "destination",
              label: "Destination",
              kind: "text",
              required: true,
              placeholder: "https://example.com/api/cron",
              description: groups.length
                ? `A URL, or one of this account's URL groups: ${groups.map((g) => g.item.name).join(", ")}.`
                : "A URL, or the name of a URL group.",
            },
            {
              key: "cron",
              label: "Cron",
              kind: "text",
              required: true,
              defaultValue: "0 * * * *",
              description: "In UTC. Prefix with CRON_TZ=Europe/Berlin to use a time zone.",
            },
            {
              key: "method",
              label: "Method",
              kind: "select",
              required: false,
              defaultValue: "POST",
              options: ["POST", "GET", "PUT", "PATCH", "DELETE"].map((m) => ({ id: m, label: m })),
            },
            { key: "body", label: "Body", kind: "code", codeLanguage: "json", required: false },
            {
              key: "retries",
              label: "Retries",
              kind: "number",
              required: false,
              minValue: 0,
              placeholder: "3",
            },
            { key: "delay", label: "Delay", kind: "text", required: false, placeholder: "30s" },
            { key: "callback", label: "Callback URL", kind: "text", required: false },
          ],
        };
      }
      case T.queue:
        return {
          fields: [
            ...(await this.qstashField(parentResourceId)),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "emails" },
            {
              key: "parallelism",
              label: "Parallelism",
              kind: "number",
              required: true,
              defaultValue: "1",
              minValue: 1,
            },
          ],
        };
      case T.urlGroup:
        return {
          fields: [
            ...(await this.qstashField(parentResourceId)),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "order-events",
            },
            {
              key: "endpoints",
              label: "Endpoint URLs",
              kind: "string-list",
              required: true,
              placeholder: "https://example.com/api/hook",
            },
          ],
        };
      case T.team:
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "copyCard",
              label: "Payment",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: [
                { id: "true", label: "Copy my card to the team" },
                { id: "false", label: "Add a card later" },
              ],
            },
          ],
        };
      default:
        throw new Error(`Upstash plugin: creating "${typeId}" is not supported`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    this.invalidate();
    switch (typeId) {
      case T.redis: {
        const platform = fields["platform"] === "gcp" ? "gcp" : "aws";
        const region = fields["region"] ?? "";
        const regionDef = REDIS_REGIONS.find((r) => r.id === region);
        if (!regionDef) throw new Error("Pick a primary region.");
        if (regionDef.platform !== platform)
          throw new Error(`${region} is not a ${platform.toUpperCase()} region.`);
        const reads = list(fields["readRegions"]).filter((r) => r !== region);
        const wrong = reads.filter(
          (r) => REDIS_REGIONS.find((x) => x.id === r)?.platform !== platform,
        );
        if (wrong.length)
          throw new Error(
            `Read regions must be on ${platform.toUpperCase()}: ${wrong.join(", ")}.`,
          );
        const db = await this.dev<UpRedis>("POST", "/redis/database", {
          database_name: fields["name"],
          platform,
          primary_region: region,
          ...(reads.length ? { read_regions: reads } : {}),
          plan: fields["plan"] || "payg",
          ...(num(fields["budget"]) !== undefined ? { budget: num(fields["budget"]) } : {}),
          eviction: bool(fields["eviction"]) ?? false,
          tls: true,
        });
        return mapRedis(accountId, db);
      }
      case T.vector: {
        const indexType = fields["indexType"] || "DENSE";
        const model = fields["embeddingModel"];
        const dims = model
          ? model === "BGE_SMALL_EN_V1_5"
            ? 384
            : model === "BGE_BASE_EN_V1_5"
              ? 768
              : 1024
          : num(fields["dimensions"]);
        if (indexType !== "SPARSE" && !dims) throw new Error("Give the vector dimensions.");
        const idx = await this.dev<UpVector>("POST", "/vector/index", {
          name: fields["name"],
          region: fields["region"],
          similarity_function: fields["similarity"] || "COSINE",
          dimension_count: dims ?? 0,
          type: fields["plan"] || "payg",
          index_type: indexType,
          ...(model && indexType !== "SPARSE" ? { embedding_model: model } : {}),
          ...(fields["sparseEmbeddingModel"] && indexType !== "DENSE"
            ? { sparse_embedding_model: fields["sparseEmbeddingModel"] }
            : {}),
        });
        return mapVector(accountId, idx);
      }
      case T.search: {
        const idx = await this.dev<UpSearch>("POST", "/search", {
          name: fields["name"],
          region: fields["region"],
          type: fields["plan"] || "payg",
        });
        return mapSearch(accountId, idx);
      }
      case T.schedule: {
        const qstashId = this.qstashOf(fields, parentResourceId);
        const destination = (fields["destination"] ?? "").trim();
        if (!destination) throw new Error("Give a destination.");
        if (!fields["cron"]) throw new Error("Give a cron expression.");
        const headers: Record<string, string> = {
          "Upstash-Cron": fields["cron"],
          "Content-Type": "application/json",
        };
        if (fields["method"]) headers["Upstash-Method"] = fields["method"];
        if (num(fields["retries"]) !== undefined)
          headers["Upstash-Retries"] = String(num(fields["retries"]));
        if (fields["delay"]) headers["Upstash-Delay"] = fields["delay"];
        if (fields["callback"]) headers["Upstash-Callback"] = fields["callback"];
        const res = await this.q<{ scheduleId?: string }>(
          qstashId,
          "POST",
          `/v2/schedules/${destinationPath(destination)}`,
          {
            body: fields["body"] ?? "",
            headers,
          },
        );
        if (!res?.scheduleId) throw new Error("QStash did not return the new schedule's id.");
        return this.getResource(
          T.schedule,
          `${accountId}:${T.schedule}:${qstashId}/${res.scheduleId}`,
          accountId,
        );
      }
      case T.queue: {
        const qstashId = this.qstashOf(fields, parentResourceId);
        const name = (fields["name"] ?? "").trim();
        if (!name) throw new Error("Give the queue a name.");
        await this.q(qstashId, "POST", "/v2/queues", {
          json: { queueName: name, parallelism: num(fields["parallelism"]) ?? 1 },
        });
        return this.getResource(T.queue, `${accountId}:${T.queue}:${qstashId}/${name}`, accountId);
      }
      case T.urlGroup: {
        const qstashId = this.qstashOf(fields, parentResourceId);
        const name = (fields["name"] ?? "").trim();
        const urls = list(fields["endpoints"]);
        if (!name || !urls.length) throw new Error("Give a name and at least one endpoint URL.");
        await this.q(qstashId, "POST", `/v2/topics/${encodeURIComponent(name)}/endpoints`, {
          json: { endpoints: urls.map((url) => ({ url })) },
        });
        return this.getResource(
          T.urlGroup,
          `${accountId}:${T.urlGroup}:${qstashId}/${name}`,
          accountId,
        );
      }
      case T.team: {
        const res = await this.dev<UpTeam>("POST", "/team", {
          team_name: fields["name"],
          copy_cc: fields["copyCard"] !== "false",
        });
        return mapTeam(accountId, res ?? { team_name: fields["name"] ?? "" }, 1, "owner");
      }
      default:
        throw new Error(`Upstash plugin: creating "${typeId}" is not supported`);
    }
  }

  // -------------------------------------------------------------------------
  // Update / delete
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const id = encodeURIComponent(ext);
    this.invalidate();
    switch (typeId) {
      case T.redis: {
        if (fields["name"]) await this.dev("POST", `/redis/rename/${id}`, { name: fields["name"] });
        if (num(fields["budget"]) !== undefined)
          await this.dev("PATCH", `/redis/update-budget/${id}`, { budget: num(fields["budget"]) });
        const ev = bool(fields["eviction"]);
        if (ev !== undefined)
          await this.dev("POST", `/redis/${ev ? "enable" : "disable"}-eviction/${id}`);
        const au = bool(fields["autoUpgrade"]);
        if (au !== undefined)
          await this.dev("POST", `/redis/${au ? "enable" : "disable"}-autoupgrade/${id}`);
        const bk = bool(fields["dailyBackup"]);
        if (bk !== undefined)
          await this.dev("PATCH", `/redis/${bk ? "enable" : "disable"}-dailybackup/${id}`);
        break;
      }
      case T.vector:
        if (fields["name"])
          await this.dev("POST", `/vector/index/${id}/rename`, { name: fields["name"] });
        break;
      case T.search:
        if (fields["name"])
          await this.dev("POST", `/search/${id}/rename`, { name: fields["name"] });
        break;
      case T.qstash: {
        const budget = num(fields["budget"]);
        if (budget !== undefined) {
          if (budget !== 0 && (budget < 20 || budget > 10000))
            throw new Error("Budget must be 0 (no limit) or 20 to 10000.");
          await this.dev("PATCH", `/qstash/update-budget/${id}`, { budget });
        }
        break;
      }
      case T.queue: {
        const { qstashId, key } = splitChild(ext);
        const parallelism = num(fields["parallelism"]);
        if (parallelism !== undefined) {
          if (parallelism < 1) throw new Error("Parallelism must be at least 1.");
          await this.q(qstashId, "POST", "/v2/queues", { json: { queueName: key, parallelism } });
        }
        break;
      }
      case T.urlGroup: {
        const { qstashId, key } = splitChild(ext);
        if (fields["endpoints"] !== undefined) {
          const want = list(fields["endpoints"]);
          if (!want.length)
            throw new Error("A URL group needs at least one endpoint; delete the group instead.");
          const current = await this.q<UpUrlGroup>(
            qstashId,
            "GET",
            `/v2/topics/${encodeURIComponent(key)}`,
          );
          const have = (current?.endpoints ?? []).map((e) => e.url).filter((u): u is string => !!u);
          const add = want.filter((u) => !have.includes(u));
          const remove = have.filter((u) => !want.includes(u));
          const path = `/v2/topics/${encodeURIComponent(key)}/endpoints`;
          if (add.length)
            await this.q(qstashId, "POST", path, {
              json: { endpoints: add.map((url) => ({ url })) },
            });
          if (remove.length)
            await this.q(qstashId, "DELETE", path, {
              json: { endpoints: remove.map((url) => ({ url })) },
            });
        }
        break;
      }
      default:
        throw new Error(`Upstash plugin: updating "${typeId}" is not supported`);
    }
    this.invalidate();
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    const id = encodeURIComponent(ext);
    this.invalidate();
    switch (typeId) {
      case T.redis:
        return void (await this.dev("DELETE", `/redis/database/${id}`));
      case T.vector:
        return void (await this.dev("DELETE", `/vector/index/${id}`));
      case T.search:
        return void (await this.dev("DELETE", `/search/${id}`));
      case T.team:
        return void (await this.dev("DELETE", `/team/${id}`));
      case T.schedule:
      case T.queue:
      case T.urlGroup: {
        const { qstashId, key } = splitChild(ext);
        const seg = typeId === T.schedule ? "schedules" : typeId === T.queue ? "queues" : "topics";
        return void (await this.q(qstashId, "DELETE", `/v2/${seg}/${encodeURIComponent(key)}`));
      }
      default:
        throw new Error(`Upstash plugin: deleting "${typeId}" is not supported`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const ext = externalIdOf(resourceId);
    const id = encodeURIComponent(ext);
    this.invalidate();
    switch (typeId) {
      case T.redis:
        if (actionId === "reset-password")
          return void (await this.dev("POST", `/redis/reset-password/${id}`));
        if (actionId === "enable-tls")
          return void (await this.dev("POST", `/redis/enable-tls/${id}`));
        break;
      case T.vector:
        if (actionId === "reset-password")
          return void (await this.dev("POST", `/vector/index/${id}/reset-password`));
        break;
      case T.search:
        if (actionId === "reset-password")
          return void (await this.dev("POST", `/search/${id}/reset-password`));
        break;
      case T.qstash: {
        if (actionId === "reset-token")
          return void (await this.dev("POST", `/qstash/rotate-token/${id}`));
        if (actionId === "enable-prodpack")
          return void (await this.dev("POST", `/qstash/enable-prodpack/${id}`));
        if (actionId === "disable-prodpack")
          return void (await this.dev("POST", `/qstash/disable-prodpack/${id}`));
        if (actionId === "rotate-keys") return void (await this.q(ext, "POST", "/v2/keys/rotate"));
        if (actionId === "dlq-retry-all") return void (await this.q(ext, "POST", "/v2/dlq/retry"));
        if (actionId === "dlq-purge") return void (await this.q(ext, "DELETE", "/v2/dlq"));
        const m = /^dlq-(retry|delete):(.+)$/.exec(actionId);
        if (m) {
          const dlqId = encodeURIComponent(m[2]!);
          if (m[1] === "retry") return void (await this.q(ext, "POST", `/v2/dlq/retry/${dlqId}`));
          return void (await this.q(ext, "DELETE", `/v2/dlq/${dlqId}`));
        }
        break;
      }
      case T.schedule:
      case T.queue: {
        if (actionId !== "pause" && actionId !== "resume") break;
        const { qstashId, key } = splitChild(ext);
        const seg = typeId === T.schedule ? "schedules" : "queues";
        return void (await this.q(
          qstashId,
          "POST",
          `/v2/${seg}/${encodeURIComponent(key)}/${actionId}`,
        ));
      }
      case T.team: {
        const m = /^remove-member:(.+)$/.exec(actionId);
        if (m)
          return void (await this.dev("DELETE", "/teams/member", {
            team_id: ext,
            member_email: m[1],
          }));
        break;
      }
    }
    throw new Error(`Upstash plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const form = decodePromptArgs(args);
    const ext = externalIdOf(resourceId);
    const id = encodeURIComponent(ext);
    this.invalidate();
    if (command === "move-to-team") {
      if (!form["teamId"]) throw new Error("Pick a team.");
      if (typeId === T.redis)
        await this.dev("POST", "/redis/move-to-team", {
          team_id: form["teamId"],
          database_id: ext,
        });
      else if (typeId === T.vector)
        await this.dev("POST", `/vector/index/${id}/transfer`, { target_account: form["teamId"] });
      else if (typeId === T.search)
        await this.dev("POST", `/search/${id}/transfer`, { target_account: form["teamId"] });
      else if (typeId === T.qstash)
        await this.dev("POST", "/qstash/move-to-team", {
          qstash_id: ext,
          target_team_id: form["teamId"],
        });
      else throw new Error("This resource cannot be moved.");
      return { ok: true, message: "Moved to the team." };
    }
    switch (`${typeId}:${command}`) {
      case `${T.redis}:change-plan`:
        if (!form["plan"]) throw new Error("Pick a plan.");
        await this.dev("POST", `/redis/${id}/change-plan`, { plan_name: form["plan"] });
        return { ok: true, message: "Plan changed." };
      case `${T.redis}:update-regions`: {
        const db = await this.redis(ext);
        const platform = REDIS_REGIONS.find((r) => r.id === db.primary_region)?.platform;
        const regions = list(form["readRegions"]).filter((r) => r !== db.primary_region);
        const wrong = regions.filter(
          (r) => REDIS_REGIONS.find((x) => x.id === r)?.platform !== platform,
        );
        if (wrong.length)
          throw new Error(`Read regions must be on the primary's cloud: ${wrong.join(", ")}.`);
        await this.dev("POST", `/redis/update-regions/${id}`, { read_regions: regions });
        return { ok: true, message: "Read regions updated." };
      }
      case `${T.redis}:backup`:
        await this.dev("POST", `/redis/create-backup/${id}`, {
          name: form["name"] || `backup-${Date.now()}`,
        });
        return { ok: true, message: "Backup started." };
      case `${T.redis}:restore`:
        if (!form["backupId"]) throw new Error("Pick a backup.");
        await this.dev("POST", `/redis/restore-backup/${id}`, { backup_id: form["backupId"] });
        return { ok: true, message: "Restore started." };
      case `${T.redis}:delete-backup`:
        if (!form["backupId"]) throw new Error("Pick a backup.");
        await this.dev(
          "DELETE",
          `/redis/delete-backup/${id}/${encodeURIComponent(form["backupId"])}`,
        );
        return { ok: true, message: "Backup deleted." };
      case `${T.vector}:set-plan`:
        if (!form["plan"]) throw new Error("Pick a plan.");
        await this.dev("POST", `/vector/index/${id}/setplan`, { target_plan: form["plan"] });
        return { ok: true, message: "Plan changed." };
      case `${T.qstash}:set-plan`:
        if (!form["plan"]) throw new Error("Pick a plan.");
        await this.dev("POST", `/qstash/set-plan/${id}`, { plan_name: form["plan"] });
        return { ok: true, message: "Plan changed." };
      case `${T.team}:add-member`:
        if (!form["email"]) throw new Error("Give an email.");
        await this.dev("POST", "/teams/member", {
          team_id: ext,
          member_email: form["email"],
          member_role: form["role"] || "dev",
        });
        return { ok: true, message: "Member added." };
    }
    throw new Error(`Upstash plugin: command "${command}" is not supported for "${typeId}"`);
  }

  async publishMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: PublishMessagePayload,
  ): Promise<PublishMessageResult> {
    const ext = externalIdOf(resourceId);
    const extra = (k: string) => {
      const v = payload.extras[k];
      return typeof v === "string" ? v.trim() : "";
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (extra("delay")) headers["Upstash-Delay"] = extra("delay");
    if (extra("retries")) headers["Upstash-Retries"] = extra("retries");
    const fwd = payload.extras["headers"];
    if (fwd && typeof fwd === "object") {
      for (const [k, v] of Object.entries(fwd)) if (k) headers[`Upstash-Forward-${k}`] = v;
    }
    if (payload.body.trim()) {
      try {
        JSON.parse(payload.body);
      } catch {
        headers["Content-Type"] = "text/plain";
      }
    }
    let qstashId: string;
    let path: string;
    if (typeId === T.urlGroup) {
      const c = splitChild(ext);
      qstashId = c.qstashId;
      path = `/v2/publish/${encodeURIComponent(c.key)}`;
    } else {
      const destination = extra("destination");
      if (!/^https?:\/\//.test(destination))
        throw new Error("Give a destination URL starting with https://.");
      if (typeId === T.queue) {
        const c = splitChild(ext);
        qstashId = c.qstashId;
        path = `/v2/enqueue/${encodeURIComponent(c.key)}/${destination}`;
      } else if (typeId === T.qstash) {
        qstashId = ext;
        path = `/v2/publish/${destination}`;
      } else {
        throw new Error("Upstash plugin: this resource cannot publish messages.");
      }
    }
    const res = await this.q<{ messageId?: string } | Array<{ messageId?: string; url?: string }>>(
      qstashId,
      "POST",
      path,
      {
        body: payload.body,
        headers,
      },
    );
    if (Array.isArray(res)) {
      return {
        summary: `Published to ${res.length} endpoint${res.length === 1 ? "" : "s"}.`,
        ...(res[0]?.messageId ? { id: res[0].messageId } : {}),
      };
    }
    return {
      ...(res?.messageId ? { id: res.messageId } : {}),
      summary: "Message accepted by QStash.",
    };
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
    const ext = encodeURIComponent(externalIdOf(resourceId));
    const period = statsPeriod(timeRange ? timeRange.endMs - timeRange.startMs : METRICS_WINDOW_MS);
    const series: Array<MetricSeries | null> = [];
    const add = (label: string, points: Point[] | undefined, unit?: string) =>
      series.push(pointsToSeries(label, points, unit));
    if (resourceTypeId === T.redis) {
      const s = await this.dev<UpRedisStats>("GET", `/redis/stats/${ext}`);
      add("Throughput", s?.throughput, "ops/s");
      add("Reads", s?.read);
      add("Writes", s?.write);
      add("Connections", s?.connection_count);
      add("Keys", s?.keyspace);
      add("Disk used", s?.diskusage, "bytes");
      add("Mean latency", s?.latencymean, "µs");
      add("P99 latency", s?.latency_99, "µs");
      add("Cache hits", s?.hits);
      add("Cache misses", s?.misses);
      add("Bandwidth", s?.bandwidths, "bytes");
    } else if (resourceTypeId === T.vector || resourceTypeId === T.search) {
      const base = resourceTypeId === T.vector ? `/vector/index/${ext}` : `/search/${ext}`;
      const s = await this.dev<UpIndexStats>("GET", `${base}/stats`, undefined, { period });
      add("Query throughput", s?.query_throughput);
      add("Update throughput", s?.update_throughput);
      add("Mean query latency", s?.query_latency_mean, "ms");
      add("P99 query latency", s?.query_latency_99, "ms");
      add("Mean update latency", s?.update_latency_mean, "ms");
      add(resourceTypeId === T.vector ? "Vectors" : "Documents", s?.vector_count);
      add("Data size", s?.data_size, "bytes");
    } else if (resourceTypeId === T.qstash) {
      const s = await this.dev<UpQStashStats>("GET", `/qstash/stats/${ext}`, undefined, { period });
      add("Messages", s?.daily_used);
    }
    return series.filter((x): x is MetricSeries => !!x);
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const tail = Math.min(Math.max(params.tailLines ?? 100, 1), 1000);
    const ext = externalIdOf(resourceId);
    if (typeId === T.account) {
      const logs = (await this.dev<UpAuditLog[]>("GET", "/auditlogs")) ?? [];
      const text = logs
        .slice()
        .sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))
        .slice(-tail)
        .map(
          (l) =>
            `${stamp(l.timestamp)}  ${l.actor ?? ""}  ${l.readable_format ?? l.action_string ?? ""}${l.ip ? `  [${l.ip}]` : ""}\n`,
        )
        .join("");
      return {
        text: text || "No audit log entries.\n",
        containers: ["Audit log"],
        activeContainer: "Audit log",
      };
    }
    if (typeId === T.qstash) {
      const res = await this.q<{ logs?: UpLog[] }>(ext, "GET", "/v2/logs", {
        query: { count: Math.min(tail, 1000) },
      });
      const text = (res?.logs ?? [])
        .slice()
        .reverse()
        .map(
          (l) =>
            `${stamp(l.time)}  ${(l.state ?? "").padEnd(9)}  ${l.messageId ?? ""}  ${l.url ?? l.topicName ?? ""}${l.responseStatus ? `  HTTP ${l.responseStatus}` : ""}${l.error ? `  ${l.error}` : ""}\n`,
        )
        .join("");
      return {
        text: text || "No message logs.\n",
        containers: ["Messages"],
        activeContainer: "Messages",
      };
    }
    throw new Error(
      "Upstash plugin: logs are available for the account (audit log) and QStash (message log).",
    );
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    if (resourceTypeId === T.redis) {
      return [
        {
          label: "State",
          value: String(f["state"] ?? ""),
          variant: f["state"] === "active" ? "status-healthy" : "status-degraded",
        },
        { label: "Plan", value: String(f["plan"] ?? "") },
        { label: "Region", value: String(f["region"] ?? "") },
      ];
    }
    return [
      { label: "Region", value: String(f["region"] ?? "") },
      { label: "Plan", value: String(f["plan"] ?? "") },
    ];
  }

  fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[] | CostFetchResult> {
    return fetchUpstashCostData(this.ctx, range);
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const out: QuotaUsage[] = [];
    const [users, schedules, queues, groups] = await Promise.all([
      this.qstashUsers(),
      this.schedules(),
      this.queues(),
      this.urlGroups(),
    ]);
    for (const u of users) {
      if (!u.id) continue;
      const count = (xs: Array<{ qstashId: string }>) =>
        xs.filter((x) => x.qstashId === u.id).length;
      const rows: Array<[string, string, number | undefined, number]> = [
        ["schedules", "Schedules", u.max_schedules, count(schedules)],
        ["queues", "Queues", u.max_queues, count(queues)],
        ["url-groups", "URL groups", u.max_topics, count(groups)],
      ];
      for (const [key, name, limit, used] of rows) {
        if (!limit || limit <= 0) continue;
        out.push({
          id: `qstash/${u.id}/${key}`,
          service: "qstash",
          name,
          ...(u.region ? { region: u.region } : {}),
          limit,
          used,
        });
      }
    }
    for (const db of await this.redisList()) {
      if (!db.database_id || !db.db_disk_threshold) continue;
      const stats = await this.dev<UpRedisStats>(
        "GET",
        `/redis/stats/${encodeURIComponent(db.database_id)}`,
      ).catch(() => undefined);
      if (stats?.current_storage === undefined) continue;
      out.push({
        id: `redis/${db.database_id}/storage`,
        service: "redis",
        name: `Storage (${db.database_name ?? db.database_id})`,
        ...(db.primary_region ? { region: db.primary_region } : {}),
        limit: Math.round((db.db_disk_threshold / 1024 ** 3) * 1000) / 1000,
        used: Math.round((stats.current_storage / 1024 ** 3) * 1000) / 1000,
        unit: "GB",
      });
    }
    return out;
  }
}

/** URLs go into QStash paths verbatim; URL group names are encoded. */
function destinationPath(destination: string): string {
  return /^https?:\/\//.test(destination) ? destination : encodeURIComponent(destination);
}
