import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField, f, o, rt } from "@infrawrench/plugin-base";
import { PerplexityClient } from "./client.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

// Perplexity's mark from simple-icons (perplexity.svg, brand hex #1FB8CD),
// 24x24 scaled x2.5 on Perplexity's off-black.
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="20" fill="#091717"/>
  <g transform="translate(20 20) scale(2.5)">
    <path fill="#1FB8CD" d="M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z"/>
  </g>
</svg>`;

const modelFields = [
  f("modelId", "Model ID"),
  f("ownedBy", "Owned By", { required: false }),
  f("description", "Description", { required: false }),
  f("inputPrice", "Input Price", { kind: "number", required: false }),
  f("outputPrice", "Output Price", { kind: "number", required: false }),
  f("cacheReadPrice", "Cache Read Price", { kind: "number", required: false }),
  f("cacheWritePrice", "Cache Write Price", { kind: "number", required: false }),
  f("priceUnit", "Price Unit", { required: false }),
];
const modelOutputs = [o("modelId", "Model ID"), o("endpoint", "Endpoint URL")];

export const SonarModelType = rt({
  name: "Sonar Model",
  id: "perplexity-sonar-model",
  description: "A search-grounded Sonar model called through POST /v1/sonar",
  fields: modelFields,
  outputs: modelOutputs,
  iconKey: "search",
});

export const AgentModelType = rt({
  name: "Agent API Model",
  id: "perplexity-agent-model",
  description: "A model usable with the Agent API (POST /v1/agent), with web search and tools",
  fields: modelFields,
  outputs: modelOutputs,
  iconKey: "sparkles",
});

export const RouterModelType = rt({
  name: "Router Model",
  id: "perplexity-router-model",
  description:
    "An open-weight or third-party model on the OpenAI-compatible Router API, with per-token prices",
  fields: modelFields,
  outputs: modelOutputs,
  iconKey: "cpu",
});

export const AsyncRequestType = rt({
  name: "Async Sonar Request",
  id: "perplexity-async-request",
  description: "An asynchronous Sonar completion, typically a deep-research report",
  fields: [
    f("requestId", "Request ID"),
    f("model", "Model", { required: false }),
    f("status", "Status", { required: false }),
    f("errorMessage", "Error", { required: false }),
    f("cost", "Cost (USD)", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("completedAt", "Completed", { required: false }),
  ],
  outputs: [o("requestId", "Request ID")],
  dependsOn: [{ fieldKey: "model", targetTypeId: "perplexity-sonar-model", label: "runs on" }],
  supportsCreate: true,
  iconKey: "clock",
});

export const SkillType = rt({
  name: "Skill",
  id: "perplexity-skill",
  description: "An Agent API skill bundle in your project, with its revision history",
  fields: [
    f("skillId", "Skill ID"),
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false }),
    f("revision", "Active Revision", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("updatedAt", "Updated", { required: false }),
  ],
  outputs: [o("skillId", "Skill ID")],
  supportsDelete: true,
  iconKey: "package",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  SonarModelType,
  AgentModelType,
  RouterModelType,
  AsyncRequestType,
  SkillType,
];

const manifest: PluginManifest = {
  id: "perplexity",
  version: "0.1.0",
  displayName: "Perplexity",
  description:
    "Sonar, Agent API and Router models with Playgrounds, asynchronous deep-research requests and Agent API skills.",
  logoSvg: LOGO,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A key from the Perplexity API console (console.perplexity.ai → your project → API Keys). Keys belong to a project and have no scopes; the project needs credits or a payment method for calls to succeed.",
      sensitive: true,
      placeholder: "pplx-...",
      helpLink: { label: "Create an API key", url: "https://console.perplexity.ai/project/keys" },
    },
    caCertCredentialField,
  ],
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new PerplexityClient(credentials, services),
  parseStatusFeed,
};
