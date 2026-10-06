import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

const ro = { required: false, editable: false } as const;

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description: "The Koyeb organization the API token belongs to, with its plan and spending alert",
  fields: [
    f("name", "Name", { editable: false }),
    f("plan", "Plan", ro),
    f("status", "Status", ro),
    f("statusMessage", "Status Detail", ro),
    f("hasPaymentMethod", "Payment Method on File", { kind: "boolean", ...ro }),
    f("trialEndsAt", "Trial Ends", ro),
    f("spendingAlert", "Spending Alert (USD)", {
      kind: "number",
      required: false,
      description:
        "Email alert when this month's usage passes the amount (at least $5). Clear to remove the alert.",
    }),
    f("apps", "Apps", { kind: "number", ...ro }),
    f("services", "Services", { kind: "number", ...ro }),
    f("instances", "Running Instances", { kind: "number", ...ro }),
  ],
  outputs: [o("organizationId", "Organization ID")],
  supportsUpdate: true,
  iconKey: "team",
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description: "A Koyeb project grouping apps, services, secrets and domains",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("serviceCount", "Services", { kind: "number", ...ro }),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("projectId", "Project ID")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "folder",
});

export const AppResourceType = rt({
  name: "App",
  id: "app",
  description: "A Koyeb app: a namespace of services sharing a domain and private network",
  fields: [
    f("name", "Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "STARTING",
        "HEALTHY",
        "DEGRADED",
        "UNHEALTHY",
        "DELETING",
        "DELETED",
        "PAUSING",
        "PAUSED",
        "RESUMING",
      ],
      ...ro,
    }),
    f("domains", "Domains", ro),
    f("messages", "Messages", ro),
    f("pausedAt", "Paused", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("appId", "App ID"), o("url", "URL"), o("hostname", "Hostname")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "app",
  lifecycle: {
    startActionId: "resume",
    stopActionId: "pause",
    statusFieldKey: "status",
    runningValues: ["HEALTHY", "DEGRADED", "STARTING", "RESUMING"],
    stoppedValues: ["PAUSED", "PAUSING"],
  },
});

export const ServiceResourceType = rt({
  name: "Service",
  id: "service",
  description: "A Koyeb web service, worker or managed Postgres database",
  parentTypeId: "app",
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", { kind: "enum", enumValues: ["WEB", "WORKER", "DATABASE"], ...ro }),
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "STARTING",
        "HEALTHY",
        "DEGRADED",
        "UNHEALTHY",
        "DELETING",
        "DELETED",
        "PAUSING",
        "PAUSED",
        "RESUMING",
      ],
      ...ro,
    }),
    f("region", "Region", ro),
    f("regions", "Regions", {
      required: false,
      description: "Comma-separated region ids (fra, was, sin, …). Changing them redeploys.",
    }),
    f("instanceType", "Instance Type", {
      required: false,
      description:
        "nano, micro, small, medium, large, … or an eco or GPU type. Changing it redeploys.",
    }),
    f("minScale", "Min Instances", {
      kind: "number",
      required: false,
      description: "0 enables scale-to-zero on plans that allow it.",
    }),
    f("maxScale", "Max Instances", {
      kind: "number",
      required: false,
      description: "Above Min, the service autoscales between the two.",
    }),
    f("image", "Docker Image", {
      required: false,
      description: "Image to deploy, for image-based services.",
    }),
    f("repository", "Git Repository", ro),
    f("branch", "Branch", {
      required: false,
      description: "Branch to build, for Git-based services.",
    }),
    f("buildCommand", "Build Command", { required: false }),
    f("runCommand", "Run Command", { required: false }),
    f("ports", "Ports", ro),
    f("routes", "Routes", ro),
    f("envCount", "Environment Variables", { kind: "number", ...ro }),
    f("pgVersion", "Postgres Version", { kind: "number", ...ro }),
    f("dbHost", "Database Host", ro),
    f("dbState", "Database Endpoint State", ro),
    f("dbSizeMb", "Database Size (MB)", { kind: "number", ...ro }),
    f("activeDeploymentId", "Active Deployment", ro),
    f("latestDeploymentId", "Latest Deployment", ro),
    f("appId", "App", ro),
    f("appName", "App Name", ro),
    f("messages", "Messages", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [
    o("serviceId", "Service ID"),
    o("url", "URL"),
    o("privateHost", "Private Host"),
    o("connectionString", "Connection String", { sensitive: true }),
  ],
  dependsOn: [{ fieldKey: "appId", targetTypeId: "app", label: "in app" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "server",
  lifecycle: {
    startActionId: "resume",
    stopActionId: "pause",
    statusFieldKey: "status",
    runningValues: ["HEALTHY", "DEGRADED", "STARTING", "RESUMING"],
    stoppedValues: ["PAUSED", "PAUSING"],
  },
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "type", equals: "DATABASE" },
    },
  ],
  secretExportTemplates: [
    {
      id: "database-url",
      displayName: "Database URL",
      description: "DATABASE_URL for a Koyeb Postgres service",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});

export const DeploymentResourceType = rt({
  name: "Deployment",
  pinnable: false,
  id: "deployment",
  description: "One deployment (build and rollout) of a Koyeb service",
  parentTypeId: "service",
  fields: [
    f("status", "Status"),
    f("trigger", "Trigger", { required: false }),
    f("sha", "Commit", { required: false }),
    f("commitMessage", "Commit Message", { required: false }),
    f("image", "Image", { required: false }),
    f("active", "Active", { kind: "boolean", required: false }),
    f("messages", "Messages", { required: false }),
    f("serviceId", "Service", { required: false }),
    f("appId", "App", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("succeededAt", "Succeeded", { required: false }),
  ],
  outputs: [o("deploymentId", "Deployment ID")],
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "service", label: "deployment of" }],
  iconKey: "deployment",
});

export const InstanceResourceType = rt({
  name: "Instance",
  pinnable: false,
  id: "instance",
  description: "A running instance (replica) of a Koyeb service",
  parentTypeId: "service",
  fields: [
    f("status", "Status"),
    f("type", "Instance Type", { required: false }),
    f("region", "Region", { required: false }),
    f("datacenter", "Datacenter", { required: false }),
    f("replicaIndex", "Replica", { kind: "number", required: false }),
    f("messages", "Messages", { required: false }),
    f("serviceId", "Service", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "service", label: "instance of" }],
  iconKey: "server",
});

export const SecretResourceType = rt({
  name: "Secret",
  id: "secret",
  description: "A Koyeb secret (value or registry credential) services reference by name",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", { kind: "enum", enumValues: ["SIMPLE", "REGISTRY", "MANAGED"], ...ro }),
    f("registry", "Registry", ro),
    f("value", "Value", {
      kind: "password",
      required: false,
      description:
        "New value for a simple secret. Leave blank to keep it. Services pick it up on their next deployment.",
    }),
    f("createdAt", "Created", ro),
    f("updatedAt", "Updated", ro),
  ],
  outputs: [o("secretName", "Secret Name"), o("value", "Value", { sensitive: true })],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "secret",
});

export const DomainResourceType = rt({
  name: "Domain",
  id: "domain",
  description: "A Koyeb-assigned or custom domain routed to an app",
  fields: [
    f("name", "Domain", { editable: false }),
    f("type", "Type", { kind: "enum", enumValues: ["AUTOASSIGNED", "CUSTOM"], ...ro }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["PENDING", "ACTIVE", "ERROR", "DELETING", "DELETED"],
      ...ro,
    }),
    f("intendedCname", "CNAME Target", ro),
    f("appId", "App", ro),
    f("appName", "App Name", ro),
    f("verifiedAt", "Verified", ro),
    f("messages", "Messages", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("hostname", "Hostname"), o("url", "URL"), o("cnameTarget", "CNAME Target")],
  dependsOn: [{ fieldKey: "appId", targetTypeId: "app", label: "routes to" }],
  supportsCreate: true,
  iconKey: "globe",
});

export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description: "A Koyeb persistent volume (block storage in one region)",
  fields: [
    f("name", "Name"),
    f("region", "Region", ro),
    f("sizeGb", "Size (GB)", {
      kind: "number",
      required: false,
      description: "Volumes can only grow.",
    }),
    f("usedGb", "Used (GB)", { kind: "number", ...ro }),
    f("status", "Status", ro),
    f("readOnly", "Read Only", { kind: "boolean", ...ro }),
    f("serviceId", "Attached Service", ro),
    f("snapshotId", "Created From Snapshot", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("volumeId", "Volume ID")],
  dependsOn: [
    { fieldKey: "serviceId", targetTypeId: "service", label: "mounted by" },
    { fieldKey: "snapshotId", targetTypeId: "snapshot", label: "restored from" },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "serviceId", when: "empty" }],
    reason: "Not attached to any service, but its storage is still billed.",
  },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "volume",
});

export const SnapshotResourceType = rt({
  name: "Snapshot",
  id: "snapshot",
  description: "A snapshot of a Koyeb volume",
  fields: [
    f("name", "Name"),
    f("status", "Status", { required: false }),
    f("type", "Type", { required: false }),
    f("size", "Size", { kind: "number", required: false }),
    f("region", "Region", { required: false }),
    f("parentVolumeId", "Volume", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  dependsOn: [{ fieldKey: "parentVolumeId", targetTypeId: "volume", label: "snapshot of" }],
  backupRole: { role: "snapshot", sourceKey: "parentVolumeId", createdKey: "createdAt" },
  iconKey: "camera",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  ProjectResourceType,
  AppResourceType,
  ServiceResourceType,
  DeploymentResourceType,
  InstanceResourceType,
  SecretResourceType,
  DomainResourceType,
  VolumeResourceType,
  SnapshotResourceType,
];
