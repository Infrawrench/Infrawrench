import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { OpenRouterClient } from "./client.js";
import { ModelResourceType } from "./resources/model.js";
import { ModelEndpointResourceType } from "./resources/model-endpoint.js";
import { ProviderResourceType } from "./resources/provider.js";
import { ApiKeyResourceType } from "./resources/api-key.js";

// OpenRouter's own mark, taken from the inline logo on openrouter.ai
// (viewBox 19.82 17.199 365.556 258.298) and its favicon colours — near-black
// #070C0E card, off-white glyph.
const manifest: PluginManifest = {
  id: "openrouter",
  version: "0.1.0",
  displayName: "OpenRouter",
  description:
    "The OpenRouter model catalogue, per-provider endpoint pricing and uptime, API keys, credits and activity",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#070C0E"/>
    <g transform="translate(15,26) scale(0.1913) translate(-19.82,-17.199)" fill="#FAFAFB">
      <path d="M303.9475,17.19926c42.79734,0,77.48933,34.69327,77.48933,77.48933s-34.69199,77.48933-77.48933,77.48933l76.86166,76.86244c9.76367,9.76313,2.84903,26.45667-10.95697,26.45667h-220.88335c-71.32686,0-129.14889-57.82202-129.14889-129.14889S77.64197,17.19926,148.96884,17.19926h154.97866ZM148.96884,68.85881c-42.79607,0-77.48933,34.69327-77.48933,77.48933s34.69327,77.48933,77.48933,77.48933,77.48933-34.69327,77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "managementKey",
      label: "Management Key",
      description:
        "OpenRouter's privileged credential — formerly called a provisioning key — created at openrouter.ai/settings/management-keys. A plain inference key gets a 403 from /credits, /activity, /keys and /generation, which is almost the whole console surface, so this is the key the plugin lists resources with.",
      sensitive: true,
      placeholder: "sk-or-v1-…",
      helpLink: {
        label: "Create a management key",
        url: "https://openrouter.ai/settings/management-keys",
      },
    },
    {
      key: "apiKey",
      label: "Inference API Key (optional)",
      description:
        "A normal inference key from openrouter.ai/settings/keys. Management keys are rejected by the completion endpoints, so the Speech tab (text-to-speech and transcription) needs one of these. Everything else works without it.",
      sensitive: true,
      optional: true,
      placeholder: "sk-or-v1-…",
      helpLink: { label: "Create an API key", url: "https://openrouter.ai/settings/keys" },
    },
    caCertCredentialField,
  ],
  costs: {
    // GET /activity is daily and broken down by model + provider.
    dimensions: ["service", "resource"],
    // OpenRouter only keeps the last 30 completed UTC days.
    maxHistoryDays: 30,
    restatementDays: 2,
  },
  rateLimit: { capacity: 20, refillPerSecond: 4 },
};

const resourceTypes: ResourceTypeDefinition[] = [
  ModelResourceType,
  ModelEndpointResourceType,
  ProviderResourceType,
  ApiKeyResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new OpenRouterClient(credentials, services),
};
