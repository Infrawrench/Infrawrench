import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { UpstashClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { upstashTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "upstash",
  version: "0.1.0",
  displayName: "Upstash",
  description:
    "Manage Upstash Redis databases, Vector and Search indexes, QStash schedules, queues and URL groups, and teams: plans, budgets, read regions, backups, tokens, the dead letter queue and message logs, with stats, daily Redis and QStash spend, and a Redis console.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "email",
      label: "Email",
      description: "The email address you sign in to the Upstash console with.",
      sensitive: false,
      placeholder: "you@example.com",
    },
    {
      key: "apiKey",
      label: "Developer API Key",
      description:
        "In the Upstash console open Account, then the Developer API tab, and create a key. Pick Read/Write to manage resources here, or Read Only to just watch them. Accounts created through Vercel or Fly.io cannot use the Developer API.",
      sensitive: true,
      placeholder: "0123abcd-...",
      helpLink: {
        label: "Create a Developer API key",
        url: "https://console.upstash.com/account/api",
      },
    },
    caCertCredentialField,
  ],
  costs: {
    // Daily spend per Redis database and per regional QStash account, from
    // their stats endpoints, which only reach back about a week.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 7,
    restatementDays: 2,
  },
  quotas: { label: "QStash and Redis limits" },
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new UpstashClient(credentials, services),
  parseStatusFeed: (body: string) => parseStatusFeed(body),
  terraformExport: upstashTerraformExport,
};
