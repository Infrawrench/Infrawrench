import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const T = {
  project: "aiven-project",
  service: "aiven-service",
  user: "aiven-service-user",
  database: "aiven-database",
  pool: "aiven-connection-pool",
  topic: "aiven-kafka-topic",
  acl: "aiven-kafka-acl",
  connector: "aiven-kafka-connector",
  subject: "aiven-schema-subject",
  integration: "aiven-integration",
  vpc: "aiven-vpc",
  peering: "aiven-vpc-peering",
  billingGroup: "aiven-billing-group",
} as const;

export const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const inProject = { fieldKey: "project", targetTypeId: T.project, label: "in project" };
const onService = {
  fieldKey: "serviceName",
  targetTypeId: T.service,
  matchTemplate: "{project}/{serviceName}",
  label: "on service",
};

const ProjectType = rt({
  name: "Project",
  id: T.project,
  description: "An Aiven project: services, VPCs and integrations billed to one billing group",
  fields: [
    f("name", "Name", { editable: false }),
    f("defaultCloud", "Default Cloud", { required: false, editable: false }),
    f("billingGroupId", "Billing Group", { required: false, editable: false }),
    f("billingGroupName", "Billing Group Name", { required: false, editable: false }),
    f("organizationId", "Organization", { required: false, editable: false }),
    f("estimatedBalance", "Estimated Balance (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("paymentMethod", "Payment Method", { required: false, editable: false }),
    f("techEmails", "Technical Contacts", {
      required: false,
      description: "Comma-separated emails Aiven sends maintenance and incident notices to.",
    }),
    f("tags", "Tags", { required: false, editable: false }),
    f("trialExpires", "Trial Expires", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "billingGroupId", targetTypeId: T.billingGroup, label: "billed to" }],
  expiryFields: [{ fieldKey: "trialExpires", from: "expiry", kind: "other", label: "Trial ends" }],
  iconKey: "folder",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const ServiceType = rt({
  name: "Service",
  id: T.service,
  description:
    "An Aiven service: PostgreSQL, MySQL, Kafka, Kafka Connect, OpenSearch, ClickHouse, Valkey, Grafana, Flink and the rest",
  parentTypeId: T.project,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("project", "Project", { editable: false }),
    f("serviceType", "Type", { editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("cloudDescription", "Location", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("cpuPerNode", "CPUs per Node", { kind: "number", required: false, editable: false }),
    f("memoryMbPerNode", "Memory per Node (MB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("diskSpaceMb", "Disk (MB)", {
      kind: "number",
      required: false,
      description:
        "Total disk for data. Can be raised above the plan's default (billed extra); lowering is limited to the plan default.",
    }),
    f("terminationProtection", "Termination Protection", {
      kind: "boolean",
      required: false,
      description: "Blocks deleting and powering off the service until it is turned off.",
    }),
    f("maintenanceDow", "Maintenance Day", { kind: "enum", enumValues: DAYS, required: false }),
    f("maintenanceTime", "Maintenance Time (UTC)", {
      required: false,
      description: "HH:MM:SS in UTC, e.g. 03:00:00.",
    }),
    f("pendingMaintenance", "Pending Maintenance Updates", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("projectVpcId", "VPC", { required: false, editable: false }),
    f("host", "Host", { required: false, editable: false }),
    f("port", "Port", { kind: "number", required: false, editable: false }),
    f("kafkaSasl", "Kafka SASL Endpoint", { required: false, editable: false }),
    f("integrations", "Integrations", { kind: "number", required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("connectionString", "Service URI", {
      sensitive: true,
      description: "Admin connection URI (for Kafka with SASL, a kafka:// URL with the CA inlined)",
    }),
    o("host", "Host"),
    o("port", "Port"),
    o("username", "Admin Username"),
    o("password", "Admin Password", { sensitive: true }),
    o("database", "Default Database"),
    o("caCertificate", "Project CA Certificate", {
      description: "PEM CA that signs the service's TLS certificate",
      hidden: true,
    }),
  ],
  dependsOn: [
    inProject,
    {
      fieldKey: "projectVpcId",
      targetTypeId: T.vpc,
      matchTemplate: "{project}/{projectVpcId}",
      label: "in VPC",
    },
  ],
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "connectionString" },
        { outputKey: "caCertificate", credentialKey: "caCert" },
      ],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "serviceType", equals: "pg" },
    },
    {
      pluginId: "mysql",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "connectionString" },
        { outputKey: "caCertificate", credentialKey: "caCert" },
      ],
      tabLabel: "MySQL",
      showWhen: { fieldKey: "serviceType", equals: "mysql" },
    },
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Valkey",
      showWhen: { fieldKey: "serviceType", equals: "valkey" },
    },
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Dragonfly",
      showWhen: { fieldKey: "serviceType", equals: "dragonfly" },
    },
    {
      pluginId: "kafka",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Kafka",
      showWhen: { fieldKey: "serviceType", equals: "kafka" },
      unreachableWhen: {
        fieldsEmpty: ["kafkaSasl"],
        title:
          "This Kafka service only accepts client certificates, which the Kafka console cannot use.",
        suggestions: [
          "Turn on SASL authentication in the service's advanced configuration (kafka_authentication_methods.sasl), then refresh.",
        ],
      },
    },
    {
      pluginId: "opensearch",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "endpoint" }],
      tabLabel: "OpenSearch",
      showWhen: { fieldKey: "serviceType", equals: "opensearch" },
    },
  ],
  secretExportTemplates: [
    {
      id: "aiven-service-uri",
      displayName: "Service URI",
      description: "The admin connection URI as DATABASE_URL",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
  lifecycle: {
    startActionId: "power-on",
    stopActionId: "power-off",
    statusFieldKey: "state",
    runningValues: ["RUNNING"],
    stoppedValues: ["POWEROFF"],
  },
  postureChecks: [
    {
      id: "aiven-service-no-termination-protection",
      title: "Termination protection off",
      severity: "low",
      category: "data-protection",
      conditions: [
        { fieldKey: "terminationProtection", when: "falsy" },
        { fieldKey: "serviceType", when: "notEquals", value: "grafana" },
      ],
      reason:
        "The service, and every backup, can be deleted in one step. Turn termination protection on for anything holding data you need.",
    },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
});

const UserType = rt({
  name: "Service User",
  id: T.user,
  description: "A user of an Aiven service (database role, Kafka user, Valkey ACL user)",
  parentTypeId: T.service,
  fields: [
    f("username", "Username", { editable: false }),
    f("project", "Project", { editable: false }),
    f("serviceName", "Service", { editable: false }),
    f("serviceType", "Service Type", { required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("authentication", "Authentication", { required: false, editable: false }),
    f("certExpires", "Access Certificate Expires", { required: false, editable: false }),
    f("passwordUpdated", "Password Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("password", "Password", { sensitive: true }),
    o("accessCert", "Access Certificate", { hidden: true }),
    o("accessKey", "Access Key", { sensitive: true, hidden: true }),
  ],
  dependsOn: [onService],
  expiryFields: [
    {
      fieldKey: "certExpires",
      from: "expiry",
      kind: "tls-cert",
      label: "Kafka access certificate expires",
    },
  ],
  iconKey: "user",
  supportsCreate: true,
  supportsDelete: true,
});

const DatabaseType = rt({
  name: "Database",
  id: T.database,
  description: "A logical database inside an Aiven PostgreSQL or MySQL service",
  parentTypeId: T.service,
  fields: [
    f("name", "Name", { editable: false }),
    f("project", "Project", { editable: false }),
    f("serviceName", "Service", { editable: false }),
    f("serviceType", "Service Type", { required: false, editable: false }),
  ],
  dependsOn: [onService],
  iconKey: "database",
  supportsCreate: true,
  supportsDelete: true,
});

const PoolType = rt({
  name: "Connection Pool",
  id: T.pool,
  description: "A PgBouncer connection pool in front of an Aiven PostgreSQL database",
  parentTypeId: T.service,
  fields: [
    f("name", "Name", { editable: false }),
    f("project", "Project", { editable: false }),
    f("serviceName", "Service", { editable: false }),
    f("database", "Database", { required: false }),
    f("username", "User", { required: false }),
    f("poolMode", "Pool Mode", {
      kind: "enum",
      enumValues: ["transaction", "session", "statement"],
      required: false,
    }),
    f("poolSize", "Pool Size", { kind: "number", required: false }),
  ],
  outputs: [o("connectionString", "Pool URI", { sensitive: true })],
  dependsOn: [
    onService,
    {
      fieldKey: "database",
      targetTypeId: T.database,
      matchTemplate: "{project}/{serviceName}/{database}",
      label: "for database",
    },
  ],
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
    },
  ],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const TopicType = rt({
  name: "Kafka Topic",
  id: T.topic,
  description: "A topic on an Aiven for Apache Kafka service",
  parentTypeId: T.service,
  fields: [
    f("name", "Name", { editable: false }),
    f("project", "Project", { editable: false }),
    f("serviceName", "Service", { editable: false }),
    f("partitions", "Partitions", {
      kind: "number",
      required: false,
      description: "Partitions can be added but never removed.",
    }),
    f("replication", "Replication", { kind: "number", required: false }),
    f("retentionHours", "Retention (hours)", {
      kind: "number",
      required: false,
      description: "-1 keeps messages forever.",
    }),
    f("minInsyncReplicas", "Min In-sync Replicas", { kind: "number", required: false }),
    f("cleanupPolicy", "Cleanup Policy", {
      kind: "enum",
      enumValues: ["delete", "compact", "compact,delete"],
      required: false,
    }),
    f("state", "State", { required: false, editable: false }),
    f("description", "Description", { required: false }),
  ],
  dependsOn: [onService],
  iconKey: "queue",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const AclType = rt({
  name: "Kafka ACL",
  id: T.acl,
  plural: "Kafka ACLs",
  description: "An Aiven Kafka ACL entry granting a user access to topics matching a pattern",
  parentTypeId: T.service,
  fields: [
    f("username", "User Pattern", { editable: false }),
    f("topic", "Topic Pattern", { editable: false }),
    f("permission", "Permission", { editable: false }),
    f("project", "Project", { editable: false }),
    f("serviceName", "Service", { editable: false }),
  ],
  dependsOn: [onService],
  iconKey: "key",
  supportsCreate: true,
  supportsDelete: true,
});

const ConnectorType = rt({
  name: "Kafka Connector",
  id: T.connector,
  description: "A Kafka Connect source or sink connector running on an Aiven service",
  parentTypeId: T.service,
  fields: [
    f("name", "Name", { editable: false }),
    f("project", "Project", { editable: false }),
    f("serviceName", "Service", { editable: false }),
    f("connectorClass", "Class", { required: false, editable: false }),
    f("pluginTitle", "Plugin", { required: false, editable: false }),
    f("direction", "Direction", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("tasks", "Tasks", { kind: "number", required: false, editable: false }),
  ],
  dependsOn: [onService],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "pause",
    statusFieldKey: "state",
    runningValues: ["RUNNING"],
    stoppedValues: ["PAUSED", "STOPPED"],
  },
  iconKey: "plug",
  supportsCreate: true,
  supportsDelete: true,
});

const SubjectType = rt({
  name: "Schema Subject",
  id: T.subject,
  description: "A Schema Registry subject on an Aiven Kafka service",
  parentTypeId: T.service,
  fields: [
    f("name", "Subject", { editable: false }),
    f("project", "Project", { editable: false }),
    f("serviceName", "Service", { editable: false }),
  ],
  dependsOn: [onService],
  iconKey: "file",
  supportsCreate: true,
  supportsDelete: true,
});

const IntegrationType = rt({
  name: "Service Integration",
  id: T.integration,
  description:
    "An integration between two Aiven services or an external endpoint (metrics, logs, replication, ...)",
  parentTypeId: T.project,
  fields: [
    f("integrationType", "Type", { editable: false }),
    f("project", "Project", { editable: false }),
    f("source", "Source", { required: false, editable: false }),
    f("destination", "Destination", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("active", "Active", { kind: "boolean", required: false, editable: false }),
  ],
  dependsOn: [
    inProject,
    {
      fieldKey: "source",
      targetTypeId: T.service,
      matchTemplate: "{project}/{source}",
      label: "from",
    },
    {
      fieldKey: "destination",
      targetTypeId: T.service,
      matchTemplate: "{project}/{destination}",
      label: "to",
    },
  ],
  iconKey: "link",
  supportsCreate: true,
  supportsDelete: true,
});

const VpcType = rt({
  name: "Project VPC",
  id: T.vpc,
  description: "A dedicated VPC for a project's services in one cloud region",
  parentTypeId: T.project,
  fields: [
    f("cloud", "Cloud", { editable: false }),
    f("project", "Project", { editable: false }),
    f("networkCidr", "Network CIDR", { editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("peerings", "Peering Connections", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [inProject],
  iconKey: "network",
  supportsCreate: true,
  supportsDelete: true,
});

const PeeringType = rt({
  name: "VPC Peering",
  id: T.peering,
  description:
    "A peering between a project VPC and your own AWS, Google Cloud, Azure or UpCloud network",
  parentTypeId: T.vpc,
  fields: [
    f("peerCloudAccount", "Peer Account", { editable: false }),
    f("peerVpc", "Peer Network", { editable: false }),
    f("peerRegion", "Peer Region", { required: false, editable: false }),
    f("peerResourceGroup", "Peer Resource Group", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("stateMessage", "Details", { required: false, editable: false }),
    f("cidrs", "Routed CIDRs", { required: false, editable: false }),
    f("project", "Project", { editable: false }),
    f("vpcId", "VPC", { editable: false }),
  ],
  dependsOn: [
    { fieldKey: "vpcId", targetTypeId: T.vpc, matchTemplate: "{project}/{vpcId}", label: "peers" },
  ],
  iconKey: "network",
  supportsCreate: true,
  supportsDelete: true,
});

const BillingGroupType = rt({
  name: "Billing Group",
  id: T.billingGroup,
  description:
    "An Aiven billing group: payment method, invoices and credits shared by its projects",
  fields: [
    f("name", "Name", { editable: false }),
    f("currency", "Currency", { required: false, editable: false }),
    f("paymentMethod", "Payment Method", { required: false, editable: false }),
    f("estimatedBalance", "Estimated Balance (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("organization", "Organization", { required: false, editable: false }),
    f("billingEmails", "Billing Emails", { required: false, editable: false }),
  ],
  iconKey: "billing",
  supportsDelete: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ProjectType,
  ServiceType,
  UserType,
  DatabaseType,
  PoolType,
  TopicType,
  AclType,
  ConnectorType,
  SubjectType,
  IntegrationType,
  VpcType,
  PeeringType,
  BillingGroupType,
];
