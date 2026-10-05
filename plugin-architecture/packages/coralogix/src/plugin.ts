import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { CoralogixClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { CORALOGIX_PREFLIGHT, coralogixPolicyTemplate } from "./preflight.js";
import { DEFAULT_REGION_ID, REGION_PICKER } from "./regions.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "coralogix",
  version: "0.1.0",
  displayName: "Coralogix",
  description:
    "Observability platform for logs, metrics and traces. Track usage and estimated cost by pillar and TCO priority, watch the daily quota, and manage alerts, dashboards, TCO policies, parsing rules, enrichments, webhooks and Events2Metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "region",
      label: "Coralogix Region",
      description:
        "The region (Coralogix domain) your team lives in, read from the address you sign in at: team.coralogix.com is EU1, team.app.eu2.coralogix.com is EU2, team.app.coralogix.us is US1, team.app.cx498.coralogix.com is US2. Keys only work in their own region.",
      sensitive: false,
      optional: true,
      defaultValue: DEFAULT_REGION_ID,
      regions: REGION_PICKER,
      helpLink: {
        label: "Find your Coralogix domain",
        url: "https://coralogix.com/docs/user-guides/account-management/account-settings/coralogix-domain/",
      },
    },
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Team API key from Settings, API Keys (a Personal key works too, with its owner's permissions). Attach the DataUsage preset for usage and cost, and the Alerts, Dashboards, TCOPolicies, ParsingRules, Enrichments, OutboundWebhooks and Events2Metrics presets for the matching resources. Not a Send-Your-Data key: those only ingest data.",
      sensitive: true,
      helpLink: {
        label: "Create a Coralogix API key",
        url: "https://coralogix.com/docs/user-guides/account-management/api-keys/api-keys/",
      },
    },
    {
      key: "unitPrice",
      label: "Price per Unit (USD)",
      description:
        "What one Coralogix unit costs on your plan. Coralogix reports usage in units, not money, so cost is units multiplied by this price. Leave the published $1.50 per unit or enter your contracted rate. You can edit it later.",
      sensitive: false,
      optional: true,
      defaultValue: "1.50",
      placeholder: "1.50",
      helpLink: {
        label: "How Coralogix units are priced",
        url: "https://coralogix.com/docs/user-guides/account-management/payment-and-billing/data-usage/",
      },
    },
    caCertCredentialField,
  ],
  costs: {
    // Daily units per pillar and TCO priority, priced at the account's unit
    // price: pillar → service, the Coralogix region → region, and the raw
    // pillar plus the TCO priority (Frequent Search, Monitoring, Compliance,
    // Blocked) as the `pillar` and `priority` tags.
    dimensions: ["service", "region", "tag"],
    maxHistoryDays: 365,
    // Usage for a day settles within a few hours of UTC midnight; three days
    // absorbs late-arriving data and a unit price edited since the last pass
    // reprices the recent window.
    restatementDays: 3,
    // Units × a price no API exposes (the published list price by default).
    estimated: true,
  },
  quotas: {
    label: "Quota and limits",
    increaseUrl:
      "https://coralogix.com/docs/user-guides/account-management/payment-and-billing/quota-rules/",
    partial: true,
  },
  preflight: CORALOGIX_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new CoralogixClient(credentials, services),
  parseStatusFeed,
  policyTemplate: coralogixPolicyTemplate,
};
