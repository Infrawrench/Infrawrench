import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { BunnyClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { bunnyRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { bunnyTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "bunny",
  version: "0.1.0",
  displayName: "bunny.net",
  description:
    "CDN, storage and edge platform. Purge and configure pull zones with hostnames, SSL and edge rules, browse Edge Storage, manage DNS zones and records, Stream libraries, Edge Scripts and Magic Containers apps, and chart traffic, cache hit rate and spend.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "Account API Key",
      description:
        "In the bunny.net dashboard open Account settings → API key and copy the account API key. It covers every product; bunny.net has no scoped keys.",
      sensitive: true,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxxxxxx-xxxx-xxxx",
      helpLink: { label: "Account API key", url: "https://dash.bunny.net/account/api-key" },
    },
    caCertCredentialField,
  ],
  costs: {
    // GET /billing: this month by product (and CDN traffic by billing
    // region), closed months as one MonthlyUsage total each. Dated to the
    // 1st; the running month is restated on every pass.
    dimensions: ["service", "region"],
    maxHistoryDays: 730,
    periodNative: true,
    chargeTypes: true,
    restatementDays: 62,
  },
  credits: { label: "Prepaid balance", topUpUrl: "https://dash.bunny.net/account/billing" },
  preflight: {
    capabilities: [
      {
        id: "resources",
        label: "Pull zones and other resources",
        essential: true,
        requiredPermissions: [{ id: "api-key", label: "Account API key" }],
      },
      {
        id: "costs",
        label: "Billing and balance",
        requiredPermissions: [{ id: "api-key", label: "Account API key" }],
      },
      {
        id: "containers",
        label: "Magic Containers",
        description: "Only when Magic Containers is enabled on the account.",
        requiredPermissions: [{ id: "api-key", label: "Account API key" }],
      },
    ],
  },
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new BunnyClient(credentials, services),
  parseStatusFeed,
  terraformExport: bunnyTerraformExport,
  remediationCommands: bunnyRemediationCommands,
};
