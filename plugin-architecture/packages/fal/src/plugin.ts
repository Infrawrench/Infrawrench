import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { FalClient } from "./client.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

// fal's mark (the rounded square with a circular cut-out, brand #EC0648),
// from the lobe-icons set (@lobehub/icons-static-svg, fal.svg), 24x24
// scaled x3 on white.
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="20" fill="#FFFFFF"/>
  <g transform="translate(14 14) scale(3)">
    <path clip-rule="evenodd" d="M15.477 0c.415 0 .749.338.788.752a7.775 7.775 0 006.985 6.984c.413.04.752.373.752.788v6.952c0 .415-.338.748-.752.788a7.775 7.775 0 00-6.985 6.984c-.04.414-.373.752-.788.752H8.525c-.416 0-.749-.338-.789-.752a7.775 7.775 0 00-6.984-6.984c-.414-.04-.752-.373-.752-.788V8.524c0-.415.338-.748.752-.788A7.775 7.775 0 007.736.752C7.776.338 8.11 0 8.526 0h6.95zM4.819 11.98a7.226 7.226 0 007.223 7.23 7.226 7.226 0 007.223-7.23c0-3.994-3.234-7.23-7.223-7.23a7.227 7.227 0 00-7.223 7.23z" fill="#EC0648" fill-rule="evenodd"/>
  </g>
</svg>`;

const manifest: PluginManifest = {
  id: "fal",
  version: "0.1.0",
  displayName: "fal",
  description:
    "fal Model API usage, prices and analytics, Serverless apps, Compute instances, API keys, workflows, billed spend and credits.",
  logoSvg: LOGO,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "Admin API Key",
      description:
        "A key from fal.ai/dashboard/keys, pasted whole as key_id:key_secret. Create it with the ADMIN scope: usage, cost, credits, API keys and Compute instances are admin-only. An API-scope key still shows Serverless apps, workflows and analytics.",
      sensitive: true,
      placeholder: "0123abcd-...:abcdef0123...",
      helpLink: { label: "Create an API key", url: "https://fal.ai/dashboard/keys" },
    },
    caCertCredentialField,
  ],
  costs: {
    // Model APIs per endpoint (resource) with the auth method as a tag;
    // Serverless per app (resource) with machine type, environment and surge.
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 365,
    // Usage is an estimate until invoiced and can be restated.
    restatementDays: 3,
    focus: { default: { category: "AI and Machine Learning", subcategory: "Generative AI" } },
  },
  credits: {
    label: "fal credits",
    topUpUrl: "https://fal.ai/dashboard/billing",
    requiresElevatedCredential: true,
  },
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new FalClient(credentials, services),
  parseStatusFeed,
};
