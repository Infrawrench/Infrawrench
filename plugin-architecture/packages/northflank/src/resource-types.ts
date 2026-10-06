import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const T = {
  account: "nf-account",
  project: "nf-project",
  service: "nf-service",
  job: "nf-job",
  addon: "nf-addon",
  secretGroup: "nf-secret-group",
  volume: "nf-volume",
  pipeline: "nf-pipeline",
  domain: "nf-domain",
  subdomain: "nf-subdomain",
  cluster: "nf-cluster",
} as const;

/** Addon types whose connection string another Infrawrench plugin can open. */
export const ADDON_PEERS: Array<{ type: string; pluginId: string; label: string }> = [
  { type: "postgresql", pluginId: "postgres", label: "PostgreSQL" },
  { type: "mysql", pluginId: "mysql", label: "MySQL" },
  { type: "redis", pluginId: "redis", label: "Redis" },
  { type: "mongodb", pluginId: "mongodb", label: "MongoDB" },
];

const inProject = { fieldKey: "projectId", targetTypeId: T.project, label: "in project" };

const AccountType = rt({
  name: "Account",
  id: T.account,
  description:
    "The Northflank team or organisation the API token belongs to: token details, invoices and this month's usage",
  pinnable: false,
  fields: [
    f("name", "Name", { editable: false }),
    f("entityType", "Scope", { editable: false, required: false }),
    f("entityId", "Team / Organisation", { editable: false, required: false }),
    f("teamId", "Acting For Team", { editable: false, required: false }),
    f("tokenName", "API Token", { editable: false, required: false }),
    f("roleName", "API Role", { editable: false, required: false }),
    f("creatorEmail", "Token Creator", { editable: false, required: false }),
    f("tokenCreatedAt", "Token Created", { editable: false, required: false }),
    f("tokenExpiresAt", "Token Expires", { editable: false, required: false }),
  ],
  expiryFields: [
    { fieldKey: "tokenExpiresAt", from: "expiry", kind: "api-token", label: "API token expires" },
  ],
  iconKey: "account",
  supportsDelete: false,
});

const ProjectType = rt({
  name: "Project",
  id: T.project,
  description:
    "A Northflank project: the services, jobs, addons, secrets and volumes deployed together in one region or BYOC cluster",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    f("color", "Colour", {
      required: false,
      description: "Hex colour shown in the Northflank app, e.g. #EF233C.",
    }),
    f("region", "Region", { required: false, editable: false }),
    f("clusterId", "Cluster", { required: false, editable: false }),
    f("clusterName", "Cluster Name", { required: false, editable: false }),
    f("uid", "Permanent ID", { required: false, editable: false }),
    f("serviceCount", "Services", { kind: "number", required: false, editable: false }),
    f("jobCount", "Jobs", { kind: "number", required: false, editable: false }),
    f("addonCount", "Addons", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "clusterId", targetTypeId: T.cluster, label: "runs on" }],
  iconKey: "folder",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const ServiceType = rt({
  name: "Service",
  id: T.service,
  description:
    "A Northflank service: a combined (build and deploy), deployment (image) or build service",
  parentTypeId: T.project,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("projectId", "Project", { editable: false }),
    f("serviceType", "Type", {
      kind: "enum",
      enumValues: ["combined", "deployment", "build"],
      editable: false,
    }),
    f("description", "Description", { required: false }),
    f("state", "State", { required: false, editable: false }),
    f("deploymentStatus", "Deployment Status", { required: false, editable: false }),
    f("buildStatus", "Build Status", { required: false, editable: false }),
    f("instances", "Instances", {
      kind: "number",
      required: false,
      description: "Number of running instances. 0 pauses the service.",
    }),
    f("deploymentPlan", "Compute Plan", { required: false, editable: false }),
    f("buildPlan", "Build Plan", { required: false, editable: false }),
    f("image", "Image", { required: false, editable: false }),
    f("repository", "Repository", { required: false, editable: false }),
    f("branch", "Branch", { required: false, editable: false }),
    f("buildServiceId", "Deploys From Build Service", { required: false, editable: false }),
    f("publicUrls", "Public URLs", { required: false, editable: false }),
    f("customDomains", "Custom Domains", { required: false, editable: false }),
    f("disabledCI", "CI Disabled", { kind: "boolean", required: false, editable: false }),
    f("disabledCD", "CD Disabled", { kind: "boolean", required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("publicUrl", "Public URL", { description: "https:// address of the first public port" }),
    o("internalHost", "Internal Host", {
      description: "Hostname other workloads in the project reach this service on",
    }),
  ],
  dependsOn: [
    inProject,
    {
      fieldKey: "buildServiceId",
      targetTypeId: T.service,
      matchTemplate: "{projectId}/{buildServiceId}",
      label: "deploys from",
    },
  ],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "pause",
    statusFieldKey: "state",
    runningValues: ["running"],
    stoppedValues: ["paused"],
  },
  iconKey: "server",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
});

const JobType = rt({
  name: "Job",
  id: T.job,
  description: "A Northflank job: a cron job on a schedule or a manual job run on demand",
  parentTypeId: T.project,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("projectId", "Project", { editable: false }),
    f("jobType", "Type", { kind: "enum", enumValues: ["cron", "manual"], editable: false }),
    f("description", "Description", { required: false }),
    f("schedule", "Schedule", {
      required: false,
      description: "Cron expression (cron jobs only), e.g. 0 3 * * * for 03:00 UTC daily.",
    }),
    f("concurrencyPolicy", "Concurrency", {
      kind: "enum",
      enumValues: ["allow", "forbid", "replace"],
      required: false,
      description: "Cron jobs only: what happens when a run is due while the last is still going.",
    }),
    f("backoffLimit", "Retries", {
      kind: "number",
      required: false,
      description: "Attempts before a run is marked failed.",
    }),
    f("activeDeadlineSeconds", "Timeout (s)", {
      kind: "number",
      required: false,
      description: "A run still going after this many seconds is marked failed.",
    }),
    f("suspended", "Schedule Suspended", { kind: "boolean", required: false, editable: false }),
    f("deploymentPlan", "Compute Plan", { required: false, editable: false }),
    f("image", "Image", { required: false, editable: false }),
    f("repository", "Repository", { required: false, editable: false }),
    f("branch", "Branch", { required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [inProject],
  iconKey: "clock",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
});

const AddonType = rt({
  name: "Addon",
  id: T.addon,
  description:
    "A managed Northflank addon: PostgreSQL, MySQL, MongoDB, Redis, RabbitMQ, MinIO and other databases and stores",
  parentTypeId: T.project,
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("projectId", "Project", { editable: false }),
    f("addonType", "Type", { editable: false }),
    f("description", "Description", { required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("lifecycleStatus", "Version Support", { required: false, editable: false }),
    f("deploymentPlan", "Compute Plan", { required: false, editable: false }),
    f("replicas", "Replicas", { kind: "number", required: false, editable: false }),
    f("storageMb", "Storage (MB)", { kind: "number", required: false, editable: false }),
    f("storageClass", "Storage Class", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("tlsEnabled", "TLS", {
      kind: "boolean",
      required: false,
      description: "Provision a TLS certificate for connections. Required for public access.",
    }),
    f("externalAccessEnabled", "Public Access", {
      kind: "boolean",
      required: false,
      description:
        "Give the addon a public address reachable from the internet (needs TLS). Infrawrench's database consoles connect through it.",
    }),
    f("tags", "Tags", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "The public connection URI when public access is on, the internal one otherwise",
    }),
    o("host", "Host"),
    o("port", "Port"),
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("database", "Database"),
  ],
  dependsOn: [inProject],
  peerIntegrations: ADDON_PEERS.map((p) => ({
    pluginId: p.pluginId,
    credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
    tabLabel: p.label,
    showWhen: { fieldKey: "addonType", equals: p.type },
  })),
  secretExportTemplates: [
    {
      id: "northflank-addon-connection",
      displayName: "Connection",
      description: "Northflank addon connection details",
      entries: [
        { envKey: "DATABASE_URL", outputKey: "connectionString" },
        { envKey: "DB_HOST", outputKey: "host" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
      ],
    },
  ],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "pause",
    statusFieldKey: "status",
    runningValues: ["running"],
    stoppedValues: ["paused"],
  },
  postureChecks: [
    {
      id: "northflank-addon-public-no-ip-policy",
      title: "Addon reachable from the internet",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "externalAccessEnabled", when: "truthy" }],
      reason:
        "Public access gives the addon an internet-facing address. Keep it off unless something outside Northflank must connect, and prefer VPC exposure or the CLI's port forwarding.",
    },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
});

const SecretGroupType = rt({
  name: "Secret Group",
  id: T.secretGroup,
  description:
    "A project secret group: environment variables and build arguments injected into the project's services and jobs",
  parentTypeId: T.project,
  fields: [
    f("name", "Name", { editable: false }),
    f("projectId", "Project", { editable: false }),
    f("description", "Description", { required: false }),
    f("secretType", "Injected Into", {
      kind: "enum",
      enumValues: ["environment-arguments", "environment", "arguments"],
      required: false,
      description:
        "environment: runtime variables; arguments: build arguments; environment-arguments: both.",
    }),
    f("type", "Kind", {
      kind: "enum",
      enumValues: ["secret", "config"],
      required: false,
      editable: false,
    }),
    f("priority", "Priority", {
      kind: "number",
      required: false,
      description: "When several groups set the same key, the higher priority wins.",
    }),
    f("restricted", "Restricted", { kind: "boolean", required: false, editable: false }),
    f("keys", "Variables", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  dependsOn: [inProject],
  iconKey: "key",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const VolumeType = rt({
  name: "Volume",
  id: T.volume,
  description: "A persistent volume attached to a Northflank service or job",
  parentTypeId: T.project,
  fields: [
    f("name", "Name", { editable: false }),
    f("projectId", "Project", { editable: false }),
    f("storageSizeMb", "Size (MB)", {
      kind: "number",
      required: false,
      description: "Volumes can grow but not shrink.",
    }),
    f("storageClass", "Storage Class", { required: false, editable: false }),
    f("accessMode", "Access Mode", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("attachedTo", "Attached To", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [
    inProject,
    {
      fieldKey: "attachedTo",
      targetTypeId: T.service,
      matchTemplate: "{projectId}/{attachedTo}",
      label: "attached to",
    },
  ],
  iconKey: "disk",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const PipelineType = rt({
  name: "Pipeline",
  id: T.pipeline,
  description:
    "A release pipeline: services, jobs and addons arranged in Development, Staging and Production stages with release flows",
  parentTypeId: T.project,
  fields: [
    f("name", "Name", { editable: false }),
    f("projectId", "Project", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("stages", "Stages", { required: false, editable: false }),
    f("resourceCount", "Resources", { kind: "number", required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  dependsOn: [inProject],
  iconKey: "workflow",
  supportsDelete: false,
});

const DomainType = rt({
  name: "Domain",
  id: T.domain,
  description: "A custom domain registered with Northflank, verified with a TXT record",
  fields: [
    f("name", "Domain", { editable: false }),
    f("status", "Verification", { required: false, editable: false }),
    f("verifyHostname", "TXT Record Name", { required: false, editable: false }),
    f("verifyToken", "TXT Record Value", { required: false, editable: false }),
    f("redirectMode", "Redirect Mode", { required: false, editable: false }),
    f("subdomainCount", "Subdomains", { kind: "number", required: false, editable: false }),
    f("certificateExpiry", "Wildcard Certificate Expires", { required: false, editable: false }),
  ],
  expiryFields: [
    {
      fieldKey: "certificateExpiry",
      from: "expiry",
      kind: "tls-cert",
      label: "Wildcard certificate expires",
    },
  ],
  iconKey: "globe",
  supportsCreate: true,
  supportsDelete: true,
});

const SubdomainType = rt({
  name: "Subdomain",
  id: T.subdomain,
  description:
    "A subdomain of a registered domain, pointed at Northflank with a CNAME and assigned to a service port",
  parentTypeId: T.domain,
  fields: [
    f("name", "Subdomain", { editable: false }),
    f("fullName", "Hostname", { editable: false }),
    f("domain", "Domain", { editable: false }),
    f("recordType", "Record Type", { required: false, editable: false }),
    f("content", "Record Value", { required: false, editable: false }),
    f("verified", "Verified", { kind: "boolean", required: false, editable: false }),
    f("routingMode", "Routing", { required: false, editable: false }),
    f("cdnEnabled", "CDN", { kind: "boolean", required: false, editable: false }),
    f("certificateExpiry", "Certificate Expires", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "domain", targetTypeId: T.domain, label: "in domain" }],
  expiryFields: [
    {
      fieldKey: "certificateExpiry",
      from: "expiry",
      kind: "tls-cert",
      label: "Certificate expires",
    },
  ],
  iconKey: "globe",
  supportsCreate: true,
  supportsDelete: true,
});

const ClusterType = rt({
  name: "BYOC Cluster",
  id: T.cluster,
  description:
    "A bring-your-own-cloud Kubernetes cluster Northflank manages in your AWS, GCP, Azure, OCI or other cloud account",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("provider", "Cloud", { editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("stateReason", "State Reason", { required: false, editable: false }),
    f("nodePools", "Node Pools", { kind: "number", required: false, editable: false }),
    f("nodeTypes", "Node Types", { required: false, editable: false }),
    f("configuredNodes", "Configured Nodes", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "cluster",
  supportsDelete: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountType,
  ProjectType,
  ServiceType,
  JobType,
  AddonType,
  SecretGroupType,
  VolumeType,
  PipelineType,
  DomainType,
  SubdomainType,
  ClusterType,
];
