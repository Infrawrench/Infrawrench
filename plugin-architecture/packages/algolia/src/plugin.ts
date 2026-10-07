import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { AlgoliaClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { algoliaTerraformExport } from "./terraform.js";

/**
 * No `costs`: Algolia publishes no billing or invoice API. The Usage API
 * reports operations and records, not money, and plans price them
 * differently, so no rate would make a cost series correct.
 */
const manifest: PluginManifest = {
  id: "algolia",
  version: "0.1.0",
  displayName: "Algolia",
  description:
    "Hosted search. Manage indices and their settings (searchable attributes, ranking, facets, typos, languages, replicas, full settings JSON), copy, move and clear indices, API keys with ACL pickers, A/B tests and crawlers. Synonym and rule counts, API logs, usage, search analytics and cluster latency as metrics, and Algolia's cluster status.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "appId",
      label: "Application ID",
      description: "In the Algolia dashboard open Settings, API Keys, and copy the Application ID.",
      sensitive: false,
      placeholder: "ABC123XYZ9",
      helpLink: {
        label: "Open API Keys in the Algolia dashboard",
        url: "https://dashboard.algolia.com/account/api-keys",
      },
    },
    {
      key: "apiKey",
      label: "Admin API Key",
      description:
        "The Admin API key from the same page. Listing and editing API keys needs the admin key; a key with listIndexes, settings, editSettings, deleteIndex, addObject, analytics and logs ACLs covers everything else.",
      sensitive: true,
      placeholder: "32-character admin key",
    },
    {
      key: "usageApiKey",
      label: "Usage API Key (optional)",
      description:
        "From Settings, API Keys, under the Usage section. Adds search and write operations, records, data size, processing time, QPS and search capacity charts.",
      sensitive: true,
      optional: true,
    },
    {
      key: "monitoringApiKey",
      label: "Monitoring API Key (optional)",
      description:
        "From Settings, API Keys, under the Monitoring section (plans with monitoring). Adds the clusters the application runs on, per-cluster search latency and indexing time, and ties status incidents to this application.",
      sensitive: true,
      optional: true,
    },
    {
      key: "analyticsRegion",
      label: "Analytics Region (optional)",
      description:
        "Where the application's analytics are stored (United States or Germany), chosen when the application was created. Leave empty to let Algolia route the request.",
      sensitive: false,
      optional: true,
      advanced: true,
      regions: [
        { id: "us", label: "United States", location: "analytics.us.algolia.com" },
        { id: "de", label: "Germany (EU)", location: "analytics.de.algolia.com" },
      ],
    },
    {
      key: "crawlerUserId",
      label: "Crawler User ID (optional)",
      description:
        "In the Crawler admin (crawler.algolia.com) open Settings and copy the Crawler User ID, to manage crawlers.",
      sensitive: false,
      optional: true,
      advanced: true,
    },
    {
      key: "crawlerApiKey",
      label: "Crawler API Key (optional)",
      description: "The Crawler API Key from the same Crawler settings page.",
      sensitive: true,
      optional: true,
      advanced: true,
    },
    caCertCredentialField,
  ],
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new AlgoliaClient(credentials, RESOURCE_TYPES, services),
  parseStatusFeed: (body) => parseStatusFeed(body),
  terraformExport: algoliaTerraformExport,
};
