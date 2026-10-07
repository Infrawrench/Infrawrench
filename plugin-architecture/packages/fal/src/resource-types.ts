import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * A model endpoint this workspace has called in the last 30 days, with its
 * catalogue metadata and unit price. Built from `GET /v1/models/usage`
 * (admin key), `GET /v1/models` and `GET /v1/models/pricing`.
 */
export const FalModelType = rt({
  name: "Model",
  id: "fal-model",
  description:
    "A fal Model API endpoint used by this workspace, with its price, usage and request analytics",
  fields: [
    f("endpointId", "Endpoint ID"),
    f("displayName", "Name", { required: false }),
    f("category", "Category", { required: false }),
    f("status", "Status", { required: false }),
    f("unitPrice", "Unit Price (USD)", { kind: "number", required: false }),
    f("unit", "Billing Unit", { required: false }),
    f("quantity30d", "Units (30 days)", { kind: "number", required: false }),
    f("cost30d", "Cost (30 days, USD)", { kind: "number", required: false }),
    f("licenseType", "License", { required: false }),
    f("modelUrl", "Model Page", { required: false }),
  ],
  outputs: [o("endpointId", "Endpoint ID"), o("queueUrl", "Queue URL")],
  supportsMetrics: true,
  iconKey: "sparkles",
});

/** A fal Serverless app. `GET /v1/serverless/apps?expand=endpoints` */
export const FalAppType = rt({
  name: "Serverless App",
  id: "fal-app",
  description:
    "A Python app deployed on fal Serverless GPUs, with its queue, revisions, logs and analytics",
  fields: [
    f("endpointId", "App ID"),
    f("name", "Name", { required: false }),
    f("owner", "Owner", { required: false }),
    f("environment", "Environment", { required: false }),
    f("machineType", "Machine Type", { required: false }),
    f("authMode", "Auth Mode", { required: false }),
    f("keepAlive", "Keep Alive (s)", { kind: "number", required: false }),
    f("minConcurrency", "Min Concurrency", { kind: "number", required: false }),
    f("maxConcurrency", "Max Concurrency", { kind: "number", required: false }),
    f("requestTimeout", "Request Timeout (s)", { kind: "number", required: false }),
    f("startupTimeout", "Startup Timeout (s)", { kind: "number", required: false }),
    f("regions", "Regions", { required: false }),
    f("routes", "Routes", { required: false }),
    f("updatedAt", "Updated", { required: false }),
  ],
  outputs: [o("endpointId", "App ID"), o("queueUrl", "Queue URL")],
  supportsMetrics: true,
  iconKey: "app",
});

/** A dedicated GPU compute instance. `GET /v1/compute/instances` (admin key) */
export const FalComputeInstanceType = rt({
  name: "Compute Instance",
  id: "fal-compute-instance",
  description: "A dedicated fal Compute GPU machine (H100) reachable over SSH",
  fields: [
    f("instanceId", "Instance ID"),
    f("instanceType", "Instance Type", { required: false }),
    f("region", "Region", { required: false }),
    f("sector", "Sector", { required: false }),
    f("ip", "IP Address", { required: false }),
    f("status", "Status", { required: false }),
    f("creator", "Created By", { required: false }),
  ],
  outputs: [o("ip", "IP Address")],
  supportsDelete: true,
  iconKey: "server",
});

/** A workspace API key. `GET /v1/keys` (admin key) */
export const FalApiKeyType = rt({
  name: "API Key",
  id: "fal-api-key",
  description: "A fal API key; secrets are never returned after creation",
  fields: [
    f("keyId", "Key ID"),
    f("alias", "Alias", { required: false }),
    f("scope", "Scope", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("creator", "Created By", { required: false }),
  ],
  outputs: [o("keyId", "Key ID")],
  expiryFields: [
    { fieldKey: "createdAt", from: "created", kind: "api-token", label: "Key due for rotation" },
  ],
  credentialFormats: [
    {
      id: "replacement-key",
      label: "Create a replacement key",
      description:
        "Creates a new API-scope key with the same alias. Switch your apps over, then delete this one.",
      mediaType: "text",
      filenameTemplate: "fal-{resource}-replacement.txt",
    },
  ],
  supportsDelete: true,
  iconKey: "key",
});

/** A fal workflow. `GET /v1/workflows` */
export const FalWorkflowType = rt({
  name: "Workflow",
  id: "fal-workflow",
  description: "A fal workflow chaining model endpoints",
  fields: [
    f("name", "Name"),
    f("title", "Title", { required: false }),
    f("owner", "Owner", { required: false }),
    f("description", "Description", { required: false }),
    f("endpoints", "Endpoints", { required: false }),
    f("tags", "Tags", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("name", "Workflow")],
  iconKey: "workflow",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  FalModelType,
  FalAppType,
  FalComputeInstanceType,
  FalApiKeyType,
  FalWorkflowType,
];
