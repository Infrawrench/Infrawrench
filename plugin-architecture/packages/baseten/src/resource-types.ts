import { f, o, rt } from "@infrawrench/plugin-base";
import type { FieldDefinition, ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * External ids:
 * - model, chain, training project, training job, instance type: Baseten's own id
 * - deployment: `<modelId>/<deploymentId>` (every deployment route is under `/models/{id}`)
 * - environment: `<modelId>/<environmentName>`
 * - secret: `<teamName>/<secretName>` (secrets are addressed by name within a team)
 * - model API: its slug (`name`), the identifier the usage and billing APIs report
 */

/** Deployment statuses exactly as Baseten reports them (`DeploymentStatusV1`). */
export const DEPLOYMENT_STATUSES = [
  "BUILDING",
  "DEPLOYING",
  "DEPLOY_FAILED",
  "LOADING_MODEL",
  "ACTIVE",
  "UNHEALTHY",
  "BUILD_FAILED",
  "BUILD_STOPPED",
  "DEACTIVATING",
  "INACTIVE",
  "FAILED",
  "UPDATING",
  "SCALED_TO_ZERO",
  "WAKING_UP",
] as const;

/** Statuses of a deployment that is switched on (it may still be scaled to zero). */
export const ACTIVATED_STATUSES = [
  "ACTIVE",
  "SCALED_TO_ZERO",
  "WAKING_UP",
  "UPDATING",
  "UNHEALTHY",
  "LOADING_MODEL",
];

/** Training job statuses with the `TRAINING_JOB_` prefix removed and lowercased. */
export const TRAINING_JOB_STATUSES = [
  "created",
  "pending",
  "deploying",
  "running",
  "completed",
  "failed",
  "deploy_failed",
  "stopped",
  "preempted",
] as const;

/** Window, in days, over which `requests7d` / `cost7d` / `idle` are computed. */
export const IDLE_WINDOW_DAYS = 7;

/**
 * Autoscaling bounds from Baseten's autoscaling reference
 * (docs.baseten.co/deployment/autoscaling/overview, 2026-10). `updateResource`
 * validates against these before calling the API so a bad value fails with a
 * readable message instead of a 422.
 */
export const AUTOSCALING_BOUNDS = {
  minReplica: { min: 0 },
  maxReplica: { min: 1 },
  concurrencyTarget: { min: 1 },
  targetUtilization: { min: 1, max: 100 },
  autoscalingWindow: { min: 10, max: 3600 },
  scaleDownDelay: { min: 0, max: 3600 },
  targetInFlightTokens: { min: 1 },
} as const;

function autoscalingFields(): FieldDefinition[] {
  return [
    f("minReplica", "Min Replicas", {
      kind: "number",
      required: false,
      description:
        "Replicas kept running even with no traffic. Each one is billed per minute; 0 lets the deployment scale to zero.",
    }),
    f("maxReplica", "Max Replicas", {
      kind: "number",
      required: false,
      description:
        "Upper bound the autoscaler can scale to. At least 1 and never below min replicas.",
    }),
    f("concurrencyTarget", "Concurrency Target", {
      kind: "number",
      required: false,
      description: "In-flight requests per replica before the autoscaler adds another replica.",
    }),
    f("targetUtilization", "Target Utilization (%)", {
      kind: "number",
      required: false,
      description:
        "Share of the concurrency target to aim for, 1 to 100. Lower values leave headroom.",
    }),
    f("autoscalingWindow", "Autoscaling Window (s)", {
      kind: "number",
      required: false,
      description:
        "How far back traffic is averaged before a scaling decision, 10 to 3600 seconds.",
    }),
    f("scaleDownDelay", "Scale-Down Delay (s)", {
      kind: "number",
      required: false,
      description: "How long traffic must stay low before replicas are removed, 0 to 3600 seconds.",
    }),
    f("targetInFlightTokens", "Target In-Flight Tokens", {
      kind: "number",
      required: false,
      description: "Token-based autoscaling target for BIS-LLM deployments. Leave blank otherwise.",
    }),
  ];
}

export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description: "A Baseten model: a named container for its deployments and environments",
  fields: [
    f("name", "Name", {
      description:
        "Renaming keeps the model ID, endpoints and deployments. Update model_name in config.yaml afterwards so pushes target this model.",
    }),
    f("teamName", "Team", { required: false, editable: false }),
    f("deploymentsCount", "Deployments", { kind: "number", required: false, editable: false }),
    f("productionDeploymentId", "Production Deployment", { required: false, editable: false }),
    f("developmentDeploymentId", "Development Deployment", { required: false, editable: false }),
    f("instanceType", "Production Instance Type", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("modelId", "Model ID"), o("productionUrl", "Production Endpoint")],
  iconKey: "model",
  // Edit = rename (the only mutable field of PATCH /v1/models/{id}).
  supportsUpdate: true,
});

export const DeploymentResourceType = rt({
  name: "Deployment",
  id: "deployment",
  description: "A deployment (version) of a Baseten model, with its own replicas and autoscaling",
  fields: [
    f("name", "Name", { editable: false }),
    f("modelName", "Model", { required: false, editable: false }),
    f("modelId", "Model ID", { editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: [...DEPLOYMENT_STATUSES],
      editable: false,
    }),
    f("environment", "Environment", {
      required: false,
      editable: false,
      description: "The environment this deployment currently serves, if any",
    }),
    f("isProduction", "Production", { kind: "boolean", required: false, editable: false }),
    f("isDevelopment", "Development", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "Development deployments are limited to 0 or 1 replica",
    }),
    f("activeReplicas", "Active Replicas", { kind: "number", required: false, editable: false }),
    ...autoscalingFields(),
    f("instanceType", "Instance Type", { required: false, editable: false }),
    f("gpuType", "GPU", { required: false, editable: false }),
    f("gpuCount", "GPUs per Replica", { kind: "number", required: false, editable: false }),
    f("pricePerHour", "Price per Replica-Hour (USD)", {
      kind: "number",
      required: false,
      editable: false,
      description: "Baseten's published per-minute price for the instance type, times 60",
    }),
    f("minReplicaMonthlyCost", "Min-Replica Floor (USD/month)", {
      kind: "number",
      required: false,
      editable: false,
      description:
        "What the min replicas cost if they run all month (730 hours) with no other traffic",
    }),
    f("region", "Region", { required: false, editable: false }),
    f("backpressurePolicy", "When Full", {
      required: false,
      editable: false,
      description: "QUEUE_ON_FULL queues requests above capacity; REJECT_ON_FULL returns 429",
    }),
    f("requests7d", "Requests (7 days)", {
      kind: "number",
      required: false,
      editable: false,
      description: "Inference requests Baseten billed against this deployment over the last 7 days",
    }),
    f("minutes7d", "Billed Minutes (7 days)", { kind: "number", required: false, editable: false }),
    f("cost7d", "Cost (7 days, USD)", { kind: "number", required: false, editable: false }),
    f("idle", "Idle With Warm Replicas", {
      required: false,
      editable: false,
      description:
        "yes when min replicas are above 0 and the deployment served no requests in 7 days. Only set when the API key can read billing usage.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("predictUrl", "Predict Endpoint")],
  dependsOn: [
    { fieldKey: "modelId", targetTypeId: "model", label: "version of" },
    {
      fieldKey: "instanceType",
      targetTypeId: "instance-type",
      targetKey: "name",
      label: "runs on",
    },
  ],
  parentTypeId: "model",
  showInSidebar: true,
  iconKey: "deployment",
  // Edit = autoscaling settings (PATCH .../autoscaling_settings).
  supportsUpdate: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "activate",
    stopActionId: "deactivate",
    statusFieldKey: "status",
    runningValues: ACTIVATED_STATUSES,
    stoppedValues: ["INACTIVE"],
  },
  orphanRule: {
    conditions: [{ fieldKey: "idle", when: "equals", value: "yes" }],
    reason:
      "Deployment keeps min replicas warm, billed per minute, but served no inference requests in the last 7 days. Lower min replicas to 0 so it scales to zero, or deactivate it.",
  },
});

export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "environment",
  description:
    "A stable endpoint for a Baseten model (production, staging, ...) that deployments are promoted into",
  fields: [
    f("name", "Name", {
      editable: false,
      description: "Lowercase letters, numbers and hyphens. production exists on every model.",
    }),
    f("modelName", "Model", { required: false, editable: false }),
    f("modelId", "Model ID", { editable: false }),
    f("currentDeploymentId", "Current Deployment", { required: false, editable: false }),
    f("currentDeploymentName", "Current Deployment Name", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: [...DEPLOYMENT_STATUSES],
      required: false,
      editable: false,
      description: "Status of the deployment currently serving the environment",
    }),
    f("activeReplicas", "Active Replicas", { kind: "number", required: false, editable: false }),
    f("candidateDeploymentName", "Promoting", { required: false, editable: false }),
    f("promotionStatus", "Promotion Status", { required: false, editable: false }),
    f("trafficToCandidate", "Traffic to New Version (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    ...autoscalingFields(),
    f("promotionCleanup", "After Promotion", {
      kind: "enum",
      enumValues: ["KEEP", "SCALE_TO_ZERO", "DEACTIVATE"],
      required: false,
      description: "What happens to the previous deployment once a promotion finishes",
    }),
    f("rollingDeploy", "Rolling Deploy", {
      kind: "boolean",
      required: false,
      description: "Shift traffic replica by replica instead of all at once",
    }),
    f("backpressurePolicy", "When Full", {
      kind: "enum",
      enumValues: ["QUEUE_ON_FULL", "REJECT_ON_FULL"],
      required: false,
      description: "Queue requests above capacity, or reject them with 429",
    }),
    f("instanceType", "Instance Type", { required: false, editable: false }),
    f("gpuType", "GPU", { required: false, editable: false }),
    f("scheduleCount", "Autoscaling Schedules", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("predictUrl", "Predict Endpoint")],
  dependsOn: [
    { fieldKey: "modelId", targetTypeId: "model", label: "endpoint of" },
    {
      fieldKey: "currentDeploymentId",
      matchTemplate: "{modelId}/{currentDeploymentId}",
      targetTypeId: "deployment",
      label: "served by",
    },
  ],
  parentTypeId: "model",
  showInSidebar: true,
  iconKey: "layers",
  supportsCreate: true,
  // Edit = autoscaling, promotion and backpressure settings (PATCH environment).
  supportsUpdate: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "activate",
    stopActionId: "deactivate",
    statusFieldKey: "status",
    runningValues: ACTIVATED_STATUSES,
    stoppedValues: ["INACTIVE"],
  },
});

export const ChainResourceType = rt({
  name: "Chain",
  id: "chain",
  description: "A Baseten Chain: a multi-step inference pipeline of chainlets",
  fields: [
    f("name", "Name", { editable: false }),
    f("teamName", "Team", { required: false, editable: false }),
    f("deploymentsCount", "Deployments", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "pipeline",
});

export const InstanceTypeResourceType = rt({
  name: "Instance Type",
  id: "instance-type",
  description: "A Baseten hardware option with its published per-minute price",
  fields: [
    f("name", "Name"),
    f("gpuType", "GPU", { required: false }),
    f("gpuCount", "GPUs", { kind: "number", required: false }),
    f("gpuMemoryGib", "GPU Memory (GiB)", { kind: "number", required: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false }),
    f("memoryGib", "Memory (GiB)", { kind: "number", required: false }),
    f("pricePerMinute", "Price per Minute (USD)", { kind: "number", required: false }),
    f("pricePerHour", "Price per Hour (USD)", { kind: "number", required: false }),
  ],
  iconKey: "cpu",
  pinnable: false,
  supportsDelete: false,
});

export const SecretResourceType = rt({
  name: "Secret",
  id: "secret",
  description: "A Baseten workspace secret, readable by models and training jobs at runtime",
  fields: [
    f("name", "Name", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "Write-only. Leave blank to keep the current value; Baseten never returns it.",
    }),
    f("teamName", "Team", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "secret",
  pinnable: false,
  supportsCreate: true,
  // Edit = rotate the value (the upsert endpoint).
  supportsUpdate: true,
});

export const TrainingProjectResourceType = rt({
  name: "Training Project",
  id: "training-project",
  description: "A Baseten training project grouping training jobs and their checkpoints",
  fields: [
    f("name", "Name", { editable: false }),
    f("teamName", "Team", { required: false, editable: false }),
    f("latestJobId", "Latest Job", { required: false, editable: false }),
    f("latestJobStatus", "Latest Job Status", {
      kind: "enum",
      enumValues: [...TRAINING_JOB_STATUSES],
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  iconKey: "project",
});

export const TrainingJobResourceType = rt({
  name: "Training Job",
  id: "training-job",
  description: "A Baseten training run on dedicated or spot GPUs",
  fields: [
    f("name", "Name", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: [...TRAINING_JOB_STATUSES],
      editable: false,
    }),
    f("projectId", "Project ID", { editable: false }),
    f("projectName", "Project", { required: false, editable: false }),
    f("instanceType", "Instance Type", { required: false, editable: false }),
    f("gpuType", "GPU", { required: false, editable: false }),
    f("gpuCount", "GPUs per Node", { kind: "number", required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("totalGpus", "Total GPUs", { kind: "number", required: false, editable: false }),
    f("availability", "Capacity", {
      required: false,
      editable: false,
      description: "dedicated (on-demand, never preempted) or spot",
    }),
    f("priority", "Queue Priority", { kind: "number", required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("errorMessage", "Error", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "training-project", label: "in project" },
    {
      fieldKey: "instanceType",
      targetTypeId: "instance-type",
      targetKey: "name",
      label: "runs on",
    },
  ],
  parentTypeId: "training-project",
  showInSidebar: true,
  iconKey: "job",
  supportsMetrics: true,
});

export const ModelApiResourceType = rt({
  name: "Model API",
  id: "model-api",
  description:
    "A token-priced hosted model your workspace has added from Baseten's Model APIs catalog",
  fields: [
    f("name", "Slug"),
    f("displayName", "Name", { required: false }),
    f("family", "Family", { required: false }),
    f("contextLength", "Context Length (tokens)", { kind: "number", required: false }),
    f("inputPricePerMillion", "Input Price (USD / 1M tokens)", {
      kind: "number",
      required: false,
    }),
    f("outputPricePerMillion", "Output Price (USD / 1M tokens)", {
      kind: "number",
      required: false,
    }),
    f("releaseDate", "Released", { required: false }),
    f("addedAt", "Added to Workspace", { required: false }),
    f("lastUsedAt", "Last Used", { required: false }),
  ],
  outputs: [o("invokeUrl", "Invoke URL")],
  iconKey: "model",
  supportsDelete: false,
  supportsMetrics: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ModelResourceType,
  DeploymentResourceType,
  EnvironmentResourceType,
  ChainResourceType,
  ModelApiResourceType,
  TrainingProjectResourceType,
  TrainingJobResourceType,
  SecretResourceType,
  InstanceTypeResourceType,
];
