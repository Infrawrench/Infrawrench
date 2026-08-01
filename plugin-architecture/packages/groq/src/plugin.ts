import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { GroqClient } from "./client.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { GroqBatchResourceType } from "./resources/batch.js";
import { GroqFileResourceType } from "./resources/file.js";
import { GroqFineTuningResourceType } from "./resources/fine-tuning.js";
import { GroqModelResourceType } from "./resources/model.js";

const manifest: PluginManifest = {
  id: "groq",
  version: "0.1.0",
  displayName: "Groq",
  // Groq's own favicon mark (groq.com/favicon.svg): the white "fast-forward"
  // bolt on the #F43E01 brand orange, rescaled from its native 32×32 box.
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#F43E01"/>
    <g transform="translate(-1.69,-1.22) scale(3.125)" fill="#FFFFFF">
      <path d="m18.445 4.406-9.468 13.74 7.341.665-1.69 9.578 9.469-13.74-7.342-.664 1.69-9.579Z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A GroqCloud API key (starts with gsk_), created under API Keys in the Groq console. Groq has a single key type — there is no separate admin key, and no usage, billing, or key-management API, so spend and rate-limit history stay in the console.",
      sensitive: true,
      placeholder: "gsk_...",
      helpLink: { label: "Create an API key", url: "https://console.groq.com/keys" },
    },
    caCertCredentialField,
  ],
  statusFeed,
};

const resourceTypes: ResourceTypeDefinition[] = [
  GroqModelResourceType,
  GroqFineTuningResourceType,
  GroqBatchResourceType,
  GroqFileResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new GroqClient(credentials, services),
  parseStatusFeed,
};
