import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { XaiClient } from "./client.js";
import { ModelResourceType } from "./resources/model.js";
import { FileResourceType } from "./resources/file.js";
import { BatchResourceType } from "./resources/batch.js";
import { CustomVoiceResourceType } from "./resources/custom-voice.js";
import { ApiKeyResourceType } from "./resources/api-key.js";
import { AuditEventResourceType } from "./resources/audit-event.js";

// Official xAI wordmark glyph, taken from the @lobehub/icons-static-svg brand
// set (icons/xai.svg), which mirrors xAI's own mark. Black background, white
// glyph — xAI's brand colours.
const manifest: PluginManifest = {
  id: "xai",
  version: "0.1.0",
  displayName: "xAI",
  description:
    "Grok models, files, batches, voices and speech on api.x.ai, plus team keys, audit logs and billing on management-api.x.ai",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#000000"/>
    <g transform="translate(23,23) scale(2.2917)" fill="#FFFFFF" fill-rule="evenodd">
      <path d="M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Inference API key (starts with `xai-`), created at console.x.ai → API Keys. This is the key that talks to https://api.x.ai — models, files, batches, voices, and the Speech tab all use it.",
      sensitive: true,
      placeholder: "xai-…",
      helpLink: { label: "Create an API key", url: "https://console.x.ai" },
    },
    {
      key: "managementKey",
      label: "Management Key (optional)",
      description:
        "A separate key for https://management-api.x.ai, created at console.x.ai → Settings → Management Keys (your account needs Management Keys read + write). Without it, billing and usage, team API-key management, and the audit log are unavailable — everything on the inference key keeps working.",
      sensitive: true,
      optional: true,
      placeholder: "xai-…",
      helpLink: {
        label: "Create a management key",
        url: "https://console.x.ai/team/default/settings",
      },
    },
    caCertCredentialField,
  ],
  costs: {
    // POST /v1/billing/teams/{team_id}/usage returns true daily buckets.
    dimensions: ["service"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
  rateLimit: { capacity: 20, refillPerSecond: 4 },
};

const resourceTypes: ResourceTypeDefinition[] = [
  ModelResourceType,
  CustomVoiceResourceType,
  FileResourceType,
  BatchResourceType,
  ApiKeyResourceType,
  AuditEventResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new XaiClient(credentials, services),
};
