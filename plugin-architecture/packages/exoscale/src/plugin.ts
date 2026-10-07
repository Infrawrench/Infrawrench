import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { EXOSCALE_PREFLIGHT, ExoscaleClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resources.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { exoscaleTerraformExport } from "./terraform.js";
import { exoscaleRemediationCommands } from "./remediation.js";

const manifest: PluginManifest = {
  id: "exoscale",
  version: "0.1.0",
  displayName: "Exoscale",
  description:
    "Exoscale: billed spend from the monthly FOCUS billing report, organization quotas and balance, and compute instances, block storage and snapshots, templates, private networks, security groups, elastic IPs, SKS Kubernetes, network load balancers, instance pools, DBaaS, DNS and SOS object storage across every zone.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Create a key in the Exoscale Portal under IAM, API Keys, with a role that allows the services you want to see (compute, dbaas, dns, sos, and billing for costs).",
      sensitive: false,
      placeholder: "EXO…",
      helpLink: {
        label: "How to create an API key",
        url: "https://community.exoscale.com/product/iam/how-to/api-keys/",
      },
    },
    {
      key: "apiSecret",
      label: "API Secret",
      description: "The secret shown once when the key is created.",
      sensitive: true,
      placeholder: "Secret for the key above",
    },
    caCertCredentialField,
  ],
  /**
   * Billed spend from the organization's FOCUS report
   * (`GET /v2/focus-report/{YYYY-MM}`, a presigned download), aggregated per
   * day, service, zone, resource and tag. Restated while a month is open.
   */
  costs: {
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 62,
    chargeTypes: true,
  },
  credits: { label: "Account balance", topUpUrl: "https://portal.exoscale.com/billing" },
  quotas: {
    label: "Organization quotas",
    increaseUrl: "https://portal.exoscale.com/organization/quotas",
  },
  preflight: EXOSCALE_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) =>
    new ExoscaleClient(credentials, RESOURCE_TYPES, services),
  terraformExport: exoscaleTerraformExport,
  remediationCommands: exoscaleRemediationCommands,
  parseStatusFeed: (body) => parseStatusFeed(body),
};
