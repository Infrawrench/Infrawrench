import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { AivenClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { aivenTerraformExport } from "./terraform.js";
import { aivenRemediationCommands } from "./remediation.js";

const manifest: PluginManifest = {
  id: "aiven",
  version: "0.1.0",
  displayName: "Aiven",
  description:
    "Manage Aiven projects and services of every type (PostgreSQL, MySQL, Kafka, OpenSearch, ClickHouse, Valkey, Grafana and more): plans, clouds, power, maintenance, users, databases, connection pools, Kafka topics, ACLs, connectors and schemas, integrations, VPCs and peering, with metrics, logs, invoice-based costs, credits and database consoles.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description:
        "In the Aiven console open User profile, then Tokens, and generate a token (or create an application user token under your organization's Application users). It acts with your own project and organization permissions; billing data needs the billing role on the organization.",
      sensitive: true,
      placeholder: "aBcD123...",
      helpLink: { label: "Create an Aiven token", url: "https://console.aiven.io/profile/auth" },
    },
    caCertCredentialField,
  ],
  costs: {
    // Invoice lines (including the running estimate), spread over the days
    // they cover: service type, cloud, project/service and billing tags.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 35,
    chargeTypes: true,
  },
  credits: { label: "Aiven credits", topUpUrl: "https://console.aiven.io/billing" },
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new AivenClient(credentials, services),
  parseStatusFeed: (body: string) => parseStatusFeed(body),
  terraformExport: aivenTerraformExport,
  remediationCommands: aivenRemediationCommands,
};
