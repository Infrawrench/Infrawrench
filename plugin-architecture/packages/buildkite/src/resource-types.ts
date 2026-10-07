import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Buildkite resource types. Everything is scoped to the organization picked
 * in the credentials. Field names follow the REST API reference
 * (https://buildkite.com/docs/apis/rest-api, 2026-10).
 */

const ro = { required: false, editable: false } as const;
const num = { kind: "number", required: false, editable: false } as const;
const bool = { kind: "boolean", required: false, editable: false } as const;

/** Hosted agent instance shapes (Queues API "Instance shape values"). */
export const INSTANCE_SHAPES = [
  "LINUX_AMD64_2X4",
  "LINUX_AMD64_4X16",
  "LINUX_AMD64_8X32",
  "LINUX_AMD64_16X64",
  "LINUX_AMD64_32X128",
  "LINUX_AMD64_64X256",
  "LINUX_ARM64_2X4",
  "LINUX_ARM64_4X16",
  "LINUX_ARM64_8X32",
  "LINUX_ARM64_16X64",
  "LINUX_ARM64_32X128",
  "LINUX_ARM64_64X256",
  "MACOS_ARM64_M4_6X28",
  "MACOS_ARM64_M4_12X56",
  "WINDOWS_AMD64_2X8",
  "WINDOWS_AMD64_4X16",
  "WINDOWS_AMD64_8X32",
  "WINDOWS_AMD64_16X64",
];

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  accountRoot: true,
  description:
    "The Buildkite organization this connection manages: monthly active users, pipelines, connected agents, running and waiting work, and the API rate limit. Charts builds, failures, build duration and the time jobs wait for an agent across every pipeline.",
  fields: [
    f("name", "Name", ro),
    f("slug", "Slug", ro),
    f("activeUsers", "Monthly Active Users", num),
    f("pipelineCount", "Pipelines", num),
    f("agentCount", "Connected Agents", num),
    f("busyAgents", "Busy Agents", num),
    f("clusterCount", "Clusters", num),
    f("runningBuilds", "Running Builds", num),
    f("scheduledBuilds", "Scheduled Builds", num),
    f("waitingJobs", "Jobs Waiting for Agents", num),
    f("rateLimit", "REST Requests per Minute", num),
    f("rateLimitUsed", "REST Requests This Minute", num),
    f("organizationId", "Organization ID", ro),
    f("graphqlId", "GraphQL ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [
    o("slug", "Organization slug"),
    o("organizationId", "Organization ID"),
    o("graphqlId", "Organization GraphQL ID"),
    o("url", "Buildkite URL"),
  ],
  supportsMetrics: true,
  iconKey: "account",
});

export const PipelineResourceType = rt({
  name: "Pipeline",
  id: "pipeline",
  description:
    "A pipeline: its repository, cluster, branch rules and YAML steps (edit them in the Steps tab), what is running or waiting right now, its recent builds, and its schedules. Create, edit, archive, unarchive or delete a pipeline, start a build, or move it to another cluster. Charts builds, failures, duration and agent wait time.",
  fields: [
    f("name", "Name", {
      description: "Renaming a pipeline also changes its slug and URL.",
    }),
    f("description", "Description", { required: false }),
    f("repository", "Repository", {
      description: "Clone URL, e.g. git@github.com:acme/app.git.",
    }),
    f("defaultBranch", "Default Branch", { required: false }),
    f("branchConfiguration", "Branch Filter", {
      required: false,
      description: "Only build pushes to matching branches, e.g. main release/*. Empty builds all.",
    }),
    f("skipQueuedBranchBuilds", "Skip Queued Builds on the Same Branch", {
      kind: "boolean",
      required: false,
    }),
    f("skipQueuedBranchBuildsFilter", "Skip Queued Builds Filter", {
      required: false,
      description: "Branch filter for skipping, e.g. !main.",
    }),
    f("cancelRunningBranchBuilds", "Cancel Running Builds on the Same Branch", {
      kind: "boolean",
      required: false,
    }),
    f("cancelRunningBranchBuildsFilter", "Cancel Running Builds Filter", { required: false }),
    f("allowRebuilds", "Allow Rebuilds", { kind: "boolean", required: false }),
    f("visibility", "Visibility", {
      kind: "enum",
      enumValues: ["private", "public"],
      required: false,
      description: "Public pipelines show builds and logs to anyone with the link.",
    }),
    f("defaultTimeoutMinutes", "Default Step Timeout (minutes)", {
      kind: "number",
      required: false,
    }),
    f("maximumTimeoutMinutes", "Maximum Step Timeout (minutes)", {
      kind: "number",
      required: false,
    }),
    f("tags", "Tags", { required: false, description: "Comma-separated." }),
    f("clusterName", "Cluster", ro),
    f("clusterId", "Cluster ID", ro),
    f("clusterGraphqlId", "Cluster GraphQL ID", ro),
    f("pipelineTemplateUuid", "Pipeline Template", ro),
    f("provider", "Source Provider", ro),
    f("archived", "Archived", bool),
    f("runningBuilds", "Running Builds", num),
    f("scheduledBuilds", "Scheduled Builds", num),
    f("runningJobs", "Running Jobs", num),
    f("waitingJobs", "Jobs Waiting for Agents", num),
    f("yamlSteps", "YAML Steps", bool),
    f("configuration", "Steps (YAML)", ro),
    f("slug", "Slug", ro),
    f("pipelineId", "Pipeline ID", ro),
    f("graphqlId", "GraphQL ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [
    o("slug", "Pipeline slug"),
    o("url", "Buildkite URL"),
    o("badgeUrl", "Build status badge URL"),
    o("webhookUrl", "Webhook URL", {
      sensitive: true,
      description: "Anyone with this URL can start builds. Needs a token with write_pipelines.",
    }),
    o("pipelineId", "Pipeline ID"),
    o("graphqlId", "Pipeline GraphQL ID"),
  ],
  dependsOn: [
    { fieldKey: "clusterId", targetTypeId: "cluster", label: "runs in" },
    { fieldKey: "pipelineTemplateUuid", targetTypeId: "pipeline-template", label: "uses" },
  ],
  postureChecks: [
    {
      id: "pipeline-public",
      title: "Pipeline is public",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "visibility", when: "equals", value: "public" }],
      reason:
        "Anyone with the link can see this pipeline's builds, logs and artifacts. Make it private unless it is an open-source project.",
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "archived", when: "equals", value: "true" }],
    reason:
      "Archived pipeline: it can no longer run builds. Delete it if its history is not needed.",
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "workflow",
});

export const BuildResourceType = rt({
  name: "Build",
  id: "build",
  parentTypeId: "pipeline",
  showInSidebar: true,
  description:
    "A build of a pipeline: state, branch, commit, who started it, how long it ran and waited, its jobs (with Retry, Unblock and logs), annotations and artifacts. Cancel, rebuild or retry failed jobs. The 50 most recent builds in the organization are listed; create one to start a build.",
  fields: [
    f("number", "Number", num),
    f("pipelineName", "Pipeline", ro),
    f("pipelineSlug", "Pipeline Slug", ro),
    f("state", "State", ro),
    f("branch", "Branch", ro),
    f("commit", "Commit", ro),
    f("message", "Message", ro),
    f("source", "Source", ro),
    f("creator", "Created By", ro),
    f("blocked", "Blocked", bool),
    f("cancelReason", "Cancel Reason", ro),
    f("pullRequest", "Pull Request", ro),
    f("rebuiltFrom", "Rebuilt From", num),
    f("jobCount", "Jobs", num),
    f("failedJobs", "Failed Jobs", num),
    f("durationSecs", "Duration (seconds)", num),
    f("waitSecs", "Longest Agent Wait (seconds)", num),
    f("createdAt", "Created", ro),
    f("startedAt", "Started", ro),
    f("finishedAt", "Finished", ro),
    f("buildId", "Build ID", ro),
  ],
  outputs: [o("url", "Buildkite URL"), o("buildId", "Build ID"), o("number", "Build number")],
  dependsOn: [{ fieldKey: "pipelineSlug", targetTypeId: "pipeline", label: "build of" }],
  supportsCreate: true,
  supportsDelete: false,
  iconKey: "play",
  pinnable: false,
});

export const JobResourceType = rt({
  name: "Job",
  id: "job",
  parentTypeId: "build",
  description:
    "A job in a build: its command, state, exit status, agent and how long it waited for one. The Logs tab tails its output. Retry a failed job, unblock a block step, or change a waiting job's priority.",
  fields: [
    f("name", "Name", ro),
    f("type", "Type", ro),
    f("state", "State", ro),
    f("pipelineSlug", "Pipeline", ro),
    f("buildNumber", "Build", num),
    f("stepKey", "Step Key", ro),
    f("command", "Command", ro),
    f("exitStatus", "Exit Status", num),
    f("softFailed", "Soft Failed", bool),
    f("agentName", "Agent", ro),
    f("agentId", "Agent ID", ro),
    f("agentQueryRules", "Agent Targeting", ro),
    f("queueId", "Queue ID", ro),
    f("retried", "Retried", bool),
    f("retriesCount", "Retries", num),
    f("priority", "Priority", num),
    f("waitSecs", "Waited for Agent (seconds)", num),
    f("durationSecs", "Duration (seconds)", num),
    f("startedAt", "Started", ro),
    f("finishedAt", "Finished", ro),
    f("jobId", "Job ID", ro),
  ],
  outputs: [o("url", "Buildkite URL"), o("jobId", "Job ID")],
  dependsOn: [{ fieldKey: "agentId", targetTypeId: "agent", label: "ran on" }],
  iconKey: "terminal",
  pinnable: false,
});

export const AgentResourceType = rt({
  name: "Agent",
  id: "agent",
  description:
    "A connected Buildkite agent: host, version, platform, queue and tags, and the job it is running. Stop it (after its current job, or at once), pause it so it takes no new jobs, or resume it.",
  fields: [
    f("name", "Name", ro),
    f("connectionState", "Connection", ro),
    f("busy", "Running a Job", bool),
    f("currentJob", "Current Job", ro),
    f("hostname", "Hostname", ro),
    f("ipAddress", "IP Address", ro),
    f("version", "Agent Version", ro),
    f("os", "OS", ro),
    f("arch", "Architecture", ro),
    f("queue", "Queue", ro),
    f("queueRef", "Queue Reference", ro),
    f("clusterId", "Cluster ID", ro),
    f("priority", "Priority", num),
    f("tags", "Tags", ro),
    f("connectedAt", "Connected", ro),
    f("lastJobFinishedAt", "Last Job Finished", ro),
    f("agentId", "Agent ID", ro),
  ],
  outputs: [o("url", "Buildkite URL"), o("hostname", "Hostname"), o("ipAddress", "IP address")],
  dependsOn: [
    { fieldKey: "queueRef", targetTypeId: "queue", label: "serves" },
    { fieldKey: "clusterId", targetTypeId: "cluster", label: "in" },
  ],
  iconKey: "server",
  pinnable: false,
});

export const ClusterResourceType = rt({
  name: "Cluster",
  id: "cluster",
  description:
    "A cluster: an isolated group of queues, agents, agent tokens and secrets. Create, edit (name, description, emoji, color, hosted-agent caches) or delete it, choose its default queue, and mint an agent token with Get credentials.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("emoji", "Emoji", { required: false, description: "Emoji syntax, e.g. :rocket:." }),
    f("color", "Color", { required: false, description: "Hex color, e.g. #14CC80." }),
    f("hostedGitMirror", "Hosted Agent Git Mirror", {
      kind: "boolean",
      required: false,
      description: "Only applies to clusters running Buildkite hosted agents.",
    }),
    f("hostedContainerCache", "Hosted Agent Container Cache", {
      kind: "boolean",
      required: false,
      description: "Only applies to clusters running Buildkite hosted agents.",
    }),
    f("defaultQueue", "Default Queue", ro),
    f("defaultQueueId", "Default Queue ID", ro),
    f("queueCount", "Queues", num),
    f("agentCount", "Connected Agents", num),
    f("clusterId", "Cluster ID", ro),
    f("graphqlId", "GraphQL ID", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [
    o("clusterId", "Cluster ID"),
    o("graphqlId", "Cluster GraphQL ID"),
    o("url", "Buildkite URL"),
  ],
  credentialFormats: [
    {
      id: "agent-token",
      label: "Agent token",
      description:
        "A new agent token for this cluster, for registering agents (BUILDKITE_AGENT_TOKEN).",
      mediaType: "text",
      filenameTemplate: "buildkite-agent-token.txt",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "cluster",
});

export const QueueResourceType = rt({
  name: "Queue",
  id: "queue",
  parentTypeId: "cluster",
  showInSidebar: true,
  description:
    "A queue in a cluster, self-hosted or running Buildkite hosted agents, with its connected agents and whether dispatch is paused. Create one (pick an instance shape for hosted agents), edit its description, retry affinity or instance shape, pause or resume dispatch, make it the cluster's default, or delete it.",
  fields: [
    f("key", "Key", { editable: false }),
    f("description", "Description", { required: false }),
    f("retryAgentAffinity", "Retry Agent Affinity", {
      kind: "enum",
      enumValues: ["prefer-warmest", "prefer-different"],
      required: false,
      description: "Which agent picks up a retried job.",
    }),
    f("instanceShape", "Instance Shape", {
      kind: "enum",
      enumValues: INSTANCE_SHAPES,
      required: false,
      description: "Hosted queues only: the machine every job in this queue runs on.",
    }),
    f("hosted", "Buildkite Hosted", bool),
    f("vcpus", "vCPUs", num),
    f("memoryGb", "Memory (GB)", num),
    f("dispatchPaused", "Dispatch Paused", bool),
    f("pausedNote", "Pause Note", ro),
    f("pausedAt", "Paused", ro),
    f("agentCount", "Connected Agents", num),
    f("clusterName", "Cluster", ro),
    f("clusterId", "Cluster ID", ro),
    f("clusterGraphqlId", "Cluster GraphQL ID", ro),
    f("queueId", "Queue ID", ro),
    f("graphqlId", "GraphQL ID", ro),
  ],
  outputs: [o("key", "Queue key"), o("queueId", "Queue ID"), o("url", "Buildkite URL")],
  lifecycle: {
    startActionId: "resume-dispatch",
    stopActionId: "pause-dispatch",
    statusFieldKey: "dispatchPaused",
    runningValues: ["false"],
    stoppedValues: ["true"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "queue",
});

export const AgentTokenResourceType = rt({
  name: "Agent Token",
  id: "agent-token",
  parentTypeId: "cluster",
  showInSidebar: true,
  description:
    "An agent registration token for a cluster: its description, allowed IP ranges and expiry. Create one (its value is shown once and kept as the token output), edit the description or IP ranges, or revoke it.",
  fields: [
    f("description", "Description"),
    f("allowedIpAddresses", "Allowed IP Ranges", {
      required: false,
      description: "Space-separated IPv4 CIDRs agents must connect from. Empty allows any.",
    }),
    f("expiresAt", "Expires", ro),
    f("createdBy", "Created By", ro),
    f("createdAt", "Created", ro),
    f("clusterName", "Cluster", ro),
    f("clusterId", "Cluster ID", ro),
    f("tokenId", "Token ID", ro),
  ],
  outputs: [
    o("token", "Agent token", {
      sensitive: true,
      description:
        "BUILDKITE_AGENT_TOKEN. Buildkite only returns it at creation, so it is only available for tokens created from Infrawrench.",
    }),
    o("tokenId", "Token ID"),
  ],
  secretExportTemplates: [
    {
      id: "agent-env",
      displayName: "Agent environment",
      description: "The registration token a Buildkite agent reads from its environment.",
      entries: [{ envKey: "BUILDKITE_AGENT_TOKEN", outputKey: "token" }],
    },
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Agent token expires" },
  ],
  postureChecks: [
    {
      id: "agent-token-any-ip",
      title: "Agent token accepts any IP address",
      severity: "low",
      category: "other",
      conditions: [
        { fieldKey: "allowedIpAddresses", when: "empty" },
        { fieldKey: "expiresAt", when: "empty" },
      ],
      reason:
        "This token never expires and agents may register with it from anywhere. Restrict it to your agents' IP ranges or rotate it with an expiry.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
  pinnable: false,
});

export const ClusterSecretResourceType = rt({
  name: "Cluster Secret",
  id: "cluster-secret",
  parentTypeId: "cluster",
  showInSidebar: true,
  description:
    "A Buildkite secret: an encrypted value agents in the cluster read with `buildkite-agent secret get`, guarded by an access policy. The value is write-only. Create one, edit its description, policy or value, or delete it.",
  fields: [
    f("key", "Key", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "Write-only, under 8 KB. Leave empty to keep the current value.",
    }),
    f("description", "Description", { required: false }),
    f("policy", "Access Policy (YAML)", {
      required: false,
      description: "Which pipelines and branches may read it, e.g. - pipeline_slug: deploy",
    }),
    f("lastReadAt", "Last Read by a Build", ro),
    f("updatedAt", "Updated", ro),
    f("createdAt", "Created", ro),
    f("clusterName", "Cluster", ro),
    f("clusterId", "Cluster ID", ro),
    f("secretId", "Secret ID", ro),
  ],
  outputs: [o("key", "Secret key")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
  pinnable: false,
});

export const ScheduleResourceType = rt({
  name: "Schedule",
  id: "schedule",
  parentTypeId: "pipeline",
  showInSidebar: true,
  description:
    "A scheduled build of a pipeline: when it runs (cron syntax or @hourly/@daily), on which branch and commit, with which message and environment, when it runs next and whether its last attempt failed. Create, edit, enable, disable or delete it.",
  fields: [
    f("label", "Label"),
    f("cronline", "Schedule", {
      description:
        "Cron syntax in UTC (0 2 * * 1-5), a time zone suffix (0 2 * * * Europe/Berlin), or @hourly, @daily, @weekly, @monthly.",
    }),
    f("branch", "Branch", { required: false }),
    f("commit", "Commit", { required: false, description: "Defaults to HEAD." }),
    f("message", "Build Message", { required: false }),
    f("env", "Environment", {
      required: false,
      description: "One KEY=value per line.",
    }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("nextBuildAt", "Next Build", ro),
    f("failedMessage", "Last Failure", ro),
    f("failedAt", "Last Failed", ro),
    f("pipelineSlug", "Pipeline", ro),
    f("pipelineGraphqlId", "Pipeline GraphQL ID", ro),
    f("scheduleId", "Schedule ID", ro),
    f("graphqlId", "GraphQL ID", ro),
  ],
  outputs: [o("scheduleId", "Schedule ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "clock",
  pinnable: false,
});

export const PipelineTemplateResourceType = rt({
  name: "Pipeline Template",
  id: "pipeline-template",
  description:
    "A pipeline template (Enterprise plan): a shared YAML step configuration pipelines can be pinned to. Edit its name, description and availability, edit its steps in the Steps tab, create or delete one.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("available", "Available to Non-Admins", { kind: "boolean", required: false }),
    f("stepCount", "Steps", num),
    f("configuration", "Steps (YAML)", ro),
    f("updatedAt", "Updated", ro),
    f("templateUuid", "Template UUID", ro),
    f("graphqlId", "GraphQL ID", ro),
  ],
  outputs: [o("templateUuid", "Template UUID"), o("url", "Buildkite URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "template",
});

export const TestSuiteResourceType = rt({
  name: "Test Suite",
  id: "test-suite",
  description:
    "A Test Engine suite: its default branch, and its flaky tests with reliability, failures and duration, which you can mute, skip or re-enable. Create, edit or delete a suite. The suite API token is an output other resources can use.",
  fields: [
    f("name", "Name"),
    f("defaultBranch", "Default Branch"),
    f("applicationName", "Application Name", { required: false }),
    f("emoji", "Emoji", { required: false }),
    f("color", "Color", { required: false }),
    f("flakyTests", "Flaky Tests", num),
    f("slug", "Slug", ro),
    f("suiteId", "Suite ID", ro),
    f("graphqlId", "GraphQL ID", ro),
  ],
  outputs: [
    o("apiToken", "Suite API token", {
      sensitive: true,
      description: "BUILDKITE_ANALYTICS_TOKEN for test collectors.",
    }),
    o("slug", "Suite slug"),
    o("url", "Buildkite URL"),
  ],
  secretExportTemplates: [
    {
      id: "collector-env",
      displayName: "Test collector environment",
      entries: [{ envKey: "BUILDKITE_ANALYTICS_TOKEN", outputKey: "apiToken" }],
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "test",
});

export const TestResourceType = rt({
  name: "Flaky Test",
  id: "test",
  parentTypeId: "test-suite",
  showInSidebar: true,
  description:
    "A test Test Engine labels flaky: reliability, executions, failures and duration over the suite's default window, and whether it is enabled, muted or skipped. Mute, skip or re-enable it (Pro and Enterprise plans, with test state management on).",
  fields: [
    f("name", "Name", ro),
    f("scope", "Scope", ro),
    f("location", "Location", ro),
    f("state", "State", ro),
    f("labels", "Labels", ro),
    f("reliability", "Reliability (%)", num),
    f("executions", "Executions", num),
    f("failed", "Failed", num),
    f("passed", "Passed", num),
    f("durationAvgSecs", "Average Duration (seconds)", num),
    f("durationMaxSecs", "Longest Duration (seconds)", num),
    f("suiteSlug", "Suite", ro),
    f("testId", "Test ID", ro),
  ],
  outputs: [o("url", "Buildkite URL"), o("testId", "Test ID")],
  iconKey: "test",
  pinnable: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  PipelineResourceType,
  BuildResourceType,
  JobResourceType,
  AgentResourceType,
  ClusterResourceType,
  QueueResourceType,
  AgentTokenResourceType,
  ClusterSecretResourceType,
  ScheduleResourceType,
  PipelineTemplateResourceType,
  TestSuiteResourceType,
  TestResourceType,
];
