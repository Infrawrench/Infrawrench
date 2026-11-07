import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { NoSlashString, PluginEffect } from "@infrawrench/plugin-base";
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
import {
  decodePromptArgs,
  externalIdOf,
  pathEncode,
  requireListPage,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import type { DeveloperClient, QStashClient, UpstashContext } from "./api.js";
import { dev, qstash, qstashBase, qstashPost, statusOf } from "./api.js";
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
  EnqueueOperation,
  Point,
  PublishOperation,
  QStashChild,
  ScheduleCreateOperation,
  UpLogEntry,
  UpQStashUser,
  UpQueue,
  UpRedis,
  UpSchedule,
  UpSearch,
  UpTeam,
  UpUrlGroup,
  UpVector,
} from "./types.js";

const CACHE_MS = 20_000;
export const METRICS_WINDOW_MS = 60 * 60 * 1000;
/** The document's maximum `count` on `GET /v2/logs`. */
const QSTASH_LOG_PAGE = 100;

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
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
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
export function statsPeriod(rangeMs: number) {
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
  return Object.assign(new Error(`Upstash plugin: ${what} not found`), { status: 404 });
}

/** One listing, kept for `CACHE_MS`. A load that fails is not kept. */
class CachedListing<V> {
  private entry: { at: number; value: Promise<V> } | undefined;

  get(load: () => Promise<V>): Promise<V> {
    const hit = this.entry;
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = load();
    this.entry = { at: Date.now(), value };
    value.catch(() => this.clear());
    return value;
  }

  clear(): void {
    this.entry = undefined;
  }
}

export class UpstashClient implements PluginClient {
  readonly ctx: UpstashContext;
  private readonly listings = {
    redis: new CachedListing<UpRedis[]>(),
    vector: new CachedListing<UpVector[]>(),
    search: new CachedListing<UpSearch[]>(),
    teams: new CachedListing<UpTeam[]>(),
    qstash: new CachedListing<UpQStashUser[]>(),
    schedules: new CachedListing<QStashChild<UpSchedule>[]>(),
    queues: new CachedListing<QStashChild<UpQueue>[]>(),
    groups: new CachedListing<QStashChild<UpUrlGroup>[]>(),
  };

  constructor(credentials: Credentials, services?: HostServices) {
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

  private invalidate(): void {
    for (const listing of Object.values(this.listings)) listing.clear();
  }

  private dev<V>(call: (api: DeveloperClient) => Promise<V>): Promise<V | undefined> {
    return dev(this.ctx, call);
  }

  // -------------------------------------------------------------------------
  // Listings
  // -------------------------------------------------------------------------

  private redisList() {
    return this.listings.redis.get(
      async () => (await this.dev((api) => api.get("/redis/databases"))) ?? [],
    );
  }
  private vectorList() {
    return this.listings.vector.get(
      async () => (await this.dev((api) => api.get("/vector/index"))) ?? [],
    );
  }
  private searchList() {
    return this.listings.search.get(
      async () => (await this.dev((api) => api.get("/search"))) ?? [],
    );
  }
  private teams() {
    return this.listings.teams.get(async () => (await this.dev((api) => api.get("/teams"))) ?? []);
  }
  /** Regional QStash accounts, including their tokens. */
  qstashUsers() {
    return this.listings.qstash.get(async () =>
      ((await this.dev((api) => api.get("/qstash/users"))) ?? []).filter((u) => !u.deletion_time),
    );
  }

  private async qstashAccount(id: string) {
    const user = (await this.qstashUsers()).find((u) => u.id === id);
    if (!user?.token) throw notFound(`QStash account ${id}`);
    return { ...user, token: user.token };
  }

  private async q<V>(
    qstashId: string,
    call: (api: QStashClient) => Promise<V>,
  ): Promise<V | undefined> {
    const acct = await this.qstashAccount(qstashId);
    return qstash(this.ctx, { token: acct.token, region: acct.region }, call);
  }

  /** A QStash call whose body goes as it stands rather than as JSON. */
  private async qPost<Op>(
    qstashId: string,
    path: string,
    body: string,
    headers: Record<string, string>,
  ) {
    const acct = await this.qstashAccount(qstashId);
    return qstashPost<Op>(
      this.ctx,
      { token: acct.token, region: acct.region },
      path,
      body,
      headers,
    );
  }

  private async perQStash<V>(
    load: (id: string) => Promise<V[] | undefined>,
  ): Promise<QStashChild<V>[]> {
    const out: QStashChild<V>[] = [];
    for (const u of await this.qstashUsers()) {
      if (!u.id) continue;
      for (const item of (await load(u.id)) ?? []) out.push({ qstashId: u.id, item });
    }
    return out;
  }

  private schedules() {
    return this.listings.schedules.get(() =>
      this.perQStash((id) => this.q(id, (api) => api.get("/v2/schedules"))),
    );
  }
  private queues() {
    return this.listings.queues.get(() =>
      this.perQStash((id) => this.q(id, (api) => api.get("/v2/queues"))),
    );
  }
  private urlGroups() {
    return this.listings.groups.get(() =>
      this.perQStash((id) => this.q(id, (api) => api.get("/v2/topics"))),
    );
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
              const members = await this.dev((api) =>
                api.get(`/teams/${pathEncode(t.team_id ?? "")}`),
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
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      switch (typeId) {
        case T.redis:
          return mapRedis(accountId, (await this.redis(ext))!);
        case T.vector:
          return mapVector(
            accountId,
            (await this.dev((api) => api.get(`/vector/index/${pathEncode(ext)}`)))!,
          );
        case T.search:
          return mapSearch(
            accountId,
            (await this.dev((api) => api.get(`/search/${pathEncode(ext)}`)))!,
          );
        case T.schedule: {
          const { qstashId, key } = splitChild(ext);
          const s = await this.q(qstashId, (api) => api.get(`/v2/schedules/${pathEncode(key)}`));
          return mapSchedule(accountId, qstashId, s!);
        }
        case T.queue: {
          const { qstashId, key } = splitChild(ext);
          const q = await this.q(qstashId, (api) => api.get(`/v2/queues/${pathEncode(key)}`));
          return mapQueue(accountId, qstashId, q!);
        }
        case T.urlGroup: {
          const { qstashId, key } = splitChild(ext);
          const g = await this.q(qstashId, (api) => api.get(`/v2/topics/${pathEncode(key)}`));
          return mapUrlGroup(accountId, qstashId, g!);
        }
        default: {
          const found = (await runPluginEffect(this.listResources(typeId, accountId))).find(
            (r) => r.id === resourceId,
          );
          if (!found) throw notFound(`${typeId}/${ext}`);
          return found;
        }
      }
    });
  }

  private redis(id: string) {
    return this.dev((api) => api.get(`/redis/database/${pathEncode(id)}`));
  }

  /**
   * 30d needs a Pro plan or the Production Pack. The document does not say how another
   * plan is refused, so any 4xx on 30d gets the longest period every plan has.
   */
  private async redisStats(id: NoSlashString, period: string) {
    const read = (p: string) =>
      this.dev((api) => api.get(`/redis/stats/${id}`, { query: { period: p } }));
    try {
      return await read(period);
    } catch (err) {
      const status = statusOf(err);
      if (period !== "30d" || status < 400 || status >= 500) throw err;
      return read("7d");
    }
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      switch (typeId) {
        case T.redis: {
          const db = (await this.redis(ext))!;
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
          const idx = (
            typeId === T.vector
              ? await this.dev((api) => api.get(`/vector/index/${pathEncode(ext)}`))
              : await this.dev((api) => api.get(`/search/${pathEncode(ext)}`))
          )!;
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
            const keys = await this.q(ext, (api) => api.get("/v2/keys"));
            return (outputKey === "currentSigningKey" ? keys?.current : keys?.next) ?? "";
          }
          break;
        }
      }
      throw new Error(`Upstash plugin: cannot resolve "${outputKey}" for "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const out: ResourceInstance = {
        ...resource,
        resolvedOutputs: { ...resource.resolvedOutputs },
      };
      const put = (key: string, value: object | undefined) => {
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
            settle(this.dev((api) => api.get(`/redis/stats/${pathEncode(ext)}`))),
            settle(this.dev((api) => api.get(`/redis/list-backup/${pathEncode(ext)}`))),
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
          const id = pathEncode(ext);
          const [stats, teams] = await Promise.all([
            settle(
              resource.resourceTypeId === T.vector
                ? this.dev((api) =>
                    api.get(`/vector/index/${id}/stats`, { query: { period: "1d" } }),
                  )
                : this.dev((api) => api.get(`/search/${id}/stats`, { query: { period: "1d" } })),
            ),
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
            settle(this.q(ext, (api) => api.get("/v2/dlq", { query: { count: 25 } }))),
            settle(this.q(ext, (api) => api.get("/v2/schedules"))),
            settle(this.q(ext, (api) => api.get("/v2/queues"))),
            settle(this.q(ext, (api) => api.get("/v2/topics"))),
            teamOptions(),
            settle(
              this.dev((api) =>
                api.get(`/qstash/stats/${pathEncode(ext)}`, { query: { period: "30d" } }),
              ),
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
          const members = await settle(this.dev((api) => api.get(`/teams/${pathEncode(ext)}`)));
          put(
            ENRICH.members,
            members?.map((m) => ({ email: m.member_email ?? "", role: m.member_role ?? "" })),
          );
          break;
        }
      }
      return out;
    });
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

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
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
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "embeddings",
              },
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
                options: ["POST", "GET", "PUT", "PATCH", "DELETE"].map((m) => ({
                  id: m,
                  label: m,
                })),
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
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
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
          const db = await this.dev((api) =>
            api.post("/redis/database", {
              body: {
                database_name: fields["name"],
                platform,
                primary_region: region,
                ...(reads.length ? { read_regions: reads } : {}),
                plan: fields["plan"] || "payg",
                ...(num(fields["budget"]) !== undefined ? { budget: num(fields["budget"]) } : {}),
                eviction: bool(fields["eviction"]) ?? false,
                tls: true,
              },
            }),
          );
          return mapRedis(accountId, db!);
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
          const idx = await this.dev((api) =>
            api.post("/vector/index", {
              body: {
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
              },
            }),
          );
          return mapVector(accountId, idx!);
        }
        case T.search: {
          const idx = await this.dev((api) =>
            api.post("/search", {
              body: {
                name: fields["name"],
                region: fields["region"],
                type: fields["plan"] || "payg",
              },
            }),
          );
          return mapSearch(accountId, idx!);
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
          const res = await this.qPost<ScheduleCreateOperation>(
            qstashId,
            `/v2/schedules/${destinationPath(destination)}`,
            fields["body"] ?? "",
            headers,
          );
          if (!res?.scheduleId) throw new Error("QStash did not return the new schedule's id.");
          return runPluginEffect(
            this.getResource(
              T.schedule,
              `${accountId}:${T.schedule}:${qstashId}/${res.scheduleId}`,
              accountId,
            ),
          );
        }
        case T.queue: {
          const qstashId = this.qstashOf(fields, parentResourceId);
          const name = (fields["name"] ?? "").trim();
          if (!name) throw new Error("Give the queue a name.");
          await this.q(qstashId, (api) =>
            api.post("/v2/queues", {
              body: { queueName: name, parallelism: num(fields["parallelism"]) ?? 1 },
            }),
          );
          return runPluginEffect(
            this.getResource(T.queue, `${accountId}:${T.queue}:${qstashId}/${name}`, accountId),
          );
        }
        case T.urlGroup: {
          const qstashId = this.qstashOf(fields, parentResourceId);
          const name = (fields["name"] ?? "").trim();
          const urls = list(fields["endpoints"]);
          if (!name || !urls.length) throw new Error("Give a name and at least one endpoint URL.");
          await this.q(qstashId, (api) =>
            api.post(`/v2/topics/${pathEncode(name)}/endpoints`, {
              body: { endpoints: urls.map((url) => ({ url })) },
            }),
          );
          return runPluginEffect(
            this.getResource(
              T.urlGroup,
              `${accountId}:${T.urlGroup}:${qstashId}/${name}`,
              accountId,
            ),
          );
        }
        case T.team: {
          const res = await this.dev((api) =>
            api.post("/team", {
              body: { team_name: fields["name"], copy_cc: fields["copyCard"] !== "false" },
            }),
          );
          return mapTeam(accountId, res ?? { team_name: fields["name"] ?? "" }, 1, "owner");
        }
        default:
          throw new Error(`Upstash plugin: creating "${typeId}" is not supported`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Update / delete
  // -------------------------------------------------------------------------

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      const id = pathEncode(ext);
      this.invalidate();
      switch (typeId) {
        case T.redis: {
          const name = fields["name"];
          if (name) await this.dev((api) => api.post(`/redis/rename/${id}`, { body: { name } }));
          const budget = num(fields["budget"]);
          if (budget !== undefined)
            await this.dev((api) => api.patch(`/redis/update-budget/${id}`, { body: { budget } }));
          const ev = bool(fields["eviction"]);
          if (ev !== undefined)
            await this.dev((api) =>
              ev
                ? api.post(`/redis/enable-eviction/${id}`)
                : api.post(`/redis/disable-eviction/${id}`),
            );
          const au = bool(fields["autoUpgrade"]);
          if (au !== undefined)
            await this.dev((api) =>
              au
                ? api.post(`/redis/enable-autoupgrade/${id}`)
                : api.post(`/redis/disable-autoupgrade/${id}`),
            );
          const bk = bool(fields["dailyBackup"]);
          if (bk !== undefined)
            await this.dev((api) =>
              bk
                ? api.patch(`/redis/enable-dailybackup/${id}`)
                : api.patch(`/redis/disable-dailybackup/${id}`),
            );
          break;
        }
        case T.vector: {
          const name = fields["name"];
          if (name)
            await this.dev((api) => api.post(`/vector/index/${id}/rename`, { body: { name } }));
          break;
        }
        case T.search: {
          const name = fields["name"];
          if (name) await this.dev((api) => api.post(`/search/${id}/rename`, { body: { name } }));
          break;
        }
        case T.qstash: {
          const budget = num(fields["budget"]);
          if (budget !== undefined) {
            if (budget !== 0 && (budget < 20 || budget > 10000))
              throw new Error("Budget must be 0 (no limit) or 20 to 10000.");
            await this.dev((api) => api.patch(`/qstash/update-budget/${id}`, { body: { budget } }));
          }
          break;
        }
        case T.queue: {
          const { qstashId, key } = splitChild(ext);
          const parallelism = num(fields["parallelism"]);
          if (parallelism !== undefined) {
            if (parallelism < 1) throw new Error("Parallelism must be at least 1.");
            await this.q(qstashId, (api) =>
              api.post("/v2/queues", { body: { queueName: key, parallelism } }),
            );
          }
          break;
        }
        case T.urlGroup: {
          const { qstashId, key } = splitChild(ext);
          if (fields["endpoints"] !== undefined) {
            const want = list(fields["endpoints"]);
            if (!want.length)
              throw new Error("A URL group needs at least one endpoint; delete the group instead.");
            const group = pathEncode(key);
            const current = await this.q(qstashId, (api) => api.get(`/v2/topics/${group}`));
            const have = (current?.endpoints ?? [])
              .map((e) => e.url)
              .filter((u): u is string => !!u);
            const add = want.filter((u) => !have.includes(u));
            const remove = have.filter((u) => !want.includes(u));
            if (add.length)
              await this.q(qstashId, (api) =>
                api.post(`/v2/topics/${group}/endpoints`, {
                  body: { endpoints: add.map((url) => ({ url })) },
                }),
              );
            if (remove.length)
              await this.q(qstashId, (api) =>
                api.delete(`/v2/topics/${group}/endpoints`, {
                  body: { endpoints: remove.map((url) => ({ url })) },
                }),
              );
          }
          break;
        }
        default:
          throw new Error(`Upstash plugin: updating "${typeId}" is not supported`);
      }
      this.invalidate();
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      const id = pathEncode(ext);
      this.invalidate();
      switch (typeId) {
        case T.redis:
          return void (await this.dev((api) => api.delete(`/redis/database/${id}`)));
        case T.vector:
          return void (await this.dev((api) => api.delete(`/vector/index/${id}`)));
        case T.search:
          return void (await this.dev((api) => api.delete(`/search/${id}`)));
        case T.team:
          return void (await this.dev((api) => api.delete(`/team/${id}`)));
        case T.schedule: {
          const { qstashId, key } = splitChild(ext);
          return void (await this.q(qstashId, (api) =>
            api.delete(`/v2/schedules/${pathEncode(key)}`),
          ));
        }
        case T.queue: {
          const { qstashId, key } = splitChild(ext);
          return void (await this.q(qstashId, (api) =>
            api.delete(`/v2/queues/${pathEncode(key)}`),
          ));
        }
        case T.urlGroup: {
          const { qstashId, key } = splitChild(ext);
          return void (await this.q(qstashId, (api) =>
            api.delete(`/v2/topics/${pathEncode(key)}`),
          ));
        }
        default:
          throw new Error(`Upstash plugin: deleting "${typeId}" is not supported`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      const id = pathEncode(ext);
      this.invalidate();
      switch (typeId) {
        case T.redis:
          if (actionId === "reset-password")
            return void (await this.dev((api) => api.post(`/redis/reset-password/${id}`)));
          if (actionId === "enable-tls")
            return void (await this.dev((api) => api.post(`/redis/enable-tls/${id}`)));
          break;
        case T.vector:
          if (actionId === "reset-password")
            return void (await this.dev((api) => api.post(`/vector/index/${id}/reset-password`)));
          break;
        case T.search:
          if (actionId === "reset-password")
            return void (await this.dev((api) => api.post(`/search/${id}/reset-password`)));
          break;
        case T.qstash: {
          if (actionId === "reset-token")
            return void (await this.dev((api) => api.post(`/qstash/rotate-token/${id}`)));
          if (actionId === "enable-prodpack")
            return void (await this.dev((api) => api.post(`/qstash/enable-prodpack/${id}`)));
          if (actionId === "disable-prodpack")
            return void (await this.dev((api) => api.post(`/qstash/disable-prodpack/${id}`)));
          if (actionId === "rotate-keys")
            return void (await this.q(ext, (api) => api.post("/v2/keys/rotate")));
          if (actionId === "dlq-retry-all")
            return void (await this.q(ext, (api) => api.post("/v2/dlq/retry")));
          if (actionId === "dlq-purge")
            return void (await this.q(ext, (api) => api.delete("/v2/dlq")));
          const m = /^dlq-(retry|delete):(.+)$/.exec(actionId);
          if (m) {
            const dlqId = pathEncode(m[2]!);
            if (m[1] === "retry")
              return void (await this.q(ext, (api) => api.post(`/v2/dlq/retry/${dlqId}`)));
            return void (await this.q(ext, (api) => api.delete(`/v2/dlq/${dlqId}`)));
          }
          break;
        }
        case T.schedule: {
          if (actionId !== "pause" && actionId !== "resume") break;
          const { qstashId, key } = splitChild(ext);
          const schedule = pathEncode(key);
          return void (await this.q(qstashId, (api) =>
            actionId === "pause"
              ? api.post(`/v2/schedules/${schedule}/pause`)
              : api.post(`/v2/schedules/${schedule}/resume`),
          ));
        }
        case T.queue: {
          if (actionId !== "pause" && actionId !== "resume") break;
          const { qstashId, key } = splitChild(ext);
          const queue = pathEncode(key);
          return void (await this.q(qstashId, (api) =>
            actionId === "pause"
              ? api.post(`/v2/queues/${queue}/pause`)
              : api.post(`/v2/queues/${queue}/resume`),
          ));
        }
        case T.team: {
          const m = /^remove-member:(.+)$/.exec(actionId);
          if (m)
            return void (await this.dev((api) =>
              api.delete("/teams/member", { body: { team_id: ext, member_email: m[1] } }),
            ));
          break;
        }
      }
      throw new Error(`Upstash plugin: unknown action "${actionId}" for "${typeId}"`);
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
      const ext = externalIdOf(resourceId);
      const id = pathEncode(ext);
      this.invalidate();
      if (command === "move-to-team") {
        const teamId = form["teamId"];
        if (!teamId) throw new Error("Pick a team.");
        if (typeId === T.redis)
          await this.dev((api) =>
            api.post("/redis/move-to-team", { body: { team_id: teamId, database_id: ext } }),
          );
        else if (typeId === T.vector)
          await this.dev((api) =>
            api.post(`/vector/index/${id}/transfer`, { body: { target_account: teamId } }),
          );
        else if (typeId === T.search)
          await this.dev((api) =>
            api.post(`/search/${id}/transfer`, { body: { target_account: teamId } }),
          );
        else if (typeId === T.qstash)
          await this.dev((api) =>
            api.post("/qstash/move-to-team", { body: { qstash_id: ext, target_team_id: teamId } }),
          );
        else throw new Error("This resource cannot be moved.");
        return { ok: true, message: "Moved to the team." };
      }
      switch (`${typeId}:${command}`) {
        case `${T.redis}:change-plan`:
          if (!form["plan"]) throw new Error("Pick a plan.");
          await this.dev((api) =>
            api.post(`/redis/${id}/change-plan`, { body: { plan_name: form["plan"] } }),
          );
          return { ok: true, message: "Plan changed." };
        case `${T.redis}:update-regions`: {
          const db = (await this.redis(ext))!;
          const platform = REDIS_REGIONS.find((r) => r.id === db.primary_region)?.platform;
          const regions = list(form["readRegions"]).filter((r) => r !== db.primary_region);
          const wrong = regions.filter(
            (r) => REDIS_REGIONS.find((x) => x.id === r)?.platform !== platform,
          );
          if (wrong.length)
            throw new Error(`Read regions must be on the primary's cloud: ${wrong.join(", ")}.`);
          await this.dev((api) =>
            api.post(`/redis/update-regions/${id}`, { body: { read_regions: regions } }),
          );
          return { ok: true, message: "Read regions updated." };
        }
        case `${T.redis}:backup`:
          await this.dev((api) =>
            api.post(`/redis/create-backup/${id}`, {
              body: { name: form["name"] || `backup-${Date.now()}` },
            }),
          );
          return { ok: true, message: "Backup started." };
        case `${T.redis}:restore`:
          if (!form["backupId"]) throw new Error("Pick a backup.");
          await this.dev((api) =>
            api.post(`/redis/restore-backup/${id}`, { body: { backup_id: form["backupId"] } }),
          );
          return { ok: true, message: "Restore started." };
        case `${T.redis}:delete-backup`: {
          if (!form["backupId"]) throw new Error("Pick a backup.");
          const backup = pathEncode(form["backupId"]);
          await this.dev((api) => api.delete(`/redis/delete-backup/${id}/${backup}`));
          return { ok: true, message: "Backup deleted." };
        }
        case `${T.vector}:set-plan`:
          if (!form["plan"]) throw new Error("Pick a plan.");
          await this.dev((api) =>
            api.post(`/vector/index/${id}/setplan`, { body: { target_plan: form["plan"] } }),
          );
          return { ok: true, message: "Plan changed." };
        case `${T.qstash}:set-plan`:
          if (!form["plan"]) throw new Error("Pick a plan.");
          await this.dev((api) =>
            api.post(`/qstash/set-plan/${id}`, { body: { plan_name: form["plan"] } }),
          );
          return { ok: true, message: "Plan changed." };
        case `${T.team}:add-member`:
          if (!form["email"]) throw new Error("Give an email.");
          await this.dev((api) =>
            api.post("/teams/member", {
              body: {
                team_id: ext,
                member_email: form["email"],
                member_role: form["role"] || "dev",
              },
            }),
          );
          return { ok: true, message: "Member added." };
      }
      throw new Error(`Upstash plugin: command "${command}" is not supported for "${typeId}"`);
    });
  }

  publishMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: PublishMessagePayload,
  ): PluginEffect<PublishMessageResult> {
    return attempt(async () => {
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
      const res = await this.qPost<PublishOperation | EnqueueOperation>(
        qstashId,
        path,
        payload.body,
        headers,
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
      const ext = pathEncode(externalIdOf(resourceId));
      const period = statsPeriod(
        timeRange ? timeRange.endMs - timeRange.startMs : METRICS_WINDOW_MS,
      );
      const series: Array<MetricSeries | null> = [];
      const add = (label: string, points: Point[] | undefined, unit?: string) =>
        series.push(pointsToSeries(label, points, unit));
      if (resourceTypeId === T.redis) {
        const s = await this.redisStats(ext, period);
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
        const s = await this.dev((api) =>
          resourceTypeId === T.vector
            ? api.get(`/vector/index/${ext}/stats`, { query: { period } })
            : api.get(`/search/${ext}/stats`, { query: { period } }),
        );
        add("Query throughput", s?.query_throughput);
        add("Update throughput", s?.update_throughput);
        add("Mean query latency", s?.query_latency_mean, "ms");
        add("P99 query latency", s?.query_latency_99, "ms");
        add("Mean update latency", s?.update_latency_mean, "ms");
        add(resourceTypeId === T.vector ? "Vectors" : "Documents", s?.vector_count);
        add("Data size", s?.data_size, "bytes");
      } else if (resourceTypeId === T.qstash) {
        const s = await this.dev((api) => api.get(`/qstash/stats/${ext}`, { query: { period } }));
        add("Messages", s?.daily_used);
      }
      return series.filter((x): x is MetricSeries => !!x);
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      const tail = Math.min(Math.max(params.tailLines ?? 100, 1), 1000);
      const ext = externalIdOf(resourceId);
      if (typeId === T.account) {
        const logs = (await this.dev((api) => api.get("/auditlogs"))) ?? [];
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
        const logs = await this.qstashLogs(ext, tail);
        const text = logs
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
    });
  }

  /** The newest `tail` entries. A log view, so stopping at `tail` is what was asked for. */
  private async qstashLogs(qstashId: string, tail: number) {
    const out: UpLogEntry[] = [];
    let cursor: string | undefined;
    do {
      const query = {
        count: Math.min(tail - out.length, QSTASH_LOG_PAGE),
        ...(cursor ? { cursor } : {}),
      };
      const res = await this.q(qstashId, (api) => api.get("/v2/logs", { query }));
      const rows = requireListPage(res?.logs ?? [], {
        vendor: "QStash",
        path: "/v2/logs",
        key: "logs",
      });
      if (!rows.length) break;
      out.push(...rows);
      cursor = res?.cursor;
    } while (cursor && out.length < tail);
    return out;
  }

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
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
    });
  }

  fetchCostData(
    _accountId: string,
    range: CostFetchRange,
  ): PluginEffect<CostRow[] | CostFetchResult> {
    return attempt(async () => {
      return fetchUpstashCostData(this.ctx, range);
    });
  }

  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
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
        const database = pathEncode(db.database_id);
        const stats = await this.dev((api) => api.get(`/redis/stats/${database}`)).catch(
          () => undefined,
        );
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
    });
  }
}

/** URLs go into QStash paths verbatim; URL group names are encoded. */
function destinationPath(destination: string): string {
  return /^https?:\/\//.test(destination) ? destination : encodeURIComponent(destination);
}
