import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { TemporalCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { TEMPORAL_PREFLIGHT } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { temporalTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "temporal-cloud",
  version: "0.1.0",
  displayName: "Temporal Cloud",
  description:
    "Durable execution as a service. Track spend by namespace and usage dimension, chart actions, workflow outcomes, latency and backlog, and manage namespaces, export sinks, users, service accounts, API keys, Nexus endpoints and connectivity rules.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Temporal Cloud API key, from Settings, API Keys (your own) or Service Accounts (recommended). It carries its owner's account role: Admin manages namespaces and identities; billing reports need Owner or Finance Admin.",
      sensitive: true,
      placeholder: "eyJhbGciOi…",
      helpLink: {
        label: "Manage API keys",
        url: "https://docs.temporal.io/cloud/api-keys",
      },
    },
    {
      key: "metricsApiKey",
      label: "Metrics API Key (optional)",
      description:
        "A service account key with the Metrics Read-Only role, for namespace metrics. Leave empty to use the API key above, which works when its role can read metrics.",
      sensitive: true,
      optional: true,
      helpLink: {
        label: "Set up OpenMetrics",
        url: "https://docs.temporal.io/cloud/metrics/openmetrics",
      },
    },
    {
      key: "plan",
      label: "Plan (for estimates)",
      description:
        "Used only when billing reports are unavailable and cost is estimated from usage: it decides volume pricing for actions and the plan charge (Developer 10% of usage; Business the greater of $500 a month or 10%; Enterprise contract pricing is not estimated).",
      sensitive: false,
      optional: true,
      defaultValue: "business",
      regions: [
        { id: "developer", label: "Developer" },
        { id: "business", label: "Business" },
        { id: "enterprise", label: "Enterprise or Mission Critical" },
        { id: "none", label: "Do not estimate a plan charge" },
      ],
      helpLink: { label: "Temporal Cloud pricing", url: "https://docs.temporal.io/cloud/pricing" },
    },
    {
      key: "actionsPricePerMillion",
      label: "Actions Price per Million (optional)",
      description:
        "Your contracted USD price per million actions, for estimates. Leave empty for the published price: $50 per million on Developer, volume tiers from $50 down to $25 on Business and above.",
      sensitive: false,
      optional: true,
      placeholder: "50",
    },
    {
      key: "activeStoragePricePerGbh",
      label: "Active Storage Price per GBh (optional)",
      description: "USD per GB-hour of active storage, for estimates. Published price: 0.042.",
      sensitive: false,
      optional: true,
      placeholder: "0.042",
    },
    {
      key: "retainedStoragePricePerGbh",
      label: "Retained Storage Price per GBh (optional)",
      description: "USD per GB-hour of retained storage, for estimates. Published price: 0.00105.",
      sensitive: false,
      optional: true,
      placeholder: "0.00105",
    },
    caCertCredentialField,
  ],
  costs: {
    // Billing reports attribute every charge to a namespace (`resource`), by
    // usage dimension (`service`: Actions, Active Storage, Retained Storage,
    // plan and support), with the namespace's tags and its region looked up
    // from inventory. Monthly granularity reaches back 11 months before the
    // current one; daily covers the current and previous two months.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    // The current billing month is restated until it closes; 35 days always
    // re-reads the whole previous month once it has.
    restatementDays: 35,
    chargeTypes: true,
  },
  preflight: TEMPORAL_PREFLIGHT,
  statusFeed,
  // Cloud Ops API: 40 requests per second per user, 80 per service account.
  rateLimit: { capacity: 20, refillPerSecond: 10 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new TemporalCloudClient(credentials, services),
  parseStatusFeed,
  terraformExport: temporalTerraformExport,
};
