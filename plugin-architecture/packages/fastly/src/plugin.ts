import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { FastlyClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { FASTLY_PREFLIGHT, fastlyPolicyTemplate } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "fastly",
  version: "0.1.0",
  displayName: "Fastly",
  description:
    "Edge cloud and CDN. Track spend by product, chart requests, bandwidth, cache hit ratio and errors per service, purge cache, activate versions, and manage services, domains, backends, logging, stores, TLS certificates and API tokens.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description:
        "A Fastly API token. global:read browses and shows costs, purge_all adds purging, and global also activates versions and edits stores. Cost data needs a token whose owner has the Billing or Superuser role.",
      sensitive: true,
      placeholder: "32-character token",
      helpLink: {
        label: "Create an API token",
        url: "https://manage.fastly.com/account/personal/tokens",
      },
    },
    caCertCredentialField,
  ],
  costs: {
    // Invoices API: product → service, the invoice region → region, and the
    // product line and group as tags. Monthly only, dated to the 1st: posted
    // invoices for closed months, the month-to-date estimate for the current
    // one (restated in place until the invoice replaces it).
    dimensions: ["service", "region", "tag"],
    maxHistoryDays: 730,
    periodNative: true,
    chargeTypes: true,
    // The smallest window that always contains the 1st of both the current
    // and the previous month, so the running month is re-read on every pass
    // and last month's invoice is picked up once it posts.
    restatementDays: 62,
  },
  preflight: FASTLY_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new FastlyClient(credentials, services),
  parseStatusFeed,
  policyTemplate: fastlyPolicyTemplate,
};
