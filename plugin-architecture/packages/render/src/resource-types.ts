import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** Render regions, as the API spells them in every `region` field. */
export const REGIONS = ["oregon", "ohio", "virginia", "frankfurt", "singapore"] as const;

export const SERVICE_TYPES = [
  "web_service",
  "private_service",
  "background_worker",
  "cron_job",
  "static_site",
] as const;

export const SERVICE_PLANS = [
  "free",
  "starter",
  "standard",
  "pro",
  "pro_plus",
  "pro_max",
  "pro_ultra",
];

export const RUNTIMES = ["node", "python", "ruby", "go", "rust", "elixir", "docker", "image"];

const regionField = f("region", "Region", {
  kind: "enum",
  enumValues: [...REGIONS],
  required: false,
  editable: false,
});

export const WorkspaceResourceType = rt({
  name: "Workspace",
  id: "workspace",
  description: "A Render workspace (personal account or team) the API key can reach",
  fields: [
    f("name", "Name", { editable: false }),
    f("email", "Owner Email", { required: false }),
    f("ownerType", "Type", { kind: "enum", enumValues: ["user", "team"], required: false }),
    f("twoFactorAuthEnabled", "Two-Factor Auth Enforced", { kind: "boolean", required: false }),
  ],
  outputs: [o("ownerId", "Workspace ID")],
  iconKey: "team",
  postureChecks: [
    {
      id: "render-workspace-no-2fa",
      title: "Two-factor authentication not enforced",
      severity: "medium",
      category: "other",
      conditions: [{ fieldKey: "twoFactorAuthEnabled", when: "falsy" }],
      reason:
        "Members of this workspace can sign in to Render with only a password, and a stolen password reaches every service, database and secret in it.",
    },
  ],
});

export const ServiceResourceType = rt({
  name: "Service",
  id: "service",
  description:
    "A Render service: web service, private service, background worker, cron job or static site",
  fields: [
    f("name", "Name"),
    f("serviceType", "Type", { kind: "enum", enumValues: [...SERVICE_TYPES], editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["active", "suspended"],
      required: false,
      editable: false,
    }),
    f("suspenders", "Suspended By", { required: false, editable: false }),
    regionField,
    f("plan", "Instance Type", {
      kind: "enum",
      enumValues: SERVICE_PLANS,
      required: false,
      description: "Changing the instance type redeploys the service.",
    }),
    f("runtime", "Runtime", {
      kind: "enum",
      enumValues: RUNTIMES,
      required: false,
      editable: false,
    }),
    f("repo", "Repository", { required: false, editable: false }),
    f("branch", "Branch", { required: false }),
    f("rootDir", "Root Directory", { required: false }),
    f("imagePath", "Image", { required: false, editable: false }),
    f("autoDeploy", "Auto-Deploy", {
      kind: "enum",
      enumValues: ["commit", "checksPass", "off"],
      required: false,
      description: "Deploy on every commit, only after CI checks pass, or never automatically.",
    }),
    f("buildCommand", "Build Command", { required: false }),
    f("startCommand", "Start Command", { required: false }),
    f("preDeployCommand", "Pre-Deploy Command", {
      required: false,
      description: "Runs before each deploy, e.g. database migrations.",
    }),
    f("publishPath", "Publish Directory", {
      required: false,
      description: "Static sites only: the directory the build writes.",
    }),
    f("schedule", "Schedule", {
      required: false,
      description: "Cron jobs only: a cron expression in UTC, e.g. 0 * * * *.",
    }),
    f("healthCheckPath", "Health Check Path", {
      required: false,
      description: "Web services only: a path that returns 200 when the service is healthy.",
    }),
    f("previews", "Preview Environments", {
      kind: "enum",
      enumValues: ["off", "manual", "automatic"],
      required: false,
      description: "Pull request previews for this service.",
    }),
    f("maxShutdownDelaySeconds", "Max Shutdown Delay (s)", {
      kind: "number",
      required: false,
      description: "Seconds Render waits after SIGTERM before SIGKILL (1 to 300).",
    }),
    f("numInstances", "Instances", { kind: "number", required: false, editable: false }),
    f("autoscalingEnabled", "Autoscaling", { kind: "boolean", required: false, editable: false }),
    f("autoscalingMin", "Autoscaling Min", { kind: "number", required: false, editable: false }),
    f("autoscalingMax", "Autoscaling Max", { kind: "number", required: false, editable: false }),
    f("autoscalingCpuPercent", "Autoscaling CPU Target (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("autoscalingMemoryPercent", "Autoscaling Memory Target (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maintenanceMode", "Maintenance Mode", { kind: "boolean", required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("diskId", "Disk", { required: false, editable: false }),
    f("environmentId", "Environment", { required: false, editable: false }),
    f("ownerId", "Workspace", { required: false, editable: false }),
    f("lastSuccessfulRunAt", "Last Successful Run", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("serviceId", "Service ID"),
    o("url", "URL"),
    o("hostname", "Hostname"),
    o("sshAddress", "SSH Address"),
  ],
  dependsOn: [
    { fieldKey: "environmentId", targetTypeId: "environment", label: "in environment" },
    { fieldKey: "ownerId", targetTypeId: "workspace", label: "in workspace" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "server",
  // Suspend stops compute billing; resume brings the last deploy back.
  lifecycle: {
    startActionId: "resume",
    stopActionId: "suspend",
    statusFieldKey: "status",
    runningValues: ["active"],
    stoppedValues: ["suspended"],
  },
  orphanRule: {
    conditions: [{ fieldKey: "suspenders", when: "equals", value: "user" }],
    reason:
      "Suspended by a user: it serves nothing, but any attached disk keeps billing and its configuration keeps drifting from what is deployed.",
  },
  secretExportTemplates: [
    {
      id: "service-url",
      displayName: "Service URL",
      description: "The public URL of this service",
      entries: [{ envKey: "SERVICE_URL", outputKey: "url" }],
    },
  ],
});

export const DeployResourceType = rt({
  name: "Deploy",
  pinnable: false,
  id: "deploy",
  description: "A build and release of a Render service",
  parentTypeId: "service",
  fields: [
    f("status", "Status"),
    f("trigger", "Trigger", { required: false }),
    f("commitId", "Commit", { required: false }),
    f("commitMessage", "Commit Message", { required: false }),
    f("imageRef", "Image", { required: false }),
    f("serviceId", "Service", { required: false }),
    f("serviceName", "Service Name", { required: false }),
    f("startedAt", "Started", { required: false }),
    f("finishedAt", "Finished", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("deployId", "Deploy ID")],
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "service", label: "deploy of" }],
  iconKey: "deployment",
});

export const EnvVarResourceType = rt({
  name: "Environment Variable",
  pinnable: false,
  id: "env-var",
  description: "An environment variable set directly on a Render service",
  parentTypeId: "service",
  fields: [
    f("key", "Key", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description:
        "New value. Leave blank to keep the current one. The service picks it up on its next deploy.",
    }),
    f("serviceId", "Service", { required: false, editable: false }),
    f("serviceName", "Service Name", { required: false, editable: false }),
  ],
  outputs: [o("key", "Key"), o("value", "Value", { sensitive: true })],
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "service", label: "set on" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "secret",
});

export const CustomDomainResourceType = rt({
  name: "Custom Domain",
  id: "custom-domain",
  description: "A custom domain routed to a Render web service or static site",
  parentTypeId: "service",
  fields: [
    f("name", "Domain"),
    f("domainType", "Type", { kind: "enum", enumValues: ["apex", "subdomain"], required: false }),
    f("verificationStatus", "Verification", {
      kind: "enum",
      enumValues: ["verified", "unverified"],
      required: false,
    }),
    f("redirectForName", "Redirects To", { required: false }),
    f("publicSuffix", "Public Suffix", { required: false }),
    f("serviceId", "Service", { required: false }),
    f("serviceName", "Service Name", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("hostname", "Hostname")],
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "service", label: "routes to" }],
  supportsCreate: true,
  iconKey: "globe",
});

export const JobResourceType = rt({
  name: "One-Off Job",
  pinnable: false,
  id: "job",
  description: "A one-off command run on a copy of a Render service",
  parentTypeId: "service",
  fields: [
    f("startCommand", "Command"),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["pending", "running", "succeeded", "failed", "canceled"],
      required: false,
    }),
    f("planId", "Instance Type", { required: false }),
    f("serviceId", "Service", { required: false }),
    f("serviceName", "Service Name", { required: false }),
    f("ownerId", "Workspace", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("startedAt", "Started", { required: false }),
    f("finishedAt", "Finished", { required: false }),
  ],
  outputs: [o("jobId", "Job ID")],
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "service", label: "runs on" }],
  supportsCreate: true,
  iconKey: "terminal",
});

export const DiskResourceType = rt({
  name: "Disk",
  id: "disk",
  description: "A persistent SSD attached to a Render service",
  fields: [
    f("name", "Name"),
    f("sizeGB", "Size (GB)", {
      kind: "number",
      description: "Disks can only grow. The service must be running for a resize to apply.",
    }),
    f("mountPath", "Mount Path", {
      description: "Absolute path inside the service, e.g. /var/data.",
    }),
    f("serviceId", "Service", { required: false, editable: false }),
    f("serviceName", "Service Name", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("diskId", "Disk ID"), o("mountPath", "Mount Path")],
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "service", label: "attached to" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "volume",
});

const ipFields = [
  f("allowedCidrs", "Allowed Sources", {
    required: false,
    description:
      "CIDR blocks allowed to connect from outside Render, comma separated. Empty means only services on Render's private network can connect.",
  }),
  f("openToInternet", "Open to Any IP", { kind: "boolean", required: false, editable: false }),
];

export const PostgresResourceType = rt({
  name: "Postgres",
  plural: "Postgres Databases",
  id: "postgres",
  description: "A managed Render Postgres instance",
  fields: [
    f("name", "Name"),
    f("status", "Status", { required: false, editable: false }),
    f("plan", "Instance Type", {
      required: false,
      description: "Changing the instance type restarts the database.",
    }),
    regionField,
    f("version", "Postgres Version", { required: false, editable: false }),
    f("role", "Role", {
      kind: "enum",
      enumValues: ["primary", "replica"],
      required: false,
      editable: false,
    }),
    f("primaryPostgresId", "Primary", { required: false, editable: false }),
    f("databaseName", "Database", { required: false, editable: false }),
    f("databaseUser", "User", { required: false, editable: false }),
    f("diskSizeGB", "Storage (GB)", {
      kind: "number",
      required: false,
      description: "Storage can only grow.",
    }),
    f("diskAutoscalingEnabled", "Storage Autoscaling", { kind: "boolean", required: false }),
    f("highAvailabilityEnabled", "High Availability", {
      kind: "boolean",
      required: false,
      description: "Keeps a standby in another zone. Pro instance types and above.",
    }),
    f("readReplicaCount", "Read Replicas", { kind: "number", required: false, editable: false }),
    ...ipFields,
    f("suspended", "Suspended", { kind: "boolean", required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("maintenanceScheduledAt", "Maintenance Scheduled", { required: false, editable: false }),
    f("environmentId", "Environment", { required: false, editable: false }),
    f("ownerId", "Workspace", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("connectionString", "External Connection String", { sensitive: true }),
    o("internalConnectionString", "Internal Connection String", { sensitive: true }),
    o("poolConnectionString", "Pooled Connection String", { sensitive: true }),
    o("password", "Password", { sensitive: true }),
    o("psqlCommand", "psql Command", { sensitive: true, hidden: true }),
    o("databaseName", "Database"),
    o("databaseUser", "User"),
  ],
  dependsOn: [
    { fieldKey: "primaryPostgresId", targetTypeId: "postgres", label: "replica of" },
    { fieldKey: "environmentId", targetTypeId: "environment", label: "in environment" },
    { fieldKey: "ownerId", targetTypeId: "workspace", label: "in workspace" },
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Free database expires" },
  ],
  postureChecks: [
    {
      id: "render-postgres-open-to-internet",
      title: "Accepts connections from any IP",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "openToInternet", when: "truthy" }],
      reason:
        "The access control list includes 0.0.0.0/0, so anyone who learns the password can connect from anywhere. Narrow it to the addresses that need it, or clear it to allow only Render's private network.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "database",
  lifecycle: {
    startActionId: "resume",
    stopActionId: "suspend",
    statusFieldKey: "status",
    runningValues: ["available"],
    stoppedValues: ["suspended"],
  },
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
      unreachableWhen: {
        fieldsEmpty: ["allowedCidrs"],
        title: "This database only accepts connections from Render's private network.",
        suggestions: [
          "Add this machine's IP address to Allowed Sources (Edit), or",
          "Connect from a service running on Render.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "database-url",
      displayName: "Database URL",
      description: "DATABASE_URL for clients outside Render",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
    {
      id: "internal-database-url",
      displayName: "Internal Database URL",
      description: "DATABASE_URL for services running in the same Render region",
      entries: [{ envKey: "DATABASE_URL", outputKey: "internalConnectionString" }],
    },
  ],
});

export const KeyValueResourceType = rt({
  name: "Key Value",
  plural: "Key Value Instances",
  id: "key-value",
  description: "A managed Render Key Value (Redis-compatible Valkey) instance",
  fields: [
    f("name", "Name"),
    f("status", "Status", { required: false, editable: false }),
    f("plan", "Instance Type", {
      kind: "enum",
      enumValues: ["free", "starter", "standard", "pro", "pro_plus"],
      required: false,
      description: "Changing the instance type restarts the instance.",
    }),
    regionField,
    f("version", "Version", { required: false, editable: false }),
    f("maxmemoryPolicy", "Eviction Policy", {
      kind: "enum",
      enumValues: [
        "noeviction",
        "allkeys_lru",
        "allkeys_lfu",
        "allkeys_random",
        "volatile_lru",
        "volatile_lfu",
        "volatile_random",
        "volatile_ttl",
      ],
      required: false,
    }),
    f("persistenceMode", "Persistence", {
      kind: "enum",
      enumValues: ["journal_snapshot", "snapshot", "off"],
      required: false,
    }),
    ...ipFields,
    f("maintenanceScheduledAt", "Maintenance Scheduled", { required: false, editable: false }),
    f("environmentId", "Environment", { required: false, editable: false }),
    f("ownerId", "Workspace", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("connectionString", "External Connection String", { sensitive: true }),
    o("internalConnectionString", "Internal Connection String", { sensitive: true }),
    o("cliCommand", "CLI Command", { sensitive: true, hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "environmentId", targetTypeId: "environment", label: "in environment" },
    { fieldKey: "ownerId", targetTypeId: "workspace", label: "in workspace" },
  ],
  postureChecks: [
    {
      id: "render-key-value-open-to-internet",
      title: "Accepts connections from any IP",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "openToInternet", when: "truthy" }],
      reason:
        "The access control list includes 0.0.0.0/0, so anyone who learns the connection string can read and write the data from anywhere.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "cache",
  lifecycle: {
    startActionId: "resume",
    stopActionId: "suspend",
    statusFieldKey: "status",
    runningValues: ["available"],
    stoppedValues: ["suspended"],
  },
  peerIntegrations: [
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Keys",
      unreachableWhen: {
        fieldsEmpty: ["allowedCidrs"],
        title: "This instance only accepts connections from Render's private network.",
        suggestions: [
          "Add this machine's IP address to Allowed Sources (Edit), or",
          "Connect from a service running on Render.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "redis-url",
      displayName: "Redis URL",
      description: "REDIS_URL for services running in the same Render region",
      entries: [{ envKey: "REDIS_URL", outputKey: "internalConnectionString" }],
    },
  ],
});

export const EnvGroupResourceType = rt({
  name: "Environment Group",
  id: "env-group",
  description: "A shared set of environment variables and secret files linked to services",
  fields: [
    f("name", "Name"),
    f("varCount", "Variables", { kind: "number", required: false, editable: false }),
    f("secretFileCount", "Secret Files", { kind: "number", required: false, editable: false }),
    f("linkedServiceIds", "Linked Services", { required: false, editable: false }),
    f("linkedServices", "Linked Service Names", { required: false, editable: false }),
    f("environmentId", "Environment", { required: false, editable: false }),
    f("ownerId", "Workspace", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("envGroupId", "Environment Group ID")],
  dependsOn: [
    { fieldKey: "linkedServiceIds", targetTypeId: "service", label: "linked to" },
    { fieldKey: "environmentId", targetTypeId: "environment", label: "in environment" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "secret",
  attachTargets: [{ pluginId: "render", resourceTypeId: "service", verb: "Link to" }],
});

export const EnvGroupVarResourceType = rt({
  name: "Group Variable",
  pinnable: false,
  id: "env-group-var",
  description: "An environment variable in a Render environment group",
  parentTypeId: "env-group",
  fields: [
    f("key", "Key", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "New value. Leave blank to keep the current one.",
    }),
    f("envGroupId", "Environment Group", { required: false, editable: false }),
    f("envGroupName", "Group Name", { required: false, editable: false }),
  ],
  outputs: [o("key", "Key"), o("value", "Value", { sensitive: true })],
  dependsOn: [{ fieldKey: "envGroupId", targetTypeId: "env-group", label: "in group" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "secret",
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description: "A Render project grouping services and datastores into environments",
  fields: [
    f("name", "Name"),
    f("environmentCount", "Environments", { kind: "number", required: false, editable: false }),
    f("ownerId", "Workspace", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("projectId", "Project ID")],
  dependsOn: [{ fieldKey: "ownerId", targetTypeId: "workspace", label: "in workspace" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "folder",
});

export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "environment",
  description: "An environment (production, staging, …) inside a Render project",
  parentTypeId: "project",
  fields: [
    f("name", "Name"),
    f("protectedStatus", "Protection", {
      kind: "enum",
      enumValues: ["unprotected", "protected"],
      required: false,
      description: "Protected environments only let admins make destructive changes.",
    }),
    f("networkIsolationEnabled", "Network Isolation", {
      kind: "boolean",
      required: false,
      description: "Block private-network traffic from other environments.",
    }),
    f("serviceCount", "Services", { kind: "number", required: false, editable: false }),
    f("databaseCount", "Postgres", { kind: "number", required: false, editable: false }),
    f("keyValueCount", "Key Value", { kind: "number", required: false, editable: false }),
    f("projectId", "Project", { required: false, editable: false }),
    f("projectName", "Project Name", { required: false, editable: false }),
  ],
  outputs: [o("environmentId", "Environment ID")],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "project", label: "in project" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "layers",
});

export const BlueprintResourceType = rt({
  name: "Blueprint",
  id: "blueprint",
  description: "An infrastructure-as-code Blueprint (render.yaml) synced from a Git repository",
  fields: [
    f("name", "Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["created", "paused", "in_sync", "syncing", "error"],
      required: false,
      editable: false,
    }),
    f("autoSync", "Auto Sync", {
      kind: "boolean",
      required: false,
      description: "Apply changes to render.yaml automatically on every push.",
    }),
    f("repo", "Repository", { required: false, editable: false }),
    f("branch", "Branch", { required: false, editable: false }),
    f("path", "Blueprint Path", { required: false, description: "Path to the YAML file." }),
    f("lastSync", "Last Sync", { required: false, editable: false }),
  ],
  outputs: [o("blueprintId", "Blueprint ID")],
  supportsUpdate: true,
  iconKey: "code",
});

export const MaintenanceResourceType = rt({
  name: "Maintenance Run",
  pinnable: false,
  id: "maintenance",
  description: "Scheduled or recent Render maintenance on a service or datastore",
  fields: [
    f("type", "Type", { required: false, editable: false }),
    f("state", "State", {
      kind: "enum",
      enumValues: [
        "scheduled",
        "in_progress",
        "user_fix_required",
        "cancelled",
        "succeeded",
        "failed",
      ],
      required: false,
      editable: false,
    }),
    f("scheduledAt", "Scheduled For", {
      required: false,
      description: "ISO 8601 time (UTC) to move the maintenance to, before the deadline.",
    }),
    f("pendingMaintenanceBy", "Must Run By", { required: false, editable: false }),
    f("resourceId", "Resource", { required: false, editable: false }),
    f("resourceName", "Resource Name", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "resourceId", label: "maintains" }],
  supportsUpdate: true,
  iconKey: "calendar",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  WorkspaceResourceType,
  ServiceResourceType,
  DeployResourceType,
  EnvVarResourceType,
  CustomDomainResourceType,
  JobResourceType,
  DiskResourceType,
  PostgresResourceType,
  KeyValueResourceType,
  EnvGroupResourceType,
  EnvGroupVarResourceType,
  ProjectResourceType,
  EnvironmentResourceType,
  BlueprintResourceType,
  MaintenanceResourceType,
];
