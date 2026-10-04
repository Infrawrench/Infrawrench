import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { DevinClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { ACU_PRICE_KEY, DEFAULT_ACU_PRICE } from "./pricing.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "devin",
  version: "0.1.0",
  displayName: "Devin",
  description:
    "Cognition's AI software engineer. Track Devin ACU spend by product, user, playbook and session tag, and manage sessions (terminate, archive, tag), playbooks, knowledge, secrets, automations and members with their usage metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Devin service user credential (it starts with cog_) or a personal access token. An organization service user covers its organization; an enterprise service user covers every organization in the enterprise. For cost data its role needs View Org Consumption (View Account Consumption for an enterprise service user). Create one under Settings, Service users.",
      sensitive: true,
      placeholder: "cog_…",
      helpLink: { label: "Devin API keys", url: "https://docs.devin.ai/api-reference/overview" },
    },
    {
      key: ACU_PRICE_KEY,
      label: "Price per ACU (USD)",
      description:
        "What one Agent Compute Unit costs you. Devin's API reports ACUs but not prices, so cost is ACUs times this rate. The default is Devin's published pay-as-you-go rate of $2.25; Enterprise contracts set their own rate in the order form.",
      sensitive: false,
      optional: true,
      defaultValue: DEFAULT_ACU_PRICE,
      helpLink: { label: "Devin billing", url: "https://docs.devin.ai/admin/billing" },
    },
    caCertCredentialField,
  ],
  costs: {
    // ACUs from the daily consumption endpoints, priced at the rate above:
    // product -> service, session -> resource, and organization, user,
    // playbook, session tag, origin and category as tags (see cost-data.ts).
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 365,
    // Long-running sessions keep accruing; re-read a week every pass.
    restatementDays: 7,
    estimated: true,
  },
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new DevinClient(credentials, services),
  parseStatusFeed,
};
