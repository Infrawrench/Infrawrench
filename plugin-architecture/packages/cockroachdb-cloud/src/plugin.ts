import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { CockroachClient } from "./client.js";
import { COCKROACH_LOGO } from "./logo.js";
import { CRDB_PREFLIGHT } from "./preflight.js";
import { resourceTypes } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { cockroachTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "cockroachdb-cloud",
  version: "0.1.0",
  displayName: "CockroachDB Cloud",
  description:
    "CockroachDB Cloud clusters (Basic, Standard, Advanced): databases, SQL users, IP allowlists, backups and restores, log and metric export, folders, service accounts and invoices.",
  logoSvg: COCKROACH_LOGO,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A service account API key. In CockroachDB Cloud open Organization > Access Management > Service Accounts, create a service account with the roles Infrawrench should have (CLUSTER_ADMIN to manage clusters, BILLING_VIEWER for costs, ORG_ADMIN to manage service accounts), then create an API key for it and copy the secret.",
      sensitive: true,
      placeholder: "CCDB1_…",
      helpLink: { label: "Service accounts", url: "https://cockroachlabs.cloud/access" },
    },
    caCertCredentialField,
  ],
  // 10 requests a second per user.
  rateLimit: { capacity: 10, refillPerSecond: 8 },
  // Monthly invoices with per-cluster Metronome line items and adjustments.
  costs: {
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 35,
    periodNative: true,
    chargeTypes: true,
    focus: { default: { category: "Databases", subcategory: "Relational Databases" } },
  },
  statusFeed,
  preflight: CRDB_PREFLIGHT,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new CockroachClient(credentials, services),
  parseStatusFeed,
  terraformExport: cockroachTerraformExport,
};
