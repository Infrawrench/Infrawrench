import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ElevenLabsClient } from "./client.js";
import { VoiceResourceType } from "./resources/voice.js";
import { ModelResourceType } from "./resources/model.js";
import { PronunciationDictionaryResourceType } from "./resources/pronunciation-dictionary.js";
import { HistoryItemResourceType } from "./resources/history-item.js";

// Mark taken verbatim from the official "11 Symbol" asset linked from
// https://elevenlabs.io/brand (also served as https://elevenlabs.io/icon.svg).
// The icon.svg geometry (500×500, rx 100, bars 43×210) is scaled ÷5 onto the
// 100×100 plugin canvas; the brand ships black/white only, so the card uses the
// black container with the bars knocked out in white.
const manifest: PluginManifest = {
  id: "elevenlabs",
  version: "0.1.0",
  displayName: "ElevenLabs",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="20" fill="#000000"/>
    <path d="M62.8 71H54.2V29H62.8V71Z" fill="#FFFFFF"/>
    <path d="M45.8 71H37.2V29H45.8V71Z" fill="#FFFFFF"/>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Your ElevenLabs API key, sent as the xi-api-key header. Create one in the ElevenLabs dashboard under your profile menu (bottom-left avatar) → API Keys → Create API Key, or at elevenlabs.io/app/settings/api-keys. Grant it read access to Voices, Models, History and User (for the quota gauge and the billing currency), plus Text to Speech and Speech to Text if you want to use the Speech tab, and Workspace/usage read if you want cost graphs. Workspace keys and personal keys both work.",
      sensitive: true,
      placeholder: "sk_0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    caCertCredentialField,
  ],
  /**
   * Spend comes from `POST /v1/workspace/analytics/query/usage-by-product-over-time`,
   * asked for in 86,400-second (daily) buckets grouped by `product_type`,
   * `region` and `fiat_currency`. That endpoint's `group_by` is an array, so
   * both declared dimensions come back from a single request.
   *
   * The fallback is the deprecated `GET /v1/usage/character-stats` with
   * `metric=fiat_units_spent`, used only when the successor is absent or
   * refuses the key. Its `breakdown_type` is **single-valued**, so on that path
   * rows carry `service` and leave `region` unset — the two breakdowns are
   * independent decompositions of the same total and summing them would double
   * count. `region` is still declared here because the path we actually build
   * against supplies it.
   *
   * 365 days of history is the host default and well within the endpoint's
   * floor of 2020-01-01. ElevenLabs settles usage-based charges over a couple
   * of days, so the trailing 3 are re-fetched to absorb restatements.
   */
  costs: {
    dimensions: ["service", "region"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
};

const resourceTypes: ResourceTypeDefinition[] = [
  VoiceResourceType,
  ModelResourceType,
  PronunciationDictionaryResourceType,
  HistoryItemResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new ElevenLabsClient(credentials, services),
};
