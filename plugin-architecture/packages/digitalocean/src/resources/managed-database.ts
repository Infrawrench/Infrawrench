import type {
  CreateFieldConfig,
  PeerGuidanceAction,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";

// Kafka's `/users` endpoint requires a `settings.acl` block or DO 422s with
// "settings is required". These editable fields default to full access on
// every topic so the minted user works out of the box; the user can narrow
// scope before submitting. The `make-db-user` handler reads `topic`/`permission`
// and only sends `settings` when the cluster engine is Kafka.
export function kafkaAclFields(): CreateFieldConfig[] {
  return [
    {
      key: "topic",
      label: "Topic",
      kind: "text",
      required: false,
      defaultValue: "*",
      description: "Topic name or regex this user can access. `*` matches every topic.",
    },
    {
      key: "permission",
      label: "Permission",
      kind: "select",
      required: false,
      defaultValue: "admin",
      options: [
        { id: "admin", label: "Admin — produce, consume, and manage topics" },
        { id: "produceconsume", label: "Produce & consume" },
        { id: "produce", label: "Produce only" },
        { id: "consume", label: "Consume only" },
      ],
    },
  ];
}

// Shown as a CTA in the peer pane when the connection string can't resolve
// (mongo/redis/opensearch/kafka never expose the built-in user's password).
// Mirrors the cluster-detail header action; dispatches `make-db-user` to the
// parent managed-database, which mints + persists the credential.
const makeConnectionUserAction: PeerGuidanceAction = {
  label: "+ Make connection user",
  command: "make-db-user",
  title: "Create connection user",
  description:
    "DigitalOcean reveals a database user's credential exactly once, at creation. " +
    "Infrawrench creates the user, captures that credential, and stores it locally so this " +
    "tab can connect.",
  submitLabel: "Create user",
  fields: [
    {
      key: "name",
      label: "Username",
      kind: "text",
      required: true,
      description: "Letters, digits, and `_-` only. Must be unique within the cluster.",
    },
  ],
};

// Kafka variant: same flow, plus the ACL fields DO requires for Kafka users.
const makeKafkaConnectionUserAction: PeerGuidanceAction = {
  ...makeConnectionUserAction,
  fields: [...makeConnectionUserAction.fields, ...kafkaAclFields()],
};

export const ManagedDatabaseResourceType: ResourceTypeDefinition = {
  id: "managed-database",
  displayName: "Managed Database",
  pluralDisplayName: "Managed Databases",
  description: "A DigitalOcean Managed Database cluster",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "engine",
      label: "Engine",
      kind: "enum",
      required: true,
      enumValues: ["pg", "mysql", "redis", "valkey", "mongodb", "kafka", "opensearch", "weaviate"],
    },
    {
      key: "version",
      label: "Version",
      kind: "string",
      required: true,
      description: "Engine version, e.g. 16 for PostgreSQL 16",
    },
    {
      key: "region",
      label: "Region",
      kind: "enum",
      required: true,
      enumValues: [
        "nyc1",
        "nyc3",
        "sfo2",
        "sfo3",
        "ams3",
        "fra1",
        "sgp1",
        "lon1",
        "tor1",
        "blr1",
        "syd1",
      ],
    },
    {
      key: "size",
      label: "Node Size",
      kind: "string",
      required: true,
      description: "Node size slug, e.g. db-s-1vcpu-1gb",
    },
    {
      key: "nodeCount",
      label: "Node Count",
      kind: "number",
      required: true,
    },
  ],
  outputs: [
    {
      key: "connectionString",
      label: "Connection String",
      sensitive: true,
      description: "Full connection URI",
    },
    { key: "host", label: "Host", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "username", label: "Username", sensitive: false },
    { key: "password", label: "Password", sensitive: true },
    { key: "database", label: "Database Name", sensitive: false },
    {
      key: "caCertificate",
      label: "CA Certificate",
      sensitive: false,
      description: "TLS CA certificate for verifying the server",
    },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  dashboardPinnable: true,
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "database",
  peerIntegrations: [
    {
      pluginId: "postgres",
      // DO signs managed-DB certs with its own internal CA. Map the
      // caCertificate output into the Postgres plugin's caCert credential
      // so TLS chain verification stays on with DO's CA trusted, instead
      // of failing with "self signed certificate in certificate chain".
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "connectionString" },
        { outputKey: "caCertificate", credentialKey: "caCert" },
      ],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", equals: "pg" },
    },
    {
      pluginId: "mysql",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "connectionString" },
        { outputKey: "caCertificate", credentialKey: "caCert" },
      ],
      tabLabel: "MySQL",
      showWhen: { fieldKey: "engine", equals: "mysql" },
    },
    {
      // DO retired Managed Redis on 2025-06-30; new clusters report
      // engine=valkey, while pre-migration clusters may still report redis.
      // Valkey is wire-compatible with Redis, so the same plugin drives both.
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Valkey",
      showWhen: { fieldKey: "engine", equals: "valkey" },
      credentialSetupAction: makeConnectionUserAction,
    },
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Redis",
      showWhen: { fieldKey: "engine", equals: "redis" },
      credentialSetupAction: makeConnectionUserAction,
    },
    {
      pluginId: "mongodb",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MongoDB",
      showWhen: { fieldKey: "engine", equals: "mongodb" },
      credentialSetupAction: makeConnectionUserAction,
    },
    {
      // DO managed OpenSearch exposes a doadmin user + a TLS endpoint on
      // port 25060. The connection.uri is shaped like
      // `https://doadmin:<pw>@cluster-host:25060` so the OpenSearch plugin
      // can pull credentials out of the URL via parseConfig().
      pluginId: "opensearch",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "endpoint" },
        { outputKey: "caCertificate", credentialKey: "caCertificate" },
      ],
      tabLabel: "OpenSearch",
      showWhen: { fieldKey: "engine", equals: "opensearch" },
      credentialSetupAction: makeConnectionUserAction,
    },
    {
      // DO managed Kafka uses SASL/SCRAM-SHA-256 over TLS on port 25073;
      // the connection.uri is shaped like
      // `kafkas://username:password@cluster-host:25073`. The DO client's
      // resolveOutput normalizes the URI for kafka engines so it includes
      // explicit `sasl=scram-sha-256&ssl=true` params the kafka plugin
      // driver understands.
      pluginId: "kafka",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Kafka",
      showWhen: { fieldKey: "engine", equals: "kafka" },
      credentialSetupAction: makeKafkaConnectionUserAction,
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "Single DATABASE_URL containing the full connection string",
      entries: [
        {
          envKey: "DATABASE_URL",
          outputKey: "connectionString",
          description: "Full connection URI",
        },
      ],
    },
    {
      id: "individual",
      displayName: "Individual Credentials",
      description: "Separate environment variables for host, port, user, password, and database",
      entries: [
        { envKey: "DB_HOST", outputKey: "host" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
        { envKey: "DB_NAME", outputKey: "database" },
      ],
    },
    {
      id: "individual-with-ca",
      displayName: "Individual + CA Certificate",
      description: "Individual credentials plus the TLS CA certificate for verified connections",
      entries: [
        { envKey: "DB_HOST", outputKey: "host" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
        { envKey: "DB_NAME", outputKey: "database" },
        { envKey: "DB_CA_CERT", outputKey: "caCertificate", description: "TLS CA certificate" },
      ],
    },
  ],
};
