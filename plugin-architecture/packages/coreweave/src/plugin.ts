import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { CoreWeaveClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { COREWEAVE_PREFLIGHT, coreweavePolicyTemplate } from "./preflight.js";
import { fetchPriceCatalog, priceCatalog } from "./price-catalog.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { coreweaveTerraformExport } from "./terraform.js";
import { coreweaveRemediationCommands } from "./remediation.js";

const manifest: PluginManifest = {
  id: "coreweave",
  version: "0.1.0",
  displayName: "CoreWeave",
  description:
    "GPU cloud. GPU-hours and estimated spend by cluster, instance type and capacity plan, CKS clusters, Node Pools, VPCs, AI Object Storage buckets, GPU utilization, and per-namespace GPU cost.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Access Token",
      description:
        "A CoreWeave API access token from the Tokens page of the Cloud Console (it starts with CW-SECRET-). The same token reaches the Cloud API, each cluster's Kubernetes API and the metrics API, with its owner's IAM roles.",
      sensitive: true,
      placeholder: "CW-SECRET-…",
      helpLink: {
        label: "Create an API access token",
        url: "https://console.coreweave.com/tokens",
      },
    },
    {
      key: "negotiatedRates",
      label: "Negotiated Rates (optional)",
      description:
        "Your contract prices, used instead of the published on-demand prices: instance type=USD per instance-hour, optionally per capacity plan (reserved/, spot/, flex/, on-demand/), plus storage= and objectStorage= (USD per GB-month) and ip= (USD per IP per month). Leave empty to use list prices.",
      sensitive: false,
      optional: true,
      multiline: true,
      placeholder: "gd-8xh100ib-i128=35.50, reserved/gb200-4x=30, storage=0.06",
    },
    caCertCredentialField,
  ],
  costs: {
    // FOCUS usage export: product family/service → service, zone → region,
    // cluster id → resource, and SKU, capacity plan, cluster name, GPU model
    // and pricing source as tags. Usage × negotiated or list rates, so
    // estimated. History starts 2026-01-01 and hourly aggregates settle
    // within a few hours.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 3,
    estimated: true,
  },
  preflight: COREWEAVE_PREFLIGHT,
  statusFeed,
  // Static list prices from catalog.ts, North American zones only.
  priceCatalog,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new CoreWeaveClient(credentials, services),
  parseStatusFeed,
  fetchPriceCatalog,
  policyTemplate: coreweavePolicyTemplate,
  terraformExport: coreweaveTerraformExport,
  remediationCommands: coreweaveRemediationCommands,
};
