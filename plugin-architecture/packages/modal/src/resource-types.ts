import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Modal resource types. Each names the RPC it lists from; field layouts are
 * in `api.ts`. Everything environment-scoped is listed across every
 * environment the token can see and carries an `environment` field.
 */

/** `WorkspaceNameLookup` + `WorkspaceBillingSummary` + `WorkspaceBillingRates`. */
export const WorkspaceResourceType = rt({
  name: "Workspace",
  id: "workspace",
  description:
    "The Modal workspace the token belongs to. Shows this month's metered and billed cost with the credits and other adjustments between them, cost by product, the workspace rate card, and charts cost per day by resource type and GPU hours.",
  fields: [
    f("name", "Name", { editable: false }),
    f("environmentCount", "Environments", { kind: "number", required: false, editable: false }),
    f("monthMetered", "Metered This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("monthBilled", "Billed This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("name", "Workspace Name"), o("url", "Modal Dashboard URL")],
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "organization",
});

/** `EnvironmentList`; created, edited and deleted through `EnvironmentCreate/Update/Delete`. */
export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "environment",
  description:
    "A Modal environment: an isolated set of apps, secrets, volumes, dicts and queues. Create, rename or delete one, set its concurrency limits and web endpoint suffix, and see its spend this cycle against its budget and its cost per day.",
  fields: [
    f("name", "Name", {
      description: "Letters, numbers, dashes and underscores. Apps address the environment by it.",
    }),
    f("webhookSuffix", "Web Endpoint Suffix", {
      required: false,
      description:
        "Added to the URLs of this environment's web endpoints so they do not collide with another environment's.",
    }),
    f("maxConcurrentTasks", "Max Concurrent Containers", {
      kind: "number",
      required: false,
      description: "Cap on containers running at once in this environment. Leave empty for no cap.",
    }),
    f("maxConcurrentGpus", "Max Concurrent GPUs", {
      kind: "number",
      required: false,
      description: "Cap on GPUs in use at once in this environment. Leave empty for no cap.",
    }),
    f("isDefault", "Default", { kind: "boolean", required: false, editable: false }),
    f("currentConcurrentTasks", "Running Containers", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("currentConcurrentGpus", "GPUs In Use", { kind: "number", required: false, editable: false }),
    f("cycleUsage", "Spend This Cycle (USD)", { kind: "number", required: false, editable: false }),
    f("spendLimit", "Spend Limit (USD)", { kind: "number", required: false, editable: false }),
    f("cycleBudget", "Budget (USD)", { kind: "number", required: false, editable: false }),
    f("spendLimitReached", "Spend Limit Reached", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
  ],
  outputs: [o("name", "Environment Name"), o("environmentId", "Environment ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "env",
});

/** `AppList` per environment, `AppGetInfo` / `AppGetTags` / `AppDeploymentHistory` on detail. */
export const AppResourceType = rt({
  name: "App",
  id: "app",
  description:
    "A Modal app: deployed, ephemeral or stopped. Shows its functions and servers with their GPUs and schedules, its tags and deployment history, and charts its cost per day by resource type. Stop a running app from its detail page.",
  fields: [
    f("name", "Name", { editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("runningTasks", "Running Containers", { kind: "number", required: false, editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("deployedAt", "Deployed", { required: false, editable: false }),
    f("deployedBy", "Deployed By", { required: false, editable: false }),
    f("stoppedAt", "Stopped", { required: false, editable: false }),
    f("stoppedBy", "Stopped By", { required: false, editable: false }),
    f("appId", "App ID", { required: false, editable: false }),
  ],
  outputs: [o("appId", "App ID"), o("url", "Modal Dashboard URL")],
  dependsOn: [
    { fieldKey: "environment", targetTypeId: "environment", targetKey: "name", label: "runs in" },
  ],
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "app",
});

/** Functions and servers of deployed apps (`AppGetInfo`), `FunctionGetById` on detail. */
export const FunctionResourceType = rt({
  name: "Function",
  id: "function",
  description:
    "A function, class or server of a deployed Modal app. Shows its GPU, CPU and memory, autoscaling (min, max and buffer containers, scale-down window), input concurrency, timeouts and schedule, its live backlog and running inputs, and charts inputs by outcome, cold starts, latency and container utilization.",
  fields: [
    f("name", "Name", { editable: false }),
    f("app", "App", { required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("kind", "Kind", { required: false, editable: false }),
    f("gpu", "GPU", { required: false, editable: false }),
    f("schedule", "Schedule", { required: false, editable: false }),
    f("webEndpoint", "Web Endpoint", { kind: "boolean", required: false, editable: false }),
    f("appId", "App ID", { required: false, editable: false }),
    f("functionId", "Function ID", { required: false, editable: false }),
  ],
  outputs: [
    o("functionId", "Function ID"),
    o("webUrl", "Web URL"),
    o("url", "Modal Dashboard URL"),
  ],
  dependsOn: [{ fieldKey: "appId", targetTypeId: "app", label: "belongs to" }],
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "function",
});

/** The scheduled subset of `function`: those whose definition carries a cron or period. */
export const ScheduledFunctionResourceType = rt({
  name: "Scheduled Function",
  id: "scheduled-function",
  description:
    "A function of a deployed Modal app that runs on a cron or fixed-period schedule, with its schedule, GPU and app, and the same invocation charts as any function.",
  fields: [
    f("name", "Name", { editable: false }),
    f("schedule", "Schedule", { required: false, editable: false }),
    f("app", "App", { required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("gpu", "GPU", { required: false, editable: false }),
    f("appId", "App ID", { required: false, editable: false }),
    f("functionId", "Function ID", { required: false, editable: false }),
  ],
  outputs: [o("functionId", "Function ID"), o("url", "Modal Dashboard URL")],
  dependsOn: [{ fieldKey: "appId", targetTypeId: "app", label: "belongs to" }],
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "job",
});

/** `VolumeList` per environment; `VolumeDelete`. */
export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description:
    "A Modal volume: a persistent, distributed file system apps mount. Shows its version and who created it. Deleting a volume deletes every file in it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("volumeId", "Volume ID", { required: false, editable: false }),
  ],
  outputs: [o("name", "Volume Name"), o("volumeId", "Volume ID")],
  supportsDelete: true,
  iconKey: "volume",
});

/** `SecretList` per environment; `SecretDelete`. Names and key names only, never values. */
export const SecretResourceType = rt({
  name: "Secret",
  id: "secret",
  description:
    "A Modal secret: a named set of environment variables functions read at run time. Lists its key names and when it was last used; values are never read.",
  fields: [
    f("name", "Name", { editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("keys", "Keys", { required: false, editable: false }),
    f("keyCount", "Key Count", { kind: "number", required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("secretId", "Secret ID", { required: false, editable: false }),
  ],
  outputs: [o("name", "Secret Name"), o("secretId", "Secret ID")],
  supportsDelete: true,
  iconKey: "secret",
});

/** `DictList` per environment; `DictDelete`. */
export const DictResourceType = rt({
  name: "Dict",
  id: "dict",
  description: "A named Modal dict: a distributed key-value store shared between functions.",
  fields: [
    f("name", "Name", { editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("dictId", "Dict ID", { required: false, editable: false }),
  ],
  outputs: [o("name", "Dict Name"), o("dictId", "Dict ID")],
  supportsDelete: true,
  iconKey: "dictionary",
});

/** `QueueList` per environment; `QueueDelete`. */
export const QueueResourceType = rt({
  name: "Queue",
  id: "queue",
  description:
    "A named Modal queue: a distributed FIFO shared between functions, with its partition count and the number of items waiting.",
  fields: [
    f("name", "Name", { editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("partitions", "Partitions", { kind: "number", required: false, editable: false }),
    f("totalSize", "Items", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("queueId", "Queue ID", { required: false, editable: false }),
  ],
  outputs: [o("name", "Queue Name"), o("queueId", "Queue ID")],
  supportsDelete: true,
  iconKey: "queue",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  WorkspaceResourceType,
  EnvironmentResourceType,
  AppResourceType,
  FunctionResourceType,
  ScheduledFunctionResourceType,
  VolumeResourceType,
  SecretResourceType,
  DictResourceType,
  QueueResourceType,
];
