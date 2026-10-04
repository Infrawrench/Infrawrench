import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ElasticCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "elastic-cloud",
  version: "0.1.0",
  displayName: "Elastic Cloud",
  description:
    "Elastic Cloud Hosted and Serverless. Track spend by deployment, project and line item (capacity, data transfer, snapshot storage) with prepaid ECU burndown, and manage hosted deployments (resize, restart, traffic filters), serverless projects, traffic filters, extensions and budgets.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "Elastic Cloud API Key",
      description:
        "An organization API key from the Elastic Cloud console (Organization, API keys). Its role decides what this account can do: Billing admin reads costs, budgets and the prepaid balance; Admin or Editor on deployments and projects manages them; Organization owner does both. The organization is found from the key.",
      sensitive: true,
      placeholder: "essu_…",
      helpLink: {
        label: "Create an API key",
        url: "https://cloud.elastic.co/account/keys",
      },
    },
    caCertCredentialField,
  ],
  costs: {
    // Billing API v2 instance costs, one request per day: line-item category
    // → service, the region from the capacity SKU → region, deployment or
    // project id → resource, and organization / instance / instance_type /
    // component tags. ECU at the $1.00 nominal rate.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    // Usage is metered hourly and lands within a day or two; re-read the last
    // few days so late records are absorbed.
    restatementDays: 4,
  },
  // Prepaid ECU balances from the costs overview, one per order line item.
  credits: {
    label: "Prepaid ECUs",
    topUpUrl: "https://cloud.elastic.co/billing/overview",
    requiresElevatedCredential: true,
  },
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new ElasticCloudClient(credentials, services),
  parseStatusFeed,
};
