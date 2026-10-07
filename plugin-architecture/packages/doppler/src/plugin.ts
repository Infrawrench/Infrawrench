import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { DopplerClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { dopplerRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { dopplerTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "doppler",
  version: "0.1.0",
  displayName: "Doppler",
  description:
    "Doppler secrets management: projects, environments and configs with a secrets editor, service tokens, integrations and syncs, webhooks, workplace users, groups and service accounts, and the activity log.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "token",
      label: "API Token",
      description:
        "A personal token (dashboard.doppler.com, your avatar, Tokens, Generate; starts with dp.pt.) sees everything you can see, or a service account token (Team, Service Accounts, a service account, API Tokens; dp.sa.) sees what its role grants. Config-scoped service tokens (dp.st.) cannot list projects and are refused.",
      sensitive: true,
      placeholder: "dp.pt.…",
      helpLink: {
        label: "Doppler token formats",
        url: "https://docs.doppler.com/reference/auth-token-formats",
      },
    },
  ],
  statusFeed,
  // Doppler allows 240 API requests a minute on most plans; stay under it.
  rateLimit: { capacity: 10, refillPerSecond: 3 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new DopplerClient(credentials, services),
  parseStatusFeed,
  terraformExport: dopplerTerraformExport,
  remediationCommands: dopplerRemediationCommands,
};
