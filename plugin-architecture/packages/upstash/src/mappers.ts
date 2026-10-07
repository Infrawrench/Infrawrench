import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import { REDIS_REGIONS, T } from "./resource-types.js";
import type {
  Point,
  UpQStashUser,
  UpQueue,
  UpRedis,
  UpSchedule,
  UpSearch,
  UpTeam,
  UpUrlGroup,
  UpVector,
} from "./types.js";

type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  parent?: { typeId: string; externalId: string },
): ResourceInstance {
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    clean[k] = v;
  }
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "upstash",
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: typeof fields["createdAt"] === "string" ? fields["createdAt"] : now,
    updatedAt: now,
  };
}

/** Unix seconds or milliseconds to ISO; empty for missing or zero. */
export function iso(ts: number | undefined): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** `endpoint` may be a slug ("beloved-stallion-58500") or a full host. */
export function redisHost(endpoint: string | undefined): string {
  if (!endpoint) return "";
  return endpoint.includes(".") ? endpoint : `${endpoint}.upstash.io`;
}

export function redisPlatform(region: string | undefined): string {
  return REDIS_REGIONS.find((r) => r.id === region)?.platform ?? "";
}

export function redisConnectionString(db: UpRedis): string {
  const host = redisHost(db.endpoint);
  if (!host) return "";
  const scheme = db.tls === false ? "redis" : "rediss";
  const auth = db.password ? `default:${encodeURIComponent(db.password)}@` : "";
  return `${scheme}://${auth}${host}:${db.port ?? 6379}`;
}

export function mapRedis(accountId: string, db: UpRedis): ResourceInstance {
  const id = db.database_id ?? "";
  const region = db.primary_region || (db.region !== "global" ? db.region : undefined);
  return instance(accountId, T.redis, id, db.database_name ?? id, {
    name: db.database_name,
    state: db.modifying_state || db.state,
    platform: redisPlatform(region),
    region,
    readRegions: (db.read_regions ?? []).join(", "),
    plan: db.type,
    budget: db.budget,
    eviction: db.eviction,
    autoUpgrade: db.auto_upgrade,
    dailyBackup: db.daily_backup_enabled,
    tls: db.tls,
    prodPack: db.prod_pack_enabled,
    endpoint: redisHost(db.endpoint),
    port: db.port,
    diskLimitGb:
      db.db_disk_threshold !== undefined
        ? Math.round((db.db_disk_threshold / 1024 ** 3) * 100) / 100
        : undefined,
    maxCommandsPerSecond: db.db_max_commands_per_second,
    maxClients: db.db_max_clients,
    owner: db.customer_id,
    createdAt: iso(db.creation_time),
  });
}

export function mapVector(accountId: string, v: UpVector): ResourceInstance {
  const id = v.id ?? "";
  return instance(accountId, T.vector, id, v.name ?? id, {
    name: v.name,
    region: v.region,
    plan: v.type,
    indexType: v.index_type,
    similarity: v.similarity_function,
    dimensions: v.dimension_count,
    embeddingModel: v.embedding_model,
    sparseEmbeddingModel: v.sparse_embedding_model,
    endpoint: v.endpoint,
    maxVectors: v.max_vector_count,
    maxDailyQueries: v.max_daily_queries,
    owner: v.customer_id,
    createdAt: iso(v.creation_time),
  });
}

export function mapSearch(accountId: string, s: UpSearch): ResourceInstance {
  const id = s.id ?? "";
  return instance(accountId, T.search, id, s.name ?? id, {
    name: s.name,
    region: s.region,
    plan: s.type,
    endpoint: s.endpoint,
    maxDocuments: s.max_vector_count,
    maxDailyQueries: s.max_daily_queries,
    inputEnrichment: s.input_enrichment_enabled,
    owner: s.customer_id,
    createdAt: iso(s.creation_time),
  });
}

export function mapQStash(accountId: string, q: UpQStashUser): ResourceInstance {
  const id = q.id ?? "";
  return instance(accountId, T.qstash, id, `QStash ${q.region ?? ""}`.trim(), {
    region: q.region,
    state: q.state ?? (q.active === false ? "inactive" : "active"),
    plan: q.type,
    reservedPlan: q.reserved_type,
    budget: q.budget,
    prodPack: q.prod_pack_enabled,
    maxRequestsPerDay: q.max_requests_per_day,
    maxRequestsPerSecond: q.max_requests_per_second,
    maxSchedules: q.max_schedules,
    maxQueues: q.max_queues,
    maxTopics: q.max_topics,
    maxRetries: q.max_retries,
    owner: q.customer_id,
    createdAt: iso(q.creation_time),
  });
}

const child = (qstashId: string, key: string) => `${qstashId}/${key}`;

export function splitChild(externalId: string): { qstashId: string; key: string } {
  const idx = externalId.indexOf("/");
  if (idx <= 0) throw new Error(`Upstash plugin: malformed QStash resource id "${externalId}"`);
  return { qstashId: externalId.slice(0, idx), key: externalId.slice(idx + 1) };
}

export function mapSchedule(accountId: string, qstashId: string, s: UpSchedule): ResourceInstance {
  const id = s.scheduleId ?? "";
  return instance(
    accountId,
    T.schedule,
    child(qstashId, id),
    `${s.cron ?? ""} → ${s.destination ?? id}`,
    {
      cron: s.cron,
      destination: s.destination,
      method: s.method,
      retries: s.retries,
      delay: s.delay,
      callback: s.callback,
      paused: s.isPaused ?? false,
      labels: (s.labels ?? (s.label ? [s.label] : [])).join(", "),
      lastRun: iso(s.lastScheduleTime),
      nextRun: iso(s.nextScheduleTime),
      qstashId,
      createdAt: iso(s.createdAt),
    },
    { typeId: T.qstash, externalId: qstashId },
  );
}

export function mapQueue(accountId: string, qstashId: string, q: UpQueue): ResourceInstance {
  const name = q.name ?? "";
  return instance(
    accountId,
    T.queue,
    child(qstashId, name),
    name,
    {
      name,
      parallelism: q.parallelism,
      lag: q.lag,
      paused: q.paused ?? false,
      qstashId,
      createdAt: iso(q.createdAt),
    },
    { typeId: T.qstash, externalId: qstashId },
  );
}

export function mapUrlGroup(accountId: string, qstashId: string, g: UpUrlGroup): ResourceInstance {
  const name = g.name ?? "";
  const urls = (g.endpoints ?? []).map((e) => e.url).filter((u): u is string => !!u);
  return instance(
    accountId,
    T.urlGroup,
    child(qstashId, name),
    name,
    {
      name,
      endpoints: urls.join(", "),
      endpointCount: urls.length,
      qstashId,
      createdAt: iso(g.createdAt),
    },
    { typeId: T.qstash, externalId: qstashId },
  );
}

export function mapTeam(
  accountId: string,
  t: UpTeam,
  members?: number,
  role?: string,
): ResourceInstance {
  const id = t.team_id ?? "";
  return instance(accountId, T.team, id, t.team_name ?? id, {
    name: t.team_name,
    members,
    role,
  });
}

/**
 * Upstash timestamps look like "2025-09-04 15:12:52.76649148 +0000 UTC"
 * (Go's default time format), which `Date.parse` rejects.
 */
export function parseUpstashTime(raw: string | undefined): number {
  if (!raw) return NaN;
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*([+-]\d{4})?/.exec(raw);
  if (!m) return NaN;
  const frac = m[3] ? m[3].slice(0, 4) : "";
  const tz = m[4] ? `${m[4].slice(0, 3)}:${m[4].slice(3)}` : "Z";
  return Date.parse(`${m[1]}T${m[2]}${frac}${tz}`);
}

export function pointsToSeries(
  label: string,
  points: Point[] | undefined,
  unit?: string,
): MetricSeries | null {
  const out = (points ?? [])
    .map((p) => ({ timestamp: parseUpstashTime(p.x), value: Number(p.y) }))
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!out.length) return null;
  return { label, ...(unit ? { unit } : {}), points: out };
}
