import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * A dedicated Inference Endpoint: one model on managed compute in a chosen
 * cloud vendor and region.
 *
 * `GET https://api.endpoints.huggingface.cloud/v2/endpoint/{namespace}`
 */
export const InferenceEndpointType = rt({
  name: "Inference Endpoint",
  id: "hf-inference-endpoint",
  description:
    "A dedicated Hugging Face Inference Endpoint: a model served on reserved CPU, GPU or Inferentia compute with autoscaling",
  fields: [
    f("name", "Name", { editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("repository", "Model Repository", { required: false }),
    f("revision", "Revision", {
      required: false,
      description:
        "Commit SHA or branch to serve. Leave empty to follow the latest commit on main.",
    }),
    f("task", "Task", { required: false, editable: false }),
    f("framework", "Framework", { required: false, editable: false }),
    f("vendor", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("accelerator", "Accelerator", { required: false, editable: false }),
    f("instanceType", "Instance Type", { required: false, editable: false }),
    f("instanceSize", "Instance Size", { required: false, editable: false }),
    f("minReplica", "Min Replicas", {
      kind: "number",
      required: false,
      description: "Set to 0 to let the endpoint scale to zero when idle.",
    }),
    f("maxReplica", "Max Replicas", { kind: "number", required: false }),
    f("scaleToZeroTimeout", "Scale-to-Zero Timeout (minutes)", {
      kind: "number",
      required: false,
      description:
        "Minutes of inactivity before scaling to zero. Only applies when Min Replicas is 0.",
    }),
    f("type", "Security Level", {
      kind: "enum",
      required: false,
      enumValues: ["public", "authenticated", "private"],
      description:
        "public: anyone can call it. authenticated: callers need a Hugging Face token with access to the namespace. private: reachable only over AWS PrivateLink.",
    }),
    f("tags", "Tags", { required: false, description: "Comma-separated." }),
    f("url", "URL", { required: false, editable: false }),
    f("readyReplica", "Ready Replicas", { kind: "number", required: false, editable: false }),
    f("targetReplica", "Target Replicas", { kind: "number", required: false, editable: false }),
    f("pricePerHour", "Price per Replica-Hour (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("message", "Status Message", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
  ],
  outputs: [
    o("url", "Endpoint URL"),
    o("name", "Endpoint Name"),
    o("chatCompletionsUrl", "OpenAI-Compatible Chat URL", {
      description: "`{url}/v1/chat/completions`, served by TGI, vLLM and SGLang containers.",
    }),
  ],
  dependsOn: [{ fieldKey: "repository", targetTypeId: "hf-model", label: "serves" }],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "pause",
    statusFieldKey: "state",
    runningValues: ["running", "initializing", "pending", "updating", "scaledToZero"],
    stoppedValues: ["paused"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "deployment",
});

/** A model repository owned by the account's namespace. `GET /api/models?author=` */
export const ModelRepoType = rt({
  name: "Model",
  id: "hf-model",
  description: "A model repository on the Hugging Face Hub owned by this namespace",
  fields: [
    f("repoId", "Repository", { editable: false }),
    f("visibility", "Visibility", {
      kind: "enum",
      required: false,
      enumValues: ["public", "private"],
    }),
    f("gated", "Gated Access", {
      kind: "enum",
      required: false,
      enumValues: ["off", "auto", "manual"],
      description: "Require users to request access. auto approves requests, manual waits for you.",
    }),
    f("discussionsDisabled", "Discussions Disabled", { kind: "boolean", required: false }),
    f("pipelineTag", "Task", { required: false, editable: false }),
    f("libraryName", "Library", { required: false, editable: false }),
    f("downloads", "Downloads (30 days)", { kind: "number", required: false, editable: false }),
    f("likes", "Likes", { kind: "number", required: false, editable: false }),
    f("usedStorage", "Storage (bytes)", { kind: "number", required: false, editable: false }),
    f("lastModified", "Last Modified", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("repoId", "Repository ID"), o("url", "Hub URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "cpu",
});

/** A dataset repository owned by the account's namespace. `GET /api/datasets?author=` */
export const DatasetRepoType = rt({
  name: "Dataset",
  id: "hf-dataset",
  description: "A dataset repository on the Hugging Face Hub owned by this namespace",
  fields: [
    f("repoId", "Repository", { editable: false }),
    f("visibility", "Visibility", {
      kind: "enum",
      required: false,
      enumValues: ["public", "private"],
    }),
    f("gated", "Gated Access", {
      kind: "enum",
      required: false,
      enumValues: ["off", "auto", "manual"],
      description: "Require users to request access. auto approves requests, manual waits for you.",
    }),
    f("discussionsDisabled", "Discussions Disabled", { kind: "boolean", required: false }),
    f("downloads", "Downloads (30 days)", { kind: "number", required: false, editable: false }),
    f("likes", "Likes", { kind: "number", required: false, editable: false }),
    f("usedStorage", "Storage (bytes)", { kind: "number", required: false, editable: false }),
    f("lastModified", "Last Modified", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("repoId", "Repository ID"), o("url", "Hub URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "database",
});

/** A Space owned by the account's namespace. `GET /api/spaces?author=` */
export const SpaceType = rt({
  name: "Space",
  id: "hf-space",
  description: "A Hugging Face Space: a Gradio, Docker or static app hosted on Hub hardware",
  fields: [
    f("repoId", "Space", { editable: false }),
    f("visibility", "Visibility", {
      kind: "enum",
      required: false,
      enumValues: ["public", "private", "protected"],
      description: "protected: the app is public but its code and files stay private.",
    }),
    f("discussionsDisabled", "Discussions Disabled", { kind: "boolean", required: false }),
    f("sdk", "SDK", { required: false, editable: false }),
    f("stage", "Stage", { required: false, editable: false }),
    f("hardware", "Hardware", { required: false, editable: false }),
    f("requestedHardware", "Requested Hardware", { required: false, editable: false }),
    f("sleepTimeSeconds", "Sleep Time (seconds)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("storage", "Persistent Storage", { required: false, editable: false }),
    f("subdomain", "Subdomain", { required: false, editable: false }),
    f("likes", "Likes", { kind: "number", required: false, editable: false }),
    f("lastModified", "Last Modified", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("repoId", "Space ID"),
    o("url", "Hub URL"),
    o("appUrl", "App URL", { description: "https://{subdomain}.hf.space" }),
  ],
  lifecycle: {
    startActionId: "restart",
    stopActionId: "pause",
    statusFieldKey: "stage",
    runningValues: [
      "RUNNING",
      "RUNNING_BUILDING",
      "BUILDING",
      "APP_STARTING",
      "RUNNING_APP_STARTING",
    ],
    stoppedValues: ["PAUSED", "STOPPED", "SLEEPING"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "app",
});

/** A compute job on Hugging Face Jobs. `GET /api/jobs/{namespace}` */
export const JobType = rt({
  name: "Job",
  id: "hf-job",
  description: "A containerised compute job run on Hugging Face Jobs hardware",
  fields: [
    f("jobId", "Job ID"),
    f("stage", "Stage", { required: false }),
    f("message", "Message", { required: false }),
    f("dockerImage", "Image", { required: false }),
    f("spaceId", "Space Image", { required: false }),
    f("command", "Command", { required: false }),
    f("flavor", "Hardware", { required: false }),
    f("timeoutSeconds", "Timeout (seconds)", { kind: "number", required: false }),
    f("runningSecs", "Running Time (seconds)", { kind: "number", required: false }),
    f("createdBy", "Created By", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("startedAt", "Started", { required: false }),
    f("finishedAt", "Finished", { required: false }),
  ],
  outputs: [o("jobId", "Job ID")],
  dependsOn: [{ fieldKey: "spaceId", targetTypeId: "hf-space", label: "runs image of" }],
  supportsCreate: true,
  iconKey: "terminal",
});

/** A cron-scheduled job. `GET /api/scheduled-jobs/{namespace}` */
export const ScheduledJobType = rt({
  name: "Scheduled Job",
  id: "hf-scheduled-job",
  description: "A Hugging Face Job that runs on a cron schedule",
  fields: [
    f("scheduledJobId", "Scheduled Job ID", { editable: false }),
    f("schedule", "Schedule", {
      description: "Cron expression (UTC), or @hourly, @daily, @weekly, @monthly, @yearly.",
    }),
    f("suspended", "Suspended", { kind: "boolean", required: false, editable: false }),
    f("suspendReason", "Suspend Reason", { required: false, editable: false }),
    f("concurrency", "Allow Overlapping Runs", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("dockerImage", "Image", { required: false, editable: false }),
    f("command", "Command", { required: false, editable: false }),
    f("flavor", "Hardware", { required: false, editable: false }),
    f("lastJobId", "Last Run", { required: false, editable: false }),
    f("lastRunAt", "Last Run At", { required: false, editable: false }),
    f("nextRunAt", "Next Run", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("scheduledJobId", "Scheduled Job ID")],
  dependsOn: [{ fieldKey: "lastJobId", targetTypeId: "hf-job", label: "last ran" }],
  lifecycle: {
    startActionId: "resume",
    stopActionId: "suspend",
    statusFieldKey: "suspended",
    runningValues: ["false"],
    stoppedValues: ["true"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "clock",
});

/**
 * A model served by Inference Providers, routed through
 * `https://router.huggingface.co/v1`. `GET /v1/models` on the router.
 */
export const ProviderModelType = rt({
  name: "Inference Provider Model",
  id: "hf-provider-model",
  description:
    "A model available through Hugging Face Inference Providers, with each partner provider's price, context length and latency",
  fields: [
    f("modelId", "Model ID"),
    f("ownedBy", "Owned By", { required: false }),
    f("inputModalities", "Input", { required: false }),
    f("outputModalities", "Output", { required: false }),
    f("providers", "Providers", { required: false }),
    f("providerCount", "Provider Count", { kind: "number", required: false }),
    f("cheapestInput", "Cheapest Input (USD / 1M tokens)", { kind: "number", required: false }),
    f("cheapestOutput", "Cheapest Output (USD / 1M tokens)", { kind: "number", required: false }),
    f("maxContextLength", "Max Context Length", { kind: "number", required: false }),
  ],
  outputs: [o("modelId", "Model ID"), o("baseUrl", "OpenAI-Compatible Base URL")],
  pinnable: true,
  iconKey: "sparkles",
});

/**
 * An organization service account (Team and Enterprise plans).
 * `GET /api/organizations/{name}/service-accounts`
 */
export const ServiceAccountType = rt({
  name: "Service Account",
  id: "hf-service-account",
  description:
    "A non-human organization member whose access tokens are not tied to any person (Team and Enterprise)",
  fields: [
    f("serviceAccountId", "ID"),
    f("name", "Name"),
    f("username", "Username", { required: false }),
    f("description", "Description", { required: false }),
    f("email", "Email", { required: false }),
    f("tokenCount", "Tokens", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("username", "Username")],
  credentialFormats: [
    {
      id: "read-token",
      label: "New read token",
      description: "Read access to the organization's repositories (org.read, repo.content.read).",
      mediaType: "text",
      filenameTemplate: "{resource}-read-token.txt",
    },
    {
      id: "write-token",
      label: "New write token",
      description:
        "Read and write access to the organization's repositories (org.read, repo.write).",
      mediaType: "text",
      filenameTemplate: "{resource}-write-token.txt",
    },
    {
      id: "inference-token",
      label: "New inference token",
      description:
        "Calls Inference Providers and the organization's Inference Endpoints, nothing else.",
      mediaType: "text",
      filenameTemplate: "{resource}-inference-token.txt",
    },
  ],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "user",
});

/**
 * An access token held by a member of the organization (Team and
 * Enterprise). `GET /api/organizations/{name}/settings/tokens`
 */
export const MemberTokenType = rt({
  name: "Member Access Token",
  id: "hf-member-token",
  description:
    "An organization member's access token as the organization sees it: role, last use and approval state (Team and Enterprise)",
  fields: [
    f("tokenId", "Token ID"),
    f("displayName", "Name", { required: false }),
    f("owner", "Owner", { required: false }),
    f("role", "Role", { required: false }),
    f("last4", "Ends With", { required: false }),
    f("status", "Approval", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("lastUsedAt", "Last Used", { required: false }),
  ],
  outputs: [],
  expiryFields: [
    { fieldKey: "createdAt", from: "created", kind: "api-token", label: "Token due for rotation" },
  ],
  iconKey: "key",
});

/** A Hub webhook belonging to the token's user. `GET /api/settings/webhooks` */
export const WebhookType = rt({
  name: "Webhook",
  id: "hf-webhook",
  description: "A Hub webhook that posts repository and discussion events to a URL or starts a Job",
  fields: [
    f("webhookId", "Webhook ID"),
    f("url", "Target", { required: false }),
    f("watched", "Watching", { required: false }),
    f("domains", "Events", { required: false }),
    f("disabled", "Disabled", { required: false }),
    f("hasSecret", "Signed", { kind: "boolean", required: false }),
    f("lastTriggerAt", "Last Triggered", { required: false }),
  ],
  outputs: [o("webhookId", "Webhook ID")],
  supportsDelete: true,
  iconKey: "webhook",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  InferenceEndpointType,
  ModelRepoType,
  DatasetRepoType,
  SpaceType,
  JobType,
  ScheduledJobType,
  ProviderModelType,
  ServiceAccountType,
  MemberTokenType,
  WebhookType,
];
