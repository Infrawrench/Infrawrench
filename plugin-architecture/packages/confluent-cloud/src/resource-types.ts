import type { PeerGuidanceAction, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Confluent Cloud resource types. Each names the management API it lists
 * from; field names follow the published spec
 * (https://docs.confluent.io/cloud/current/openapi.yaml, 2026-10).
 *
 * Fields ending in `7d` and the topic/partition counts come from the
 * Metrics API at listing time (one grouped query per metric for every
 * cluster at once), so the idle-resource rules below can be evaluated from
 * synced fields alone. They are absent, never zero, when the Metrics API was
 * not readable: an absent field never matches an orphan rule.
 */

/** Prompt that mints a cluster API key so the Kafka tab can connect. */
export const CREATE_KAFKA_KEY_COMMAND = "create-kafka-api-key";

export const createKafkaKeyAction: PeerGuidanceAction = {
  label: "+ Create Kafka API key",
  command: CREATE_KAFKA_KEY_COMMAND,
  title: "Create a Kafka API key",
  description:
    "Confluent shows a cluster API key's secret exactly once, when it is created. Infrawrench creates the key, stores the secret with this account, and uses it to browse topics and consumer groups and to produce records.",
  submitLabel: "Create key",
  fields: [
    {
      key: "owner",
      label: "Owner",
      kind: "resource-picker",
      required: false,
      associationSources: [
        {
          pluginId: "confluent-cloud",
          resourceTypeId: "service-account",
          outputKey: "serviceAccountId",
        },
      ],
      description:
        "Leave empty to create the key for the owner of this account's Cloud API key, who already has their own access to the cluster. Pick a service account to create the key for it instead.",
    },
    {
      key: "grantRole",
      label: "Grant the service account",
      kind: "select",
      required: false,
      defaultValue: "CloudClusterAdmin",
      showWhen: { fieldKey: "owner", fieldValuesNot: [""] },
      options: [
        {
          id: "CloudClusterAdmin",
          label: "CloudClusterAdmin on this cluster (browse, create and delete topics, produce)",
        },
        { id: "", label: "Nothing: it already has a role binding or ACLs" },
      ],
      description:
        "A service account has no access until it is granted some. Creating the role binding needs the account's Cloud API key to belong to an OrganizationAdmin, EnvironmentAdmin or CloudClusterAdmin.",
    },
  ],
};

/** `GET /org/v2/environments`. */
export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "environment",
  description:
    "A Confluent Cloud environment: the container for Kafka clusters, connectors, Flink compute pools, ksqlDB clusters and Schema Registry. Create, rename or delete one and change its Stream Governance package.",
  fields: [
    f("name", "Name", { description: "Display name shown in Confluent Cloud." }),
    f("streamGovernance", "Stream Governance Package", {
      kind: "enum",
      required: false,
      enumValues: ["ESSENTIALS", "ADVANCED"],
      description:
        "ESSENTIALS includes Schema Registry and basic governance; ADVANCED adds the stream catalog, lineage and data quality rules and is billed per hour. A package can be upgraded but not downgraded.",
    }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("environmentId", "Environment ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "project",
});

/** `GET /cmk/v2/clusters?environment=…`, enriched from the Metrics API. */
export const KafkaClusterResourceType = rt({
  name: "Kafka Cluster",
  id: "kafka-cluster",
  description:
    "A Confluent Cloud Kafka cluster with its type, cloud, region and capacity, throughput, partition and topic counts, connections, consumer lag and CKU utilization. Resize a Dedicated cluster's CKUs or an elastic cluster's eCKU ceiling, and browse topics and consumer groups through the Kafka tab.",
  parentTypeId: "environment",
  showInSidebar: true,
  fields: [
    f("name", "Name", { description: "Display name shown in Confluent Cloud." }),
    f("cku", "CKUs", {
      kind: "number",
      required: false,
      description:
        "Confluent Kafka Units for a Dedicated cluster. Multi-zone clusters need at least 2. Billing follows the new size from the next hour; a shrink can be refused while the cluster's load needs the current capacity.",
    }),
    f("maxEcku", "Max eCKUs", {
      kind: "number",
      required: false,
      description:
        "The elastic ceiling for a Basic, Standard, Enterprise or Freight cluster: it scales up to this many eCKUs and bills only for what it uses each hour.",
    }),
    f("clusterType", "Type", { required: false, editable: false }),
    f("availability", "Availability", { required: false, editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("placement", "Placement", {
      required: false,
      editable: false,
      description: "Cloud, region and availability together; what CKU pricing depends on.",
    }),
    f("phase", "Status", { required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    f("networkId", "Network", { required: false, editable: false }),
    f("bootstrapEndpoint", "Bootstrap Endpoint", { required: false, editable: false }),
    f("restEndpoint", "REST Endpoint", { required: false, editable: false }),
    f("topics", "Topics", { kind: "number", required: false, editable: false }),
    f("partitions", "Partitions", { kind: "number", required: false, editable: false }),
    f("retainedBytes", "Retained Bytes", { kind: "number", required: false, editable: false }),
    f("bytesIn7d", "Bytes In (7 days)", { kind: "number", required: false, editable: false }),
    f("bytesOut7d", "Bytes Out (7 days)", { kind: "number", required: false, editable: false }),
    f("idle", "No Traffic for 7 Days", { required: false, editable: false }),
    f("deletionProtection", "Deletion Protection", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("clusterId", "Cluster ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("clusterId", "Cluster ID"),
    o("bootstrapServers", "Bootstrap Servers"),
    o("restEndpoint", "REST Endpoint"),
    o("connectionString", "Kafka Connection URL", { sensitive: true, hidden: true }),
  ],
  dependsOn: [{ fieldKey: "environmentId", targetTypeId: "environment", label: "in" }],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      // The existing Kafka plugin's topic browser, consumer groups and
      // produce panel, over SASL/PLAIN with a cluster API key this plugin
      // mints and stores (`create-kafka-api-key`).
      pluginId: "kafka",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Kafka",
      requiresFields: ["bootstrapEndpoint"],
      credentialSetupAction: createKafkaKeyAction,
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "idle", when: "equals", value: "true" }],
    reason:
      "No bytes produced or consumed in the last 7 days; the cluster still bills for its capacity and storage",
  },
  rightsizing: {
    // The CKU count is the size; "vCPUs" in the catalog are CKUs, so the
    // projected load after a resize is p95 load x current / candidate CKUs.
    sizeFieldKey: "cku",
    regionFieldKey: "placement",
    cpuMetric: { seriesLabel: "CKU utilization", scale: "percent" },
    resizeNote:
      "Dedicated clusters resize online. Billing follows the new CKU count from the next hour, and Confluent can refuse a shrink while partitions, connections or throughput need the current capacity.",
  },
  iconKey: "kafka",
});

/** `GET /connect/v1/environments/{env}/clusters/{lkc}/connectors?expand=…`. */
export const ConnectorResourceType = rt({
  name: "Connector",
  id: "connector",
  description:
    "A fully managed Kafka Connect connector. Pause, resume or restart it, see its tasks and records in and out, and delete it.",
  parentTypeId: "kafka-cluster",
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("connectorClass", "Connector", { required: false, editable: false }),
    f("connectorType", "Type", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("tasks", "Tasks", { kind: "number", required: false, editable: false }),
    f("failedTasks", "Failed Tasks", { kind: "number", required: false, editable: false }),
    f("trace", "Last Error", { required: false, editable: false }),
    f("connectorId", "Connector ID", { required: false, editable: false }),
    f("clusterId", "Kafka Cluster ID", { required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    f("recordsIn7d", "Records In (7 days)", { kind: "number", required: false, editable: false }),
    f("recordsOut7d", "Records Out (7 days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("idle", "No Records for 7 Days", { required: false, editable: false }),
  ],
  outputs: [o("connectorId", "Connector ID")],
  dependsOn: [{ fieldKey: "clusterId", targetTypeId: "kafka-cluster", label: "runs on" }],
  supportsDelete: true,
  supportsMetrics: true,
  orphanRule: {
    conditions: [{ fieldKey: "idle", when: "equals", value: "true" }],
    reason:
      "No records moved in the last 7 days; task hours keep billing whether or not data flows (a paused connector bills too)",
  },
  iconKey: "pipeline",
});

/** `GET /fcpm/v2/compute-pools?environment=…`. */
export const FlinkComputePoolResourceType = rt({
  name: "Flink Compute Pool",
  id: "flink-compute-pool",
  description:
    "A Confluent Cloud for Apache Flink compute pool. Create one in any Flink region, change its CFU ceiling, chart current CFUs against the limit, and delete it.",
  parentTypeId: "environment",
  showInSidebar: true,
  fields: [
    f("name", "Name"),
    f("maxCfu", "Max CFUs", {
      kind: "enum",
      enumValues: ["5", "10", "20", "30", "40", "50"],
      description:
        "The most Confluent Flink Units the pool may scale to. Statements are billed per CFU-minute actually used, up to this ceiling.",
    }),
    f("currentCfu", "Current CFUs", { kind: "number", required: false, editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("phase", "Status", { required: false, editable: false }),
    f("defaultPool", "Default Pool", { kind: "boolean", required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    f("poolId", "Compute Pool ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("poolId", "Compute Pool ID")],
  dependsOn: [{ fieldKey: "environmentId", targetTypeId: "environment", label: "in" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "compute",
});

/** `GET /ksqldbcm/v2/clusters?environment=…`. */
export const KsqlClusterResourceType = rt({
  name: "ksqlDB Cluster",
  id: "ksqldb-cluster",
  description:
    "A fully managed ksqlDB cluster with its CSUs, the Kafka cluster it runs against, query saturation, storage utilization and processing errors.",
  parentTypeId: "environment",
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("csu", "CSUs", { kind: "number", required: false, editable: false }),
    f("phase", "Status", { required: false, editable: false }),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    f("kafkaClusterId", "Kafka Cluster ID", { required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    f("endpoint", "Endpoint", { required: false, editable: false }),
    f("storageGb", "Storage (GB)", { kind: "number", required: false, editable: false }),
    f("topicPrefix", "Topic Prefix", { required: false, editable: false }),
    f("ksqlId", "ksqlDB Cluster ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("ksqlId", "ksqlDB Cluster ID"), o("endpoint", "Endpoint")],
  dependsOn: [{ fieldKey: "kafkaClusterId", targetTypeId: "kafka-cluster", label: "reads from" }],
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "stream",
});

/** `GET /srcm/v3/clusters?environment=…`. */
export const SchemaRegistryResourceType = rt({
  name: "Schema Registry",
  plural: "Schema Registries",
  id: "schema-registry",
  description:
    "An environment's Schema Registry: its Stream Governance package, cloud and region, endpoints, and charts of registered schemas and requests.",
  parentTypeId: "environment",
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("package", "Package", { required: false, editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("phase", "Status", { required: false, editable: false }),
    f("endpoint", "Endpoint", { required: false, editable: false }),
    f("privateEndpoint", "Private Endpoint", { required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    f("registryId", "Schema Registry ID", { required: false, editable: false }),
  ],
  outputs: [o("registryId", "Schema Registry ID"), o("endpoint", "Endpoint")],
  supportsMetrics: true,
  iconKey: "layers",
});

/** `GET /iam/v2/service-accounts`. */
export const ServiceAccountResourceType = rt({
  name: "Service Account",
  id: "service-account",
  description:
    "A Confluent Cloud service account: the identity applications and connectors authenticate as. Create one, edit its description, see the API keys it owns, and delete it.",
  fields: [
    f("name", "Name", {
      editable: false,
      description: "Unique within the organization and cannot be changed after creation.",
    }),
    f("description", "Description", { required: false }),
    f("serviceAccountId", "Service Account ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("serviceAccountId", "Service Account ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  principalRole: { role: "service-account", createdKey: "createdAt" },
  iconKey: "user",
});

/** `GET /iam/v2/api-keys`. Metadata only: the secret is never returned again. */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "A Confluent Cloud API key: Cloud keys for the management and Metrics APIs, and cluster keys for one Kafka cluster, Schema Registry, ksqlDB or Flink region. Listed with owner and scope; edit the name and description, or delete a key to revoke it.",
  fields: [
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("ownerKind", "Owner Type", { required: false, editable: false }),
    f("scope", "Scope", { required: false, editable: false }),
    f("scopeKind", "Scope Type", { required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    f("keyId", "Key", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("keyId", "Key")],
  supportsUpdate: true,
  supportsDelete: true,
  principalRole: { role: "key", createdKey: "createdAt", parentKey: "owner" },
  iconKey: "key",
});

/** `GET /networking/v1/networks?environment=…`. */
export const NetworkResourceType = rt({
  name: "Network",
  id: "network",
  description:
    "A Confluent Cloud network for Dedicated and Enterprise clusters: cloud, region, CIDR, the connection types it supports (private link, peering, transit gateway) and its DNS domain.",
  parentTypeId: "environment",
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("connectionTypes", "Connection Types", { required: false, editable: false }),
    f("cidr", "CIDR", { required: false, editable: false }),
    f("zones", "Zones", { required: false, editable: false }),
    f("phase", "Status", { required: false, editable: false }),
    f("dnsDomain", "DNS Domain", { required: false, editable: false }),
    f("idleSince", "Idle Since", { required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    f("networkId", "Network ID", { required: false, editable: false }),
  ],
  outputs: [o("networkId", "Network ID"), o("dnsDomain", "DNS Domain")],
  orphanRule: {
    conditions: [{ fieldKey: "idleSince", when: "notEquals", value: "" }],
    reason: "Confluent reports this network as idle: no cluster or connection uses it",
  },
  iconKey: "network",
});

/**
 * Private networking attachments in one list: peerings, transit gateway
 * attachments and private link accesses (`/networking/v1/...` per kind, all
 * environment-scoped), plus the serverless private link attachments that
 * Enterprise clusters and Flink use.
 */
export const NetworkConnectionResourceType = rt({
  name: "Private Network Connection",
  id: "network-connection",
  description:
    "A private connection into Confluent Cloud: a VPC or VNet peering, a transit gateway attachment, a private link access for a network, or a private link attachment for serverless clusters.",
  parentTypeId: "environment",
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("connectionKind", "Kind", { required: false, editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("networkId", "Network", { required: false, editable: false }),
    f("phase", "Status", { required: false, editable: false }),
    f("error", "Error", { required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    f("connectionId", "Connection ID", { required: false, editable: false }),
  ],
  outputs: [o("connectionId", "Connection ID")],
  dependsOn: [{ fieldKey: "networkId", targetTypeId: "network", label: "attached to" }],
  iconKey: "network",
});

/** `GET /byok/v1/keys`. */
export const EncryptionKeyResourceType = rt({
  name: "Encryption Key",
  id: "encryption-key",
  description:
    "A self-managed encryption key (bring your own key) registered with Confluent Cloud to encrypt Dedicated and Enterprise cluster storage: provider, key reference, state and validation.",
  fields: [
    f("name", "Name", { editable: false }),
    f("provider", "Provider", { required: false, editable: false }),
    f("keyReference", "Key", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("validation", "Validation", { required: false, editable: false }),
    f("validationRegion", "Validation Region", { required: false, editable: false }),
    f("keyId", "Key ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("keyId", "Key ID")],
  iconKey: "key",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  EnvironmentResourceType,
  KafkaClusterResourceType,
  ConnectorResourceType,
  FlinkComputePoolResourceType,
  KsqlClusterResourceType,
  SchemaRegistryResourceType,
  ServiceAccountResourceType,
  ApiKeyResourceType,
  NetworkResourceType,
  NetworkConnectionResourceType,
  EncryptionKeyResourceType,
];
