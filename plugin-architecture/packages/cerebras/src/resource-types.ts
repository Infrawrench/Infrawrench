import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * A model the key can call. `GET /v1/models`, joined with the public
 * catalogue (`GET /public/v1/models`) for price, limits and capabilities.
 */
export const CerebrasModelType = rt({
  name: "Model",
  id: "cerebras-model",
  description:
    "A model served by Cerebras Inference, with price per million tokens, context and capabilities",
  fields: [
    f("modelId", "Model ID"),
    f("name", "Name", { required: false }),
    f("ownedBy", "Owned By", { required: false }),
    f("description", "Description", { required: false }),
    f("huggingFaceId", "Hugging Face ID", { required: false }),
    f("inputPricePerMillion", "Input (USD / 1M tokens)", { kind: "number", required: false }),
    f("outputPricePerMillion", "Output (USD / 1M tokens)", { kind: "number", required: false }),
    f("contextLength", "Context Length", { kind: "number", required: false }),
    f("maxCompletionTokens", "Max Completion Tokens", { kind: "number", required: false }),
    f("capabilities", "Capabilities", { required: false }),
    f("quantization", "Quantization", { required: false }),
    f("preview", "Preview", { kind: "boolean", required: false }),
    f("deprecated", "Deprecated", { kind: "boolean", required: false }),
    f("created", "Created", { required: false }),
  ],
  outputs: [o("modelId", "Model ID"), o("baseUrl", "OpenAI-Compatible Base URL")],
  iconKey: "cpu",
});

/** An asynchronous batch job (Private Preview). `GET /v1/batches` */
export const CerebrasBatchType = rt({
  name: "Batch",
  id: "cerebras-batch",
  plural: "Batches",
  description:
    "An asynchronous batch of chat completions processed within 24 hours (Private Preview)",
  fields: [
    f("batchId", "Batch ID"),
    f("status", "Status", { required: false }),
    f("endpoint", "Endpoint", { required: false }),
    f("completionWindow", "Completion Window", { required: false }),
    f("inputFileId", "Input File", { required: false }),
    f("outputFileId", "Output File", { required: false }),
    f("errorFileId", "Error File", { required: false }),
    f("totalRequests", "Total Requests", { kind: "number", required: false }),
    f("completedRequests", "Completed Requests", { kind: "number", required: false }),
    f("failedRequests", "Failed Requests", { kind: "number", required: false }),
    f("errors", "Errors", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("completedAt", "Completed", { required: false }),
  ],
  outputs: [o("batchId", "Batch ID"), o("outputFileId", "Output File ID")],
  dependsOn: [
    { fieldKey: "inputFileId", targetTypeId: "cerebras-file", label: "reads" },
    { fieldKey: "outputFileId", targetTypeId: "cerebras-file", label: "writes" },
    { fieldKey: "errorFileId", targetTypeId: "cerebras-file", label: "errors to" },
  ],
  supportsCreate: true,
  iconKey: "layers",
});

/** An uploaded file (Private Preview). `GET /v1/files` */
export const CerebrasFileType = rt({
  name: "File",
  id: "cerebras-file",
  description: "A file uploaded for batch processing; files expire automatically (Private Preview)",
  fields: [
    f("fileId", "File ID"),
    f("filename", "Filename", { required: false }),
    f("purpose", "Purpose", { required: false }),
    f("bytes", "Size (bytes)", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("expiresAt", "Expires", { required: false }),
  ],
  outputs: [o("fileId", "File ID")],
  supportsDelete: true,
  iconKey: "file",
});

/**
 * A Dedicated Inference endpoint (Private Preview).
 * `GET /management/v1/orgs/{org}/endpoints`
 */
export const CerebrasEndpointType = rt({
  name: "Dedicated Endpoint",
  id: "cerebras-endpoint",
  description:
    "A stable Dedicated Inference target on capacity reserved for your organization, serving a deployed model version",
  fields: [
    f("endpointId", "Endpoint ID"),
    f("modelArchitecture", "Architecture", { required: false }),
    f("deployedModel", "Deployed Version", { required: false }),
    f("deployedAlias", "Version Alias", { required: false }),
    f("deployedVersionKey", "Version Key", { required: false }),
    f("deploymentState", "Deployment State", { required: false }),
    f("orgName", "Organization", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("updatedAt", "Updated", { required: false }),
  ],
  outputs: [
    o("endpointId", "Endpoint ID", { description: "Pass as `model` on chat completions." }),
    o("baseUrl", "OpenAI-Compatible Base URL"),
  ],
  dependsOn: [
    { fieldKey: "deployedVersionKey", targetTypeId: "cerebras-model-version", label: "serves" },
  ],
  supportsMetrics: true,
  iconKey: "deployment",
});

/**
 * An uploaded model version (custom weights) for Dedicated Inference.
 * `GET /management/v1/orgs/{org}/models/{arch}/versions`
 */
export const CerebrasModelVersionType = rt({
  name: "Model Version",
  id: "cerebras-model-version",
  description:
    "An immutable snapshot of custom weights for a Dedicated Inference architecture (Private Preview)",
  fields: [
    f("modelArchitecture", "Architecture", { editable: false }),
    f("versionId", "Version", { editable: false }),
    f("aliases", "Aliases", {
      required: false,
      description: "Comma-separated, e.g. production, v1-stable.",
    }),
    f("weightUri", "Weights (S3)", { required: false, editable: false }),
    f("syncStatus", "Sync Status", { required: false, editable: false }),
    f("resourceName", "Resource Name", { required: false, editable: false }),
  ],
  outputs: [o("resourceName", "Resource Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "package",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  CerebrasModelType,
  CerebrasEndpointType,
  CerebrasModelVersionType,
  CerebrasBatchType,
  CerebrasFileType,
];
