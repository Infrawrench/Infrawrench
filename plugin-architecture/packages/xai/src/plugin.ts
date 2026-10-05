import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { XaiClient } from "./client.js";
import { ModelResourceType } from "./resources/model.js";
import { FileResourceType } from "./resources/file.js";
import { BatchResourceType } from "./resources/batch.js";
import { CustomVoiceResourceType } from "./resources/custom-voice.js";
import { ApiKeyResourceType } from "./resources/api-key.js";
import { AuditEventResourceType } from "./resources/audit-event.js";
import { SkillResourceType } from "./resources/skill.js";
import { CollectionResourceType } from "./resources/collection.js";
import { CollectionDocumentResourceType } from "./resources/collection-document.js";
import { InvoiceResourceType } from "./resources/invoice.js";
import { SpendingLimitResourceType } from "./resources/spending-limit.js";

// Official xAI wordmark glyph, taken from the @lobehub/icons-static-svg brand
// set (icons/xai.svg), which mirrors xAI's own mark. Black background, white
// glyph: xAI's brand colours.
const manifest: PluginManifest = {
  id: "xai",
  version: "0.1.0",
  displayName: "xAI",
  description:
    "Grok models, files, batches, skills, voices and speech on api.x.ai, plus collections, team keys, audit logs, invoices, spending limits and prepaid credit on management-api.x.ai",
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
        "Inference API key (starts with `xai-`), created at console.x.ai → API Keys. Used for models, files, batches, voices and Speech.",
      sensitive: true,
      placeholder: "xai-…",
      helpLink: { label: "Create an API key", url: "https://console.x.ai" },
    },
    {
      key: "managementKey",
      label: "Management Key (optional)",
      description:
        "A separate key for https://management-api.x.ai, created at console.x.ai → Settings → Management Keys (needs Management Keys read + write). Without it, billing, invoices, spending limit, prepaid credit, collections, team API-key management and the audit log are unavailable.",
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
    focus: { default: { category: "AI and Machine Learning", subcategory: "Generative AI" } },
    // POST /v1/billing/teams/{team_id}/usage returns true daily buckets.
    dimensions: ["service"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
  // Remaining prepaid credit, read from the current period's invoice preview
  // on the management host, so it needs the optional management key.
  credits: {
    label: "Prepaid credits",
    topUpUrl: "https://console.x.ai/team/default/billing",
    requiresElevatedCredential: true,
  },
  rateLimit: { capacity: 20, refillPerSecond: 4 },
};

const resourceTypes: ResourceTypeDefinition[] = [
  ModelResourceType,
  CustomVoiceResourceType,
  FileResourceType,
  BatchResourceType,
  SkillResourceType,
  CollectionResourceType,
  CollectionDocumentResourceType,
  ApiKeyResourceType,
  AuditEventResourceType,
  InvoiceResourceType,
  SpendingLimitResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new XaiClient(credentials, services),
};
