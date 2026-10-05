import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { RedisCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { redisCloudTerraformExport } from "./terraform.js";
import { redisCloudRemediationCommands } from "./remediation.js";

const manifest: PluginManifest = {
  id: "redis-cloud",
  version: "0.1.0",
  displayName: "Redis Cloud",
  description:
    "Manage Redis Cloud Pro and Essentials: subscriptions, databases (resize, alerts, backup, import, version upgrades), ACL rules, roles and users, VPC peering, Transit Gateway and Private Service Connect. Billed cost by subscription and database from the FOCUS cost report, and a Redis console and key browser for every database.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accountKey",
      label: "Account Key",
      description:
        "The account key from Access Management, API Keys in the Redis Cloud console (enable the API there first). It identifies the Redis Cloud account.",
      sensitive: true,
      placeholder: "A1b2C3d4...",
      helpLink: {
        label: "Enable the API and create keys",
        url: "https://redis.io/docs/latest/operate/rc/api/get-started/enable-the-api/",
      },
    },
    {
      key: "userKey",
      label: "User Key",
      description:
        "A user key (API secret) from the same page. It carries its owner's role: cost data needs Owner, Viewer or Billing admin, and changes need Owner. If the key has a CIDR allow list, include this server's address.",
      sensitive: true,
      placeholder: "S9t8U7v6...",
      helpLink: {
        label: "Manage API keys",
        url: "https://redis.io/docs/latest/operate/rc/api/get-started/manage-api-keys/",
      },
    },
  ],
  costs: {
    // FOCUS cost report: service = tier (Pro / Essentials, network and
    // minimum-charge lines apart), region, resource = the database or
    // subscription id, tags = the database's own tags plus resourceType and
    // resourceName. Monthly network lines take up to 72 hours to land.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 5,
    chargeTypes: true,
  },
  statusFeed,
  // Documented limit: 400 requests per minute per key.
  rateLimit: { capacity: 20, refillPerSecond: 6 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new RedisCloudClient(credentials, services),
  parseStatusFeed: (body: string) => parseStatusFeed(body),
  terraformExport: redisCloudTerraformExport,
  remediationCommands: redisCloudRemediationCommands,
};
