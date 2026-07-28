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
        "Your ElevenLabs API key, sent as the xi-api-key header. Create one in the ElevenLabs dashboard under your profile menu (bottom-left avatar) → API Keys → Create API Key, or at elevenlabs.io/app/settings/api-keys. Grant it read access to Voices, Models, History and User (for the quota gauge), plus Text to Speech and Speech to Text if you want to use the Speech tab. Workspace keys and personal keys both work.",
      sensitive: true,
      placeholder: "sk_0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    caCertCredentialField,
  ],
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
