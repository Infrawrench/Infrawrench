import { f, o, rt } from "@infrawrench/plugin-base";

/** Node types Memorystore for Valkey accepts (`NodeType` enum, v1 API). */
export const VALKEY_NODE_TYPES = [
  "SHARED_CORE_NANO",
  "CUSTOM_PICO",
  "CUSTOM_MICRO",
  "CUSTOM_MINI",
  "STANDARD_SMALL",
  "HIGHMEM_MEDIUM",
  "HIGHCPU_MEDIUM",
  "STANDARD_LARGE",
  "HIGHMEM_XLARGE",
  "HIGHMEM_2XLARGE",
] as const;

/**
 * Valkey engine versions the service offers, newest first. VALKEY_9_0 is the
 * default for new instances; VALKEY_9_1 is in Preview.
 */
export const VALKEY_ENGINE_VERSIONS = ["VALKEY_9_1", "VALKEY_9_0", "VALKEY_8_0", "VALKEY_7_2"];

export const MemorystoreValkeyResourceType = rt({
  name: "Memorystore Valkey",
  plural: "Memorystore Valkey Instances",
  id: "memorystore-valkey",
  description:
    "A Google Cloud Memorystore for Valkey instance, in cluster mode or cluster-mode-disabled",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { editable: false }),
    f("mode", "Mode", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["CLUSTER", "CLUSTER_DISABLED"],
    }),
    f("nodeType", "Node Type", {
      kind: "enum",
      required: false,
      enumValues: [...VALKEY_NODE_TYPES],
      description: "Machine size of every node. Scaling the node type is an online operation",
    }),
    f("engineVersion", "Engine Version", {
      kind: "enum",
      required: false,
      enumValues: VALKEY_ENGINE_VERSIONS,
      description: "Valkey version. Upgrades are one-way; downgrades are rejected",
    }),
    f("shardCount", "Shards", {
      kind: "number",
      required: false,
      description: "Number of shards. Cluster-mode-disabled instances always have one",
    }),
    f("replicaCount", "Replicas Per Shard", {
      kind: "number",
      required: false,
      description: "Read replicas per shard, 0 to 5",
    }),
    f("deletionProtectionEnabled", "Deletion Protection", {
      kind: "boolean",
      required: false,
      description: "While on, deleting the instance fails",
    }),
    f("state", "State", { required: false, editable: false }),
    f("authorizationMode", "Authorization", { required: false, editable: false }),
    f("transitEncryptionMode", "In-transit Encryption", { required: false, editable: false }),
    f("persistenceMode", "Persistence", { required: false, editable: false }),
    f("network", "Network", {
      required: false,
      editable: false,
      description:
        "Name of the VPC network the instance's Private Service Connect endpoints sit in",
    }),
  ],
  dependsOn: [
    { fieldKey: "network", targetTypeId: "vpc-network", targetKey: "name", label: "in network" },
  ],
  outputs: [
    o("host", "Host"),
    o("port", "Port"),
    o("readerHost", "Reader Host"),
    o("valkeyUrl", "Valkey URL"),
  ],
  supportsCreate: true,
  // Edit = scale (node type, shards, replicas), engine upgrade and deletion
  // protection: the fields instances.patch accepts in its updateMask.
  supportsUpdate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "valkey-connection",
      displayName: "Valkey Connection",
      description: "Host and port for Valkey (or Redis OSS) client connections",
      entries: [
        { envKey: "VALKEY_HOST", outputKey: "host" },
        { envKey: "VALKEY_PORT", outputKey: "port" },
      ],
    },
    {
      id: "valkey-url",
      displayName: "Valkey URL",
      description:
        "Single REDIS_URL in redis://<host>:<port> format (rediss:// with in-transit encryption)",
      entries: [{ envKey: "REDIS_URL", outputKey: "valkeyUrl" }],
    },
  ],
});
