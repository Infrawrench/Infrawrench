import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const T = {
  account: "upstash-account",
  redis: "upstash-redis",
  vector: "upstash-vector",
  search: "upstash-search",
  qstash: "upstash-qstash",
  schedule: "upstash-qstash-schedule",
  queue: "upstash-qstash-queue",
  urlGroup: "upstash-qstash-url-group",
  team: "upstash-team",
} as const;

/** Redis regions per platform (Developer API `primary_region` enum, 2026-10). */
export const REDIS_REGIONS: Array<{ id: string; label: string; platform: "aws" | "gcp" }> = [
  { id: "us-east-1", label: "N. Virginia, USA", platform: "aws" },
  { id: "us-east-2", label: "Ohio, USA", platform: "aws" },
  { id: "us-west-1", label: "N. California, USA", platform: "aws" },
  { id: "us-west-2", label: "Oregon, USA", platform: "aws" },
  { id: "ca-central-1", label: "Montreal, Canada", platform: "aws" },
  { id: "eu-central-1", label: "Frankfurt, Germany", platform: "aws" },
  { id: "eu-west-1", label: "Ireland", platform: "aws" },
  { id: "eu-west-2", label: "London, UK", platform: "aws" },
  { id: "sa-east-1", label: "São Paulo, Brazil", platform: "aws" },
  { id: "ap-south-1", label: "Mumbai, India", platform: "aws" },
  { id: "ap-northeast-1", label: "Tokyo, Japan", platform: "aws" },
  { id: "ap-southeast-1", label: "Singapore", platform: "aws" },
  { id: "ap-southeast-2", label: "Sydney, Australia", platform: "aws" },
  { id: "af-south-1", label: "Cape Town, South Africa", platform: "aws" },
  { id: "us-central1", label: "Iowa, USA", platform: "gcp" },
  { id: "us-east4", label: "N. Virginia, USA", platform: "gcp" },
  { id: "europe-west1", label: "Belgium", platform: "gcp" },
  { id: "asia-northeast1", label: "Tokyo, Japan", platform: "gcp" },
];

export const REDIS_PLANS = [
  "free",
  "payg",
  "fixed_250mb",
  "fixed_1gb",
  "fixed_5gb",
  "fixed_10gb",
  "fixed_50gb",
  "fixed_100gb",
  "fixed_500gb",
];

export const QSTASH_PLANS = ["paid", "qstash_fixed_1m", "qstash_fixed_10m", "qstash_fixed_100m"];

const AccountType = rt({
  name: "Account",
  id: T.account,
  description: "The Upstash account the Developer API key belongs to, with its audit log",
  pinnable: false,
  fields: [
    f("email", "Email", { editable: false }),
    f("redisCount", "Redis Databases", { kind: "number", required: false, editable: false }),
    f("vectorCount", "Vector Indexes", { kind: "number", required: false, editable: false }),
    f("searchCount", "Search Indexes", { kind: "number", required: false, editable: false }),
    f("teamCount", "Teams", { kind: "number", required: false, editable: false }),
  ],
  iconKey: "account",
  supportsDelete: false,
});

const RedisType = rt({
  name: "Redis Database",
  id: T.redis,
  description:
    "A serverless Upstash Redis database, with its read regions, plan, budget and backups",
  fields: [
    f("name", "Name", { description: "Renames the database." }),
    f("state", "State", { required: false, editable: false }),
    f("platform", "Cloud", { required: false, editable: false }),
    f("region", "Primary Region", { required: false, editable: false }),
    f("readRegions", "Read Regions", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("budget", "Monthly Budget (USD)", {
      kind: "number",
      required: false,
      description: "Pay-as-you-go spending cap; the database is throttled when it is reached.",
    }),
    f("eviction", "Eviction", {
      kind: "boolean",
      required: false,
      description: "Evict keys instead of rejecting writes when the database is full.",
    }),
    f("autoUpgrade", "Auto Upgrade", {
      kind: "boolean",
      required: false,
      description: "Move to the next plan automatically when a limit is reached.",
    }),
    f("dailyBackup", "Daily Backup", { kind: "boolean", required: false }),
    f("tls", "TLS", { kind: "boolean", required: false, editable: false }),
    f("prodPack", "Production Pack", { kind: "boolean", required: false, editable: false }),
    f("endpoint", "Endpoint", { required: false, editable: false }),
    f("port", "Port", { kind: "number", required: false, editable: false }),
    f("diskLimitGb", "Storage Limit (GB)", { kind: "number", required: false, editable: false }),
    f("maxCommandsPerSecond", "Max Commands/s", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maxClients", "Max Connections", { kind: "number", required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("host", "Host"),
    o("port", "Port"),
    o("password", "Password", { sensitive: true }),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "rediss:// (or redis://) URL for the default user",
    }),
    o("restUrl", "REST URL", { description: "https:// endpoint for @upstash/redis" }),
    o("restToken", "REST Token", { sensitive: true }),
    o("readOnlyRestToken", "Read-only REST Token", { sensitive: true }),
  ],
  peerIntegrations: [
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Redis",
      exposeMetricsToParent: true,
    },
  ],
  secretExportTemplates: [
    {
      id: "upstash-redis-rest",
      displayName: "Upstash Redis REST",
      description: "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for @upstash/redis",
      entries: [
        { envKey: "UPSTASH_REDIS_REST_URL", outputKey: "restUrl" },
        { envKey: "UPSTASH_REDIS_REST_TOKEN", outputKey: "restToken" },
      ],
    },
    {
      id: "upstash-redis-url",
      displayName: "Redis URL",
      description: "A single REDIS_URL for any Redis client",
      entries: [{ envKey: "REDIS_URL", outputKey: "connectionString" }],
    },
  ],
  postureChecks: [
    {
      id: "upstash-redis-no-tls",
      title: "TLS not enabled",
      severity: "high",
      category: "encryption",
      conditions: [{ fieldKey: "tls", when: "falsy" }],
      reason:
        "Clients can connect without TLS, so the password and data cross the network in clear text. Enable TLS (it cannot be turned off again).",
    },
    {
      id: "upstash-redis-no-backup",
      title: "Daily backup disabled",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "dailyBackup", when: "falsy" }],
      reason: "No daily backup is taken; a bad write or FLUSHALL cannot be undone.",
    },
  ],
  iconKey: "cache",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
});

const VectorType = rt({
  name: "Vector Index",
  id: T.vector,
  description:
    "An Upstash Vector index (dense, sparse or hybrid) with its REST endpoint and tokens",
  fields: [
    f("name", "Name", { description: "Renames the index." }),
    f("region", "Region", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("indexType", "Index Type", { required: false, editable: false }),
    f("similarity", "Similarity", { required: false, editable: false }),
    f("dimensions", "Dimensions", { kind: "number", required: false, editable: false }),
    f("embeddingModel", "Embedding Model", { required: false, editable: false }),
    f("sparseEmbeddingModel", "Sparse Embedding Model", { required: false, editable: false }),
    f("endpoint", "Endpoint", { required: false, editable: false }),
    f("maxVectors", "Max Vectors", { kind: "number", required: false, editable: false }),
    f("maxDailyQueries", "Max Daily Queries", { kind: "number", required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("restUrl", "REST URL"),
    o("token", "Token", { sensitive: true }),
    o("readOnlyToken", "Read-only Token", { sensitive: true }),
  ],
  secretExportTemplates: [
    {
      id: "upstash-vector",
      displayName: "Upstash Vector",
      description: "UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN",
      entries: [
        { envKey: "UPSTASH_VECTOR_REST_URL", outputKey: "restUrl" },
        { envKey: "UPSTASH_VECTOR_REST_TOKEN", outputKey: "token" },
      ],
    },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
});

const SearchType = rt({
  name: "Search Index",
  id: T.search,
  description: "An Upstash Search index with its REST endpoint and tokens",
  fields: [
    f("name", "Name", { description: "Renames the index." }),
    f("region", "Region", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("endpoint", "Endpoint", { required: false, editable: false }),
    f("maxDocuments", "Max Documents", { kind: "number", required: false, editable: false }),
    f("maxDailyQueries", "Max Daily Queries", { kind: "number", required: false, editable: false }),
    f("inputEnrichment", "Input Enrichment", { kind: "boolean", required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("restUrl", "REST URL"),
    o("token", "Token", { sensitive: true }),
    o("readOnlyToken", "Read-only Token", { sensitive: true }),
  ],
  secretExportTemplates: [
    {
      id: "upstash-search",
      displayName: "Upstash Search",
      description: "UPSTASH_SEARCH_REST_URL and UPSTASH_SEARCH_REST_TOKEN",
      entries: [
        { envKey: "UPSTASH_SEARCH_REST_URL", outputKey: "restUrl" },
        { envKey: "UPSTASH_SEARCH_REST_TOKEN", outputKey: "token" },
      ],
    },
  ],
  iconKey: "search",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
});

const QStashType = rt({
  name: "QStash",
  id: T.qstash,
  plural: "QStash Accounts",
  description:
    "A regional QStash account: plan, budget and limits, signing keys, the dead letter queue and message logs",
  fields: [
    f("region", "Region", { editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("reservedPlan", "Fixed Plan", { required: false, editable: false }),
    f("budget", "Monthly Budget (USD)", {
      kind: "number",
      required: false,
      description: "20 to 10000, or 0 for no limit.",
    }),
    f("prodPack", "Production Pack", { kind: "boolean", required: false, editable: false }),
    f("maxRequestsPerDay", "Max Messages/Day", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maxRequestsPerSecond", "Max Messages/s", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maxSchedules", "Max Schedules", { kind: "number", required: false, editable: false }),
    f("maxQueues", "Max Queues", { kind: "number", required: false, editable: false }),
    f("maxTopics", "Max URL Groups", { kind: "number", required: false, editable: false }),
    f("maxRetries", "Max Retries", { kind: "number", required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("url", "QStash URL"),
    o("token", "Token", { sensitive: true }),
    o("readOnlyToken", "Read-only Token", { sensitive: true }),
    o("currentSigningKey", "Current Signing Key", { sensitive: true }),
    o("nextSigningKey", "Next Signing Key", { sensitive: true }),
  ],
  secretExportTemplates: [
    {
      id: "upstash-qstash",
      displayName: "QStash",
      description: "QStash token and signing keys for the SDK and receivers",
      entries: [
        { envKey: "QSTASH_URL", outputKey: "url" },
        { envKey: "QSTASH_TOKEN", outputKey: "token" },
        { envKey: "QSTASH_CURRENT_SIGNING_KEY", outputKey: "currentSigningKey" },
        { envKey: "QSTASH_NEXT_SIGNING_KEY", outputKey: "nextSigningKey" },
      ],
    },
  ],
  iconKey: "queue",
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
});

const ScheduleType = rt({
  name: "Schedule",
  id: T.schedule,
  description: "A QStash schedule: a message published to a URL, URL group or queue on a cron",
  parentTypeId: T.qstash,
  showInSidebar: true,
  fields: [
    f("cron", "Cron", { editable: false }),
    f("destination", "Destination", { editable: false }),
    f("method", "Method", { required: false, editable: false }),
    f("retries", "Retries", { kind: "number", required: false, editable: false }),
    f("delay", "Delay (s)", { kind: "number", required: false, editable: false }),
    f("callback", "Callback", { required: false, editable: false }),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    f("labels", "Labels", { required: false, editable: false }),
    f("lastRun", "Last Run", { required: false, editable: false }),
    f("nextRun", "Next Run", { required: false, editable: false }),
    f("qstashId", "QStash Account", { editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [
    { fieldKey: "qstashId", targetTypeId: T.qstash, label: "in" },
    {
      fieldKey: "destination",
      targetTypeId: T.urlGroup,
      matchTemplate: "{qstashId}/{destination}",
      label: "publishes to",
    },
  ],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "pause",
    statusFieldKey: "paused",
    runningValues: ["false"],
    stoppedValues: ["true"],
  },
  iconKey: "clock",
  supportsCreate: true,
  supportsDelete: true,
});

const QueueType = rt({
  name: "Queue",
  id: T.queue,
  description: "A QStash queue: ordered delivery with a fixed number of parallel consumers",
  parentTypeId: T.qstash,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("parallelism", "Parallelism", {
      kind: "number",
      required: false,
      description: "How many messages are delivered at the same time.",
    }),
    f("lag", "Waiting Messages", { kind: "number", required: false, editable: false }),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    f("qstashId", "QStash Account", { editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "qstashId", targetTypeId: T.qstash, label: "in" }],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "pause",
    statusFieldKey: "paused",
    runningValues: ["false"],
    stoppedValues: ["true"],
  },
  iconKey: "queue",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const UrlGroupType = rt({
  name: "URL Group",
  id: T.urlGroup,
  description: "A QStash URL group (topic): one message fanned out to every endpoint in it",
  parentTypeId: T.qstash,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("endpoints", "Endpoints", {
      required: false,
      description: "Comma-separated endpoint URLs. Saving replaces the list.",
    }),
    f("endpointCount", "Endpoint Count", { kind: "number", required: false, editable: false }),
    f("qstashId", "QStash Account", { editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "qstashId", targetTypeId: T.qstash, label: "in" }],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const TeamType = rt({
  name: "Team",
  id: T.team,
  description: "An Upstash team and its members",
  fields: [
    f("name", "Name", { editable: false }),
    f("members", "Members", { kind: "number", required: false, editable: false }),
    f("role", "Your Role", { required: false, editable: false }),
  ],
  iconKey: "users",
  supportsCreate: true,
  supportsDelete: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountType,
  RedisType,
  VectorType,
  SearchType,
  QStashType,
  ScheduleType,
  QueueType,
  UrlGroupType,
  TeamType,
];
