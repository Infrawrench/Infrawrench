import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { XataClient } from "./client.js";
import { XATA_LOGO } from "./logo.js";
import { XATA_PREFLIGHT } from "./preflight.js";
import { xataRemediationCommands } from "./remediation.js";
import { resourceTypes } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "xata",
  version: "0.1.0",
  displayName: "Xata",
  description:
    "Xata Postgres: organizations, projects, copy-on-write branches, backups, API keys and members, with metrics, logs, SQL and invoices.",
  logoSvg: XATA_LOGO,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "An organization API key from the Xata console (console.xata.io, API Keys), or a user key from `xata keys user create`. Give it org:read, project:read/write, branch:read/write, credentials:read/write, metrics:read and logs:read; add keys:read/write and role:read/write to manage keys and members.",
      sensitive: true,
      placeholder: "xau_…",
      helpLink: { label: "Open the Xata console", url: "https://console.xata.io" },
    },
    caCertCredentialField,
  ],
  // Monthly invoices with one amount each, plus the running upcoming invoice.
  costs: {
    dimensions: ["tag"],
    maxHistoryDays: 365,
    restatementDays: 35,
    periodNative: true,
    focus: { default: { category: "Databases", subcategory: "Relational Databases" } },
  },
  quotas: { label: "Organization limits", partial: true, increaseUrl: "https://xata.io/contact" },
  statusFeed,
  preflight: XATA_PREFLIGHT,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new XataClient(credentials, services),
  parseStatusFeed,
  remediationCommands: xataRemediationCommands,
};
