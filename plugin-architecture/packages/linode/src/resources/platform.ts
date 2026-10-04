import { f, o, rt } from "@infrawrench/plugin-base";
import { REGION_IDS } from "../regions.js";

/** Linode Kubernetes Engine cluster. `externalId` is the numeric cluster id. */
export const LkeClusterResourceType = rt({
  name: "Kubernetes Cluster",
  id: "lke-cluster",
  description: "A Linode Kubernetes Engine (LKE) cluster",
  // Worker nodes are Linodes listed in their own right: shown here, never summed twice.
  carbon: {
    role: "aggregate",
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      catalogueTypeId: "linode",
      catalogueFieldKey: "type",
      sizeFieldKey: "nodeType",
    },
    countFieldKey: "nodeCount",
  },
  fields: [
    f("label", "Label"),
    f("region", "Region", { kind: "enum", enumValues: REGION_IDS, editable: false }),
    f("k8sVersion", "Kubernetes Version", {
      description: "Upgrade one minor version at a time; nodes pick it up when recycled",
    }),
    f("tier", "Tier", {
      kind: "enum",
      required: false,
      enumValues: ["standard", "enterprise"],
      editable: false,
    }),
    f("highAvailability", "HA Control Plane", {
      kind: "boolean",
      required: false,
      description:
        "A high-availability control plane is billed separately; it cannot be turned off again",
    }),
    f("nodeType", "Node Plan", { required: false, editable: false }),
    f("poolCount", "Node Pools", { kind: "number", required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("tags", "Tags", { required: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Kubeconfig YAML for connecting to this cluster",
    }),
    o("apiEndpoint", "API Endpoint", { hidden: true }),
    o("clusterId", "Cluster ID", { hidden: true }),
    o("nodeHourlyRates", "Node Hourly Rates", {
      hidden: true,
      description:
        "JSON map of node plan to hourly price, handed to the Kubernetes peer so it can derive per-namespace and per-workload cost",
    }),
  ],
  iconKey: "kubernetes",
  supportsCreate: true,
  supportsUpdate: true,
  credentialFormats: [
    {
      id: "kubeconfig",
      label: "Kubeconfig",
      description: "The cluster's kubeconfig file for kubectl",
      mediaType: "text",
      filenameTemplate: "{name}-kubeconfig.yaml",
    },
  ],
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [
        { outputKey: "kubeconfig", credentialKey: "kubeconfig" },
        { outputKey: "nodeHourlyRates", credentialKey: "nodeHourlyRates" },
      ],
      tabLabel: "Kubernetes",
      exposeMetricsToParent: true,
    },
  ],
  secretExportTemplates: [
    {
      id: "lke-kubeconfig",
      displayName: "LKE Kubeconfig",
      description: "Kubeconfig for kubectl access to this LKE cluster",
      entries: [
        { envKey: "KUBECONFIG_DATA", outputKey: "kubeconfig" },
        { envKey: "KUBE_API_ENDPOINT", outputKey: "apiEndpoint" },
      ],
    },
  ],
});

/**
 * A node pool inside an LKE cluster. `externalId` is `{clusterId}/{poolId}`.
 * The plan of a pool is fixed at creation; size changes go through `count`
 * and the autoscaler bounds.
 */
export const LkeNodePoolResourceType = rt({
  name: "Node Pool",
  id: "lke-node-pool",
  pinnable: false,
  description: "A pool of identical worker nodes in an LKE cluster",
  fields: [
    f("label", "Label", { required: false, editable: false }),
    f("type", "Node Plan", { editable: false }),
    f("count", "Nodes", { kind: "number", description: "1 to 100 nodes" }),
    f("autoscalerEnabled", "Autoscaler", { kind: "boolean", required: false }),
    f("autoscalerMin", "Autoscaler Minimum", { kind: "number", required: false }),
    f("autoscalerMax", "Autoscaler Maximum", { kind: "number", required: false }),
    f("nodesReady", "Ready Nodes", { kind: "number", required: false, editable: false }),
    f("clusterId", "Cluster", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("tags", "Tags", { required: false }),
  ],
  outputs: [],
  parentTypeId: "lke-cluster",
  iconKey: "layers",
  supportsCreate: true,
  supportsUpdate: true,
  carbon: {
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      catalogueTypeId: "linode",
      catalogueFieldKey: "type",
      sizeFieldKey: "type",
    },
    countFieldKey: "count",
    role: "aggregate",
  },
});

/**
 * Managed Database cluster (MySQL or PostgreSQL). `externalId` is
 * `{engine}/{id}`: the instance endpoints are engine-scoped
 * (`/databases/mysql/instances/{id}`).
 */
export const DatabaseResourceType = rt({
  name: "Managed Database",
  id: "database",
  description: "A Linode Managed Database cluster (MySQL or PostgreSQL)",
  carbon: {
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      catalogueTypeId: "linode",
      catalogueFieldKey: "type",
      sizeFieldKey: "type",
    },
    countFieldKey: "clusterSize",
  },
  fields: [
    f("label", "Label"),
    f("engine", "Engine", { kind: "enum", enumValues: ["mysql", "postgresql"], editable: false }),
    f("version", "Version", { editable: false }),
    f("region", "Region", { kind: "enum", enumValues: REGION_IDS, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("type", "Node Plan", {
      description: "Plan for every node. Linode only allows moving to a plan with more disk",
    }),
    f("clusterSize", "Nodes", {
      kind: "number",
      editable: false,
      description: "1 (single node) or 3 (high availability)",
    }),
    f("allowList", "Allowed IPs", {
      required: false,
      description: "Comma-separated IPs or CIDR ranges allowed to connect; empty blocks everything",
    }),
    f("primaryHost", "Primary Host", { required: false, editable: false }),
    f("secondaryHost", "Read-only Host", { required: false, editable: false }),
    f("port", "Port", { kind: "number", required: false, editable: false }),
    f("diskUsedGb", "Disk Used (GB)", { kind: "number", required: false, editable: false }),
    f("diskTotalGb", "Disk Total (GB)", { kind: "number", required: false, editable: false }),
    f("platform", "Platform", { required: false, editable: false }),
    f("managedBackups", "Automatic Backups", {
      kind: "boolean",
      required: false,
      editable: false,
      description:
        "Managed Databases take daily backups automatically; there is no switch to turn them off",
    }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Full connection URI",
    }),
    o("host", "Host"),
    o("port", "Port"),
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("database", "Database Name"),
    o("caCertificate", "CA Certificate", {
      description: "TLS CA certificate for verifying the server",
    }),
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "resume",
    stopActionId: "suspend",
    statusFieldKey: "status",
    runningValues: ["active"],
    stoppedValues: ["suspended", "suspending"],
  },
  postureChecks: [
    {
      id: "linode-database-open-to-all",
      title: "Database accepts connections from anywhere",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "allowList", when: "equals", value: "0.0.0.0/0" }],
      reason:
        "The allow list is 0.0.0.0/0, so the database answers connection attempts from the whole internet.",
    },
  ],
  backupPolicy: { protectedBy: [], automatedBackupFieldKey: "managedBackups" },
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "connectionString" },
        { outputKey: "caCertificate", credentialKey: "caCert" },
      ],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", equals: "postgresql" },
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
  ],
});

/**
 * The billing account behind the token: one per credential. Balance,
 * uninvoiced charges, promotions and the network transfer pool.
 */
export const AccountResourceType = rt({
  name: "Billing Account",
  id: "account",
  description: "The Akamai Cloud account's balance, promotions and network transfer pool",
  fields: [
    f("company", "Company", { required: false }),
    f("email", "Billing Email", { required: false }),
    f("balance", "Balance (USD)", {
      kind: "number",
      required: false,
      description: "Amount owed; negative means the account holds a credit",
    }),
    f("uninvoiced", "Uninvoiced Charges (USD)", {
      kind: "number",
      required: false,
      description: "Linode's running estimate of the invoice for the current billing period",
    }),
    f("promotionCount", "Active Promotions", { kind: "number", required: false }),
    f("promotionCreditRemaining", "Promotion Credit Remaining (USD)", {
      kind: "number",
      required: false,
    }),
    f("transferUsedGb", "Transfer Used (GB)", { kind: "number", required: false }),
    f("transferQuotaGb", "Transfer Pool (GB)", { kind: "number", required: false }),
    f("transferBillableGb", "Billable Transfer (GB)", { kind: "number", required: false }),
    f("billingSource", "Billing Source", { required: false }),
    f("activeSince", "Active Since", { required: false }),
  ],
  outputs: [],
  iconKey: "account",
});

/** A closed monthly invoice. `externalId` is the numeric invoice id. */
export const InvoiceResourceType = rt({
  name: "Invoice",
  id: "invoice",
  pinnable: false,
  description: "A monthly Akamai Cloud invoice and its line items",
  fields: [
    f("label", "Invoice"),
    f("date", "Date"),
    f("subtotal", "Subtotal (USD)", { kind: "number", required: false }),
    f("tax", "Tax (USD)", { kind: "number", required: false }),
    f("total", "Total (USD)", { kind: "number", required: false }),
  ],
  outputs: [],
  parentTypeId: "account",
  iconKey: "file",
});
