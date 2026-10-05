import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Anyscale resource types. Each names the `/api/v2` route it lists from
 * (published spec, verified 2026-10).
 */

export const WORKSPACE_STATES = [
  "Running",
  "StartingUp",
  "AwaitingStartup",
  "AwaitingFileMounts",
  "Updating",
  "Stopping",
  "Stopped",
  "Terminating",
  "Terminated",
  "StartupErrored",
  "UpdatingErrored",
  "StoppingErrored",
  "TerminatingErrored",
];

/** `GET /api/v2/userinfo/`: the organization the API key belongs to. */
export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "The Anyscale organization the API key belongs to. Shows Anyscale spend this month by workload type, project and user, and the remaining balance of every credit grant and prepaid commit, and charts daily spend.",
  fields: [
    f("name", "Name", { editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("permissionLevel", "Your Role", { required: false, editable: false }),
    f("defaultCloudId", "Default Cloud", { required: false, editable: false }),
    f("ssoMode", "SSO", { required: false, editable: false }),
    f("monthToDate", "Month-to-Date Spend (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("creditBalance", "Credit Balance (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("organizationId", "Organization ID")],
  dependsOn: [{ fieldKey: "defaultCloudId", targetTypeId: "cloud", label: "defaults to" }],
  supportsMetrics: true,
  iconKey: "account",
});

/** `GET /api/v2/clouds/` */
export const CloudResourceType = rt({
  name: "Cloud",
  id: "cloud",
  description:
    "An Anyscale cloud: where clusters run. Either customer-hosted (your AWS account, Google Cloud project or Kubernetes cluster, whose machines are billed by that provider) or Anyscale-hosted. Charts node count by market type, CPU and GPU count and utilization, and spot preemptions across every cluster in the cloud.",
  fields: [
    f("name", "Name", { editable: false }),
    f("cloudId", "Cloud ID", { required: false, editable: false }),
    f("hosting", "Hosting", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["Anyscale-hosted", "Customer cloud"],
    }),
    f("provider", "Provider", { required: false, editable: false }),
    f("computeStack", "Compute Stack", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("isDefault", "Default Cloud", { kind: "boolean", required: false, editable: false }),
    f("runningClusters", "Running Clusters", { kind: "number", required: false, editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("cloudId", "Cloud ID")],
  supportsMetrics: true,
  iconKey: "network",
});

/** `GET /api/v2/projects/` */
export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "An Anyscale project: groups workspaces, jobs and services inside a cloud. Create and delete projects, and chart the node count and utilization of the clusters running in one.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("cloudId", "Cloud", { required: false, editable: false }),
    f("cloudName", "Cloud Name", { required: false, editable: false }),
    f("isDefault", "Default Project", { kind: "boolean", required: false, editable: false }),
    f("owners", "Owners", { required: false, editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("projectId", "Project ID")],
  dependsOn: [{ fieldKey: "cloudId", targetTypeId: "cloud", label: "in" }],
  supportsCreate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "project",
});

/** `GET /api/v2/experimental_workspaces/` joined with its cluster. */
export const WorkspaceResourceType = rt({
  name: "Workspace",
  id: "workspace",
  description:
    "An Anyscale workspace: an interactive development cluster. Start and terminate it, see whether Anyscale considers it idle and when auto-termination will stop it, and see what it has cost.",
  fields: [
    f("name", "Name", { editable: false }),
    f("state", "State", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: WORKSPACE_STATES,
    }),
    f("projectId", "Project", { required: false, editable: false }),
    f("projectName", "Project Name", { required: false, editable: false }),
    f("cloudId", "Cloud", { required: false, editable: false }),
    f("computeConfigId", "Compute Config", { required: false, editable: false }),
    f("activity", "Activity", { required: false, editable: false }),
    f("idle", "Idle", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["yes", "no"],
      description: "Running with no Ray, command or editor activity, as Anyscale reports it.",
    }),
    f("idleTerminationMinutes", "Idle Termination (min)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("idleSince", "Idle Since", { required: false, editable: false }),
    f("rayVersion", "Ray Version", { required: false, editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
    f("lastStartedAt", "Last Started", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("workspaceId", "Workspace ID", { required: false, editable: false }),
    f("clusterId", "Cluster ID", { required: false, editable: false }),
  ],
  outputs: [o("workspaceId", "Workspace ID"), o("url", "Console URL")],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "project", label: "in" },
    { fieldKey: "cloudId", targetTypeId: "cloud", label: "runs on" },
    { fieldKey: "computeConfigId", targetTypeId: "compute-config", label: "uses" },
  ],
  // Starting `POST /sessions/{cluster}/start`, terminating
  // `POST /sessions/{cluster}/stop` with `terminate: true`, exactly as
  // `anyscale workspace_v2 start|terminate` do.
  lifecycle: {
    startActionId: "start",
    stopActionId: "terminate",
    statusFieldKey: "state",
    runningValues: ["Running", "StartingUp", "AwaitingStartup", "AwaitingFileMounts", "Updating"],
    stoppedValues: ["Terminated", "Terminating", "Stopped", "Stopping"],
  },
  // The lister sets `idle` to "yes" only for a running workspace whose
  // cluster reports idle_termination_status IDLE.
  orphanRule: {
    conditions: [{ fieldKey: "idle", when: "equals", value: "yes" }],
    reason: "Workspace is running but idle: no Ray, command or editor activity",
  },
  iconKey: "compute",
});

/** `GET /api/v2/decorated_ha_jobs/?type_filter=BATCH_JOB` */
export const JobResourceType = rt({
  name: "Job",
  id: "job",
  description:
    "An Anyscale job: a batch workload on its own cluster. Shows state, the last run, retries, its schedule or queue, and what it has cost; terminate a running job.",
  fields: [
    f("name", "Name", { editable: false }),
    f("state", "State", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: [
        "PENDING",
        "AWAITING_CLUSTER_START",
        "UPDATING",
        "RUNNING",
        "RESTARTING",
        "CLEANING_UP",
        "SUCCESS",
        "ERRORED",
        "TERMINATED",
        "BROKEN",
        "OUT_OF_RETRIES",
      ],
    }),
    f("goalState", "Goal State", { required: false, editable: false }),
    f("lastRunStatus", "Last Run", { required: false, editable: false }),
    f("projectId", "Project", { required: false, editable: false }),
    f("projectName", "Project Name", { required: false, editable: false }),
    f("cloudId", "Cloud", { required: false, editable: false }),
    f("computeConfigId", "Compute Config", { required: false, editable: false }),
    f("entrypoint", "Entrypoint", { required: false, editable: false }),
    f("image", "Image", { required: false, editable: false }),
    f("maxRetries", "Max Retries", { kind: "number", required: false, editable: false }),
    f("timeoutSeconds", "Timeout (s)", { kind: "number", required: false, editable: false }),
    f("schedule", "Schedule", { required: false, editable: false }),
    f("jobQueue", "Job Queue", { required: false, editable: false }),
    f("error", "Error", { required: false, editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("jobId", "Job ID", { required: false, editable: false }),
  ],
  outputs: [o("jobId", "Job ID"), o("url", "Console URL")],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "project", label: "in" },
    { fieldKey: "cloudId", targetTypeId: "cloud", label: "runs on" },
    { fieldKey: "computeConfigId", targetTypeId: "compute-config", label: "uses" },
  ],
  iconKey: "pipeline",
});

/** `GET /api/v2/services-v2/` */
export const ServiceResourceType = rt({
  name: "Service",
  id: "service",
  description:
    "An Anyscale service: a Ray Serve deployment. Shows its state, rollout progress between the primary and canary versions and their traffic weights, endpoint and cost; roll back a rollout or terminate the service.",
  fields: [
    f("name", "Name", { editable: false }),
    f("state", "State", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: [
        "STARTING",
        "RUNNING",
        "UPDATING",
        "ROLLING_OUT",
        "ROLLING_BACK",
        "UNHEALTHY",
        "SYSTEM_FAILURE",
        "USER_ERROR_FAILURE",
        "TERMINATING",
        "TERMINATED",
      ],
    }),
    f("goalState", "Goal State", { required: false, editable: false }),
    f("rollout", "Rollout", { required: false, editable: false }),
    f("primaryVersion", "Primary Version", { required: false, editable: false }),
    f("primaryWeight", "Primary Traffic (%)", { kind: "number", required: false, editable: false }),
    f("canaryVersion", "Canary Version", { required: false, editable: false }),
    f("canaryWeight", "Canary Traffic (%)", { kind: "number", required: false, editable: false }),
    f("autoRollout", "Auto Rollout", { kind: "boolean", required: false, editable: false }),
    f("baseUrl", "Endpoint", { required: false, editable: false }),
    f("projectId", "Project", { required: false, editable: false }),
    f("cloudId", "Cloud", { required: false, editable: false }),
    f("computeConfigId", "Compute Config", { required: false, editable: false }),
    f("error", "Error", { required: false, editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("serviceId", "Service ID", { required: false, editable: false }),
  ],
  outputs: [o("serviceId", "Service ID"), o("baseUrl", "Endpoint"), o("url", "Console URL")],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "project", label: "in" },
    { fieldKey: "cloudId", targetTypeId: "cloud", label: "runs on" },
    { fieldKey: "computeConfigId", targetTypeId: "compute-config", label: "uses" },
  ],
  iconKey: "deployment",
});

/** `POST /api/v2/compute_templates/search` (named, unarchived configs). */
export const ComputeConfigResourceType = rt({
  name: "Compute Config",
  id: "compute-config",
  description:
    "An Anyscale compute config: the head and worker node types, autoscaling bounds, spot usage and auto-termination a cluster launches with. Archive configs nobody uses.",
  fields: [
    f("name", "Name", { editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
    f("cloudId", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("headNodeType", "Head Node", { required: false, editable: false }),
    f("workerNodeTypes", "Worker Nodes", { required: false, editable: false }),
    f("maxWorkers", "Max Workers", { kind: "number", required: false, editable: false }),
    f("usesSpot", "Uses Spot", { kind: "boolean", required: false, editable: false }),
    f("idleTerminationMinutes", "Idle Termination (min)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maximumUptimeMinutes", "Maximum Uptime (min)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("creator", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("computeConfigId", "Compute Config ID", { required: false, editable: false }),
  ],
  outputs: [o("computeConfigId", "Compute Config ID")],
  dependsOn: [{ fieldKey: "cloudId", targetTypeId: "cloud", label: "for" }],
  supportsDelete: true,
  iconKey: "sliders",
});

/** `GET /api/v2/instance_usage_budgets/` */
export const BudgetResourceType = rt({
  name: "Budget",
  id: "budget",
  description:
    "An Anyscale budget: a daily or monthly soft limit on Anyscale spend for the organization, a cloud, or a project in a cloud, which alerts when crossed. Create, edit, enable, disable and delete budgets.",
  fields: [
    f("name", "Name", { editable: false }),
    f("budgetAmount", "Amount", {
      kind: "number",
      description: "The limit, in the unit below.",
    }),
    f("budgetUnit", "Unit", {
      kind: "enum",
      required: false,
      enumValues: ["DOLLARS", "ANYSCALE_CREDITS"],
      description: "US dollars, or Anyscale credits.",
    }),
    f("evaluationPeriod", "Period", {
      kind: "enum",
      enumValues: ["DAILY", "MONTHLY"],
      description: "Daily budgets reset at midnight UTC; monthly budgets on the 1st.",
    }),
    f("scope", "Scope", { required: false, editable: false }),
    f("cloudId", "Cloud", { required: false, editable: false }),
    f("projectId", "Project", { required: false, editable: false }),
    f("currentUsage", "Current Usage", { kind: "number", required: false, editable: false }),
    f("percentUsed", "Used (%)", { kind: "number", required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("lastNotifiedAt", "Last Alerted", { required: false, editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "cloudId", targetTypeId: "cloud", label: "limits" },
    { fieldKey: "projectId", targetTypeId: "project", label: "limits" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "sliders",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  CloudResourceType,
  ProjectResourceType,
  WorkspaceResourceType,
  JobResourceType,
  ServiceResourceType,
  ComputeConfigResourceType,
  BudgetResourceType,
];
