import { f, o, rt } from "@infrawrench/plugin-base";

export const ManagedRedisResourceType = rt({
  name: "Managed Redis",
  id: "azure-managed-redis",
  description:
    "An Azure Managed Redis cluster (Microsoft.Cache/redisEnterprise): the successor to Azure Cache for Redis, which Microsoft is retiring",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU", { description: "Performance tier and size, e.g. Balanced_B5" }),
    f("provisioningState", "Provisioning State"),
    f("resourceState", "Resource State", { required: false }),
    f("redisVersion", "Redis Version", { required: false }),
    f("highAvailability", "High Availability", { required: false }),
    f("redundancyMode", "Redundancy", { required: false }),
    f("minimumTlsVersion", "Minimum TLS Version", { required: false }),
    f("publicNetworkAccess", "Public Network Access", { required: false }),
    f("clientProtocol", "Client Protocol", {
      required: false,
      description: "Encrypted (TLS) or Plaintext, from the cluster's default database",
    }),
    f("clusteringPolicy", "Clustering Policy", { required: false }),
    f("evictionPolicy", "Eviction Policy", { required: false }),
    f("modules", "Modules", { required: false }),
    f("persistence", "Persistence", {
      required: false,
      description: "AOF, RDB, or None, from the cluster's default database",
    }),
    f("accessKeysAuthentication", "Access Keys Authentication", {
      required: false,
      description:
        "Whether the database accepts access keys. Disabled (the default on new clusters) means Entra ID only, and the key outputs cannot resolve",
    }),
  ],
  outputs: [
    o("hostName", "Hostname"),
    o("port", "Port"),
    o("primaryKey", "Primary Key", { sensitive: true }),
    o("connectionString", "Connection String", {
      sensitive: true,
      description:
        "rediss:// URI for the default database (redis:// when the database is plaintext)",
    }),
    o("resourceId", "Resource ID", { hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  iconKey: "cache",
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Redis",
    },
  ],
  secretExportTemplates: [
    {
      id: "managed-redis-connection",
      displayName: "Redis Connection",
      description: "Azure Managed Redis connection details",
      entries: [
        { envKey: "REDIS_HOST", outputKey: "hostName" },
        { envKey: "REDIS_PORT", outputKey: "port" },
        { envKey: "REDIS_PASSWORD", outputKey: "primaryKey" },
        { envKey: "REDIS_URL", outputKey: "connectionString" },
      ],
    },
  ],
  postureChecks: [
    {
      id: "azure-managed-redis-plaintext",
      title: "Plaintext client protocol",
      severity: "high",
      category: "encryption",
      conditions: [{ fieldKey: "clientProtocol", when: "equals", value: "Plaintext" }],
      reason:
        "The database accepts unencrypted connections, so the access key and cached data cross the network in clear text.",
    },
    {
      id: "azure-managed-redis-no-ha",
      title: "High availability disabled",
      severity: "medium",
      category: "data-protection",
      conditions: [{ fieldKey: "highAvailability", when: "equals", value: "Disabled" }],
      reason:
        "The data set is not replicated, so a single node failure loses the cache contents and the SLA no longer applies.",
    },
  ],
});
