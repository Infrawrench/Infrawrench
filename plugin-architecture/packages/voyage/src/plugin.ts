import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField, f, o, rt } from "@infrawrench/plugin-base";
import { VoyageClient } from "./client.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

// Voyage AI's "V" mark (brand #012E33) from the lobe-icons set
// (@lobehub/icons-static-svg, voyage.svg), 24x24 scaled x3 on white.
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="20" fill="#FFFFFF"/>
  <g transform="translate(14 14) scale(3)">
    <path d="M5.407 0v.066a.974.974 0 00-.048.245c-.011.11-.016.208-.016.295 0 .339.043.715.128 1.13.097.405.274.912.531 1.524l7.125 16.366L20.011 3.39c.161-.404.333-.846.515-1.327.182-.48.273-.966.273-1.458a1.406 1.406 0 00-.096-.54V0H24v.066c-.204.207-.45.578-.74 1.114-.29.535-.606 1.195-.949 1.982L13.095 24h-1.287L3.075 3.965c-.204-.47-.418-.923-.644-1.36-.214-.437-.418-.83-.61-1.18-.194-.36-.365-.66-.515-.9A5.666 5.666 0 001 .064V0h4.407z" fill="#012E33"/>
  </g>
</svg>`;

export const VoyageModelType = rt({
  name: "Model",
  id: "voyage-model",
  description:
    "A Voyage AI embedding, contextualized, multimodal or rerank model with its list price and limits",
  fields: [
    f("modelId", "Model ID"),
    f("kind", "Type", { required: false }),
    f("contextLength", "Context Length", { kind: "number", required: false }),
    f("dimensions", "Dimensions", { required: false }),
    f("pricePerMillion", "Price (USD / 1M tokens)", { kind: "number", required: false }),
    f("generation", "Generation", { required: false }),
    f("description", "Description", { required: false }),
  ],
  outputs: [o("modelId", "Model ID"), o("endpoint", "Endpoint URL")],
  iconKey: "cpu",
});

export const VoyageBatchType = rt({
  name: "Batch",
  id: "voyage-batch",
  plural: "Batches",
  description:
    "An asynchronous embedding or rerank batch processed within 12 hours at a 33% discount",
  fields: [
    f("batchId", "Batch ID"),
    f("status", "Status", { required: false }),
    f("endpoint", "Endpoint", { required: false }),
    f("model", "Model", { required: false }),
    f("inputFileId", "Input File", { required: false }),
    f("outputFileId", "Output File", { required: false }),
    f("errorFileId", "Error File", { required: false }),
    f("totalRequests", "Total Requests", { kind: "number", required: false }),
    f("completedRequests", "Completed Requests", { kind: "number", required: false }),
    f("failedRequests", "Failed Requests", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("completedAt", "Completed", { required: false }),
  ],
  outputs: [o("batchId", "Batch ID"), o("outputFileId", "Output File ID")],
  dependsOn: [
    { fieldKey: "model", targetTypeId: "voyage-model", label: "runs" },
    { fieldKey: "inputFileId", targetTypeId: "voyage-file", label: "reads" },
    { fieldKey: "outputFileId", targetTypeId: "voyage-file", label: "writes" },
    { fieldKey: "errorFileId", targetTypeId: "voyage-file", label: "errors to" },
  ],
  supportsCreate: true,
  iconKey: "layers",
});

export const VoyageFileType = rt({
  name: "File",
  id: "voyage-file",
  description: "A batch input, output or error file; files expire 30 days after upload",
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

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  VoyageModelType,
  VoyageBatchType,
  VoyageFileType,
];

const manifest: PluginManifest = {
  id: "voyage",
  version: "0.1.0",
  displayName: "Voyage AI",
  description:
    "Voyage AI embedding and rerank models with list prices and a test bench, plus batches and files.",
  logoSvg: LOGO,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A key from dashboard.voyageai.com → Organization → API keys (Create new secret key). Keys have no scopes; batches and files are per organization.",
      sensitive: true,
      placeholder: "your secret key",
      helpLink: {
        label: "Create an API key",
        url: "https://dashboard.voyageai.com/organization/api-keys",
      },
    },
    caCertCredentialField,
  ],
  preflight: {
    capabilities: [
      {
        id: "api",
        label: "Use the Voyage API",
        description: "Checked with a free file listing.",
        requiredPermissions: [{ id: "api-key", label: "A valid Voyage AI API key" }],
        essential: true,
      },
    ],
  },
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new VoyageClient(credentials, services),
  parseStatusFeed,
};
