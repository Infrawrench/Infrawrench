import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** Railway Metal regions (docs.railway.com/reference/deployment-regions, 2026-10). */
export const REGIONS = [
  { id: "us-west2", label: "US West", location: "California, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  {
    id: "us-east4-eqdc4a",
    label: "US East",
    location: "Virginia, USA",
    flag: "\u{1F1FA}\u{1F1F8}",
  },
  {
    id: "europe-west4-drams3a",
    label: "EU West",
    location: "Amsterdam, Netherlands",
    flag: "\u{1F1F3}\u{1F1F1}",
  },
  {
    id: "asia-southeast1-eqsg3a",
    label: "Southeast Asia",
    location: "Singapore",
    flag: "\u{1F1F8}\u{1F1EC}",
  },
];

const ro = { required: false, editable: false } as const;

export const WorkspaceResourceType = rt({
  name: "Workspace",
  id: "workspace",
  description: "A Railway workspace, with its plan, members, usage this period and spend limit",
  fields: [
    f("name", "Name", { editable: false }),
    f("plan", "Plan", { kind: "enum", enumValues: ["FREE", "HOBBY", "PRO"], ...ro }),
    f("has2FAEnforcement", "Two-Factor Enforced", { kind: "boolean", ...ro }),
    f("memberCount", "Members", { kind: "number", ...ro }),
    f("preferredRegion", "Default Region", ro),
    f("currentUsage", "Usage This Period (USD)", { kind: "number", ...ro }),
    f("creditBalance", "Credit Balance (USD)", { kind: "number", ...ro }),
    f("billingPeriodEnd", "Billing Period Ends", ro),
    f("softLimit", "Usage Alert (USD)", {
      kind: "number",
      required: false,
      description:
        "Email alert when usage this period passes this amount. Clear both limits to remove them.",
    }),
    f("hardLimit", "Hard Limit (USD)", {
      kind: "number",
      required: false,
      description: "Railway stops every workload in the workspace when usage reaches this amount.",
    }),
    f("isOverLimit", "Over Limit", { kind: "boolean", ...ro }),
  ],
  outputs: [o("workspaceId", "Workspace ID")],
  supportsUpdate: true,
  iconKey: "team",
  postureChecks: [
    {
      id: "railway-workspace-no-2fa",
      title: "Two-factor authentication not enforced",
      severity: "medium",
      category: "other",
      conditions: [{ fieldKey: "has2FAEnforcement", when: "falsy" }],
      reason:
        "Members can sign in to Railway without a second factor, and one stolen password reaches every project, variable and database in the workspace.",
    },
  ],
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description: "A Railway project: services, volumes and environments deployed together",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("prDeploys", "PR Environments", {
      kind: "boolean",
      required: false,
      description: "Create a temporary environment for every pull request.",
    }),
    f("isPublic", "Public", {
      kind: "boolean",
      required: false,
      description: "Anyone with the link can view the project canvas (not its variables).",
    }),
    f("environmentCount", "Environments", { kind: "number", ...ro }),
    f("serviceCount", "Services", { kind: "number", ...ro }),
    f("workspaceId", "Workspace", ro),
    f("workspaceName", "Workspace Name", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("projectId", "Project ID")],
  dependsOn: [{ fieldKey: "workspaceId", targetTypeId: "workspace", label: "in workspace" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "folder",
  postureChecks: [
    {
      id: "railway-project-public",
      title: "Project canvas is public",
      severity: "low",
      category: "public-exposure",
      conditions: [{ fieldKey: "isPublic", when: "truthy" }],
      reason:
        "Anyone with the link can see the project's services, deployments and logs. Variables stay private, but logs often are not.",
    },
  ],
});

export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "environment",
  description: "An isolated copy of a Railway project's services (production, staging, PR)",
  parentTypeId: "project",
  fields: [
    f("name", "Name"),
    f("isEphemeral", "Ephemeral (PR)", { kind: "boolean", ...ro }),
    f("serviceCount", "Services", { kind: "number", ...ro }),
    f("volumeCount", "Volumes", { kind: "number", ...ro }),
    f("projectId", "Project", ro),
    f("projectName", "Project Name", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("environmentId", "Environment ID")],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "project", label: "in project" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "layers",
});

export const ServiceResourceType = rt({
  name: "Service",
  id: "service",
  description: "A Railway service as deployed in one environment",
  parentTypeId: "environment",
  showInSidebar: true,
  fields: [
    f("name", "Name", { description: "Renames the service in every environment." }),
    f("status", "Deployment Status", ro),
    f("state", "State", { kind: "enum", enumValues: ["running", "stopped", "none"], ...ro }),
    f("region", "Region", {
      kind: "enum",
      enumValues: REGIONS.map((r) => r.id),
      required: false,
      description: "Moving regions redeploys the service; attached volumes migrate.",
    }),
    f("numReplicas", "Replicas", {
      kind: "number",
      required: false,
      description: "Instances to run in the region (1 to the plan's replica limit).",
    }),
    f("vcpuLimit", "vCPU Limit", {
      kind: "number",
      required: false,
      description: "Maximum vCPUs per replica. Railway bills what is used, up to this limit.",
    }),
    f("memoryLimitGb", "Memory Limit (GB)", {
      kind: "number",
      required: false,
      description: "Maximum memory per replica.",
    }),
    f("repo", "Repository", {
      required: false,
      description: "GitHub repository (owner/name) to build from.",
    }),
    f("image", "Image", {
      required: false,
      description: "Docker image to deploy instead of a repository.",
    }),
    f("builder", "Builder", {
      kind: "enum",
      enumValues: ["RAILPACK", "NIXPACKS", "HEROKU", "PAKETO"],
      required: false,
    }),
    f("buildCommand", "Build Command", { required: false }),
    f("startCommand", "Start Command", { required: false }),
    f("preDeployCommand", "Pre-Deploy Command", {
      required: false,
      description: "Runs before each deploy, e.g. migrations.",
    }),
    f("rootDirectory", "Root Directory", { required: false }),
    f("dockerfilePath", "Dockerfile Path", { required: false }),
    f("railwayConfigFile", "Config File", {
      required: false,
      description: "Path to railway.json or railway.toml.",
    }),
    f("healthcheckPath", "Healthcheck Path", { required: false }),
    f("healthcheckTimeout", "Healthcheck Timeout (s)", { kind: "number", required: false }),
    f("cronSchedule", "Cron Schedule", {
      required: false,
      description: "Run as a cron job on this UTC schedule instead of staying up.",
    }),
    f("nextCronRunAt", "Next Cron Run", ro),
    f("sleepApplication", "Serverless (Sleep When Idle)", {
      kind: "boolean",
      required: false,
      description:
        "Stop the service after 10 minutes without outbound traffic and wake it on the next request.",
    }),
    f("restartPolicyType", "Restart Policy", {
      kind: "enum",
      enumValues: ["ON_FAILURE", "ALWAYS", "NEVER"],
      required: false,
    }),
    f("restartPolicyMaxRetries", "Max Restart Retries", { kind: "number", required: false }),
    f("url", "URL", ro),
    f("latestDeploymentId", "Latest Deployment", ro),
    f("serviceId", "Service ID", ro),
    f("environmentId", "Environment", ro),
    f("environmentName", "Environment Name", ro),
    f("projectId", "Project", ro),
    f("projectName", "Project Name", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("serviceId", "Service ID"), o("url", "Public URL"), o("hostname", "Public Hostname")],
  dependsOn: [
    { fieldKey: "environmentId", targetTypeId: "environment", label: "in environment" },
    { fieldKey: "projectId", targetTypeId: "project", label: "in project" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "server",
  lifecycle: {
    startActionId: "redeploy",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["running"],
    stoppedValues: ["stopped"],
  },
  secretExportTemplates: [
    {
      id: "service-url",
      displayName: "Service URL",
      description: "The service's public URL",
      entries: [{ envKey: "SERVICE_URL", outputKey: "url" }],
    },
  ],
});

export const DeploymentResourceType = rt({
  name: "Deployment",
  pinnable: false,
  id: "deployment",
  description: "A build and release of a Railway service in one environment",
  parentTypeId: "service",
  fields: [
    f("status", "Status"),
    f("reason", "Trigger", { required: false }),
    f("commitHash", "Commit", { required: false }),
    f("commitMessage", "Commit Message", { required: false }),
    f("branch", "Branch", { required: false }),
    f("image", "Image", { required: false }),
    f("url", "URL", { required: false }),
    f("canRollback", "Can Roll Back", { kind: "boolean", required: false }),
    f("deploymentStopped", "Stopped", { kind: "boolean", required: false }),
    f("serviceId", "Service", { required: false }),
    f("serviceName", "Service Name", { required: false }),
    f("environmentId", "Environment", { required: false }),
    f("projectId", "Project", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("deploymentId", "Deployment ID")],
  dependsOn: [
    {
      fieldKey: "serviceId",
      targetTypeId: "service",
      matchTemplate: "{environmentId}/{serviceId}",
      label: "deployment of",
    },
  ],
  iconKey: "deployment",
});

export const VariableResourceType = rt({
  name: "Variable",
  pinnable: false,
  id: "variable",
  description: "A service variable in one Railway environment",
  parentTypeId: "service",
  fields: [
    f("key", "Name", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description:
        "New value. Leave blank to keep the current one. Reference other variables with ${{ Service.VAR }}. Saving redeploys the service.",
    }),
    f("serviceId", "Service", ro),
    f("serviceName", "Service Name", ro),
    f("environmentId", "Environment", ro),
    f("projectId", "Project", ro),
  ],
  outputs: [o("key", "Name"), o("value", "Value", { sensitive: true })],
  dependsOn: [
    {
      fieldKey: "serviceId",
      targetTypeId: "service",
      matchTemplate: "{environmentId}/{serviceId}",
      label: "set on",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "secret",
});

export const SharedVariableResourceType = rt({
  name: "Shared Variable",
  pinnable: false,
  id: "shared-variable",
  description: "A variable shared by every service in a Railway environment",
  parentTypeId: "environment",
  fields: [
    f("key", "Name", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "New value. Leave blank to keep the current one.",
    }),
    f("environmentId", "Environment", ro),
    f("environmentName", "Environment Name", ro),
    f("projectId", "Project", ro),
  ],
  outputs: [o("key", "Name"), o("value", "Value", { sensitive: true })],
  dependsOn: [{ fieldKey: "environmentId", targetTypeId: "environment", label: "shared in" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "secret",
});

export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description: "A persistent Railway volume mounted into a service",
  fields: [
    f("name", "Name"),
    f("mountPath", "Mount Path", { description: "Absolute path inside the service, e.g. /data." }),
    f("sizeGb", "Size (GB)", { kind: "number", ...ro }),
    f("usedGb", "Used (GB)", { kind: "number", ...ro }),
    f("state", "State", ro),
    f("region", "Region", ro),
    f("serviceId", "Attached Service", ro),
    f("serviceName", "Attached Service Name", ro),
    f("environmentId", "Environment", ro),
    f("environmentName", "Environment Name", ro),
    f("projectId", "Project", ro),
    f("volumeInstanceId", "Volume Instance", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("volumeId", "Volume ID"), o("mountPath", "Mount Path")],
  dependsOn: [
    {
      fieldKey: "serviceId",
      targetTypeId: "service",
      matchTemplate: "{environmentId}/{serviceId}",
      label: "mounted by",
    },
    { fieldKey: "environmentId", targetTypeId: "environment", label: "in environment" },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "serviceId", when: "empty" }],
    reason: "Not mounted by any service, but its storage is still billed every minute.",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "volume",
  attachTargets: [{ pluginId: "railway", resourceTypeId: "service", verb: "Mount on" }],
});

export const DomainResourceType = rt({
  name: "Domain",
  id: "domain",
  description: "A Railway-provided or custom domain routed to a service",
  parentTypeId: "service",
  fields: [
    f("domain", "Domain", { editable: false }),
    f("kind", "Kind", { kind: "enum", enumValues: ["railway", "custom"], ...ro }),
    f("targetPort", "Target Port", {
      kind: "number",
      required: false,
      description: "Port inside the service the domain routes to. Blank uses the PORT variable.",
    }),
    f("syncStatus", "Sync Status", ro),
    f("verified", "DNS Verified", { kind: "boolean", ...ro }),
    f("certificateStatus", "Certificate", ro),
    f("certificateError", "Certificate Error", ro),
    f("certExpiresAt", "Certificate Expires", ro),
    f("dnsRecords", "Required DNS Records", ro),
    f("serviceId", "Service", ro),
    f("environmentId", "Environment", ro),
    f("projectId", "Project", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("hostname", "Hostname"), o("url", "URL")],
  dependsOn: [
    {
      fieldKey: "serviceId",
      targetTypeId: "service",
      matchTemplate: "{environmentId}/{serviceId}",
      label: "routes to",
    },
  ],
  expiryFields: [
    { fieldKey: "certExpiresAt", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "globe",
});

export const TcpProxyResourceType = rt({
  name: "TCP Proxy",
  id: "tcp-proxy",
  description: "A public TCP endpoint forwarding to a port inside a Railway service",
  parentTypeId: "service",
  fields: [
    f("endpoint", "Endpoint"),
    f("domain", "Host", { required: false }),
    f("proxyPort", "Public Port", { kind: "number", required: false }),
    f("applicationPort", "Service Port", { kind: "number", required: false }),
    f("syncStatus", "Sync Status", { required: false }),
    f("serviceId", "Service", { required: false }),
    f("environmentId", "Environment", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("endpoint", "Endpoint"), o("host", "Host"), o("port", "Port")],
  dependsOn: [
    {
      fieldKey: "serviceId",
      targetTypeId: "service",
      matchTemplate: "{environmentId}/{serviceId}",
      label: "forwards to",
    },
  ],
  postureChecks: [
    {
      id: "railway-tcp-proxy-public",
      title: "Service reachable over a public TCP port",
      severity: "low",
      category: "public-exposure",
      conditions: [{ fieldKey: "endpoint", when: "notEquals", value: "" }],
      reason:
        "Anyone on the internet can connect to this port. That is the point for a database you reach from outside Railway, so make sure the service behind it requires strong authentication.",
    },
  ],
  supportsCreate: true,
  iconKey: "network",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  WorkspaceResourceType,
  ProjectResourceType,
  EnvironmentResourceType,
  ServiceResourceType,
  DeploymentResourceType,
  VariableResourceType,
  SharedVariableResourceType,
  VolumeResourceType,
  DomainResourceType,
  TcpProxyResourceType,
];
