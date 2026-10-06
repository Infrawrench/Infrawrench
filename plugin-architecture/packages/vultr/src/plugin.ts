import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { VultrClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { VULTR_PREFLIGHT } from "./preflight.js";
import { RESOURCE_TYPES } from "./resources.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { vultrTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "vultr",
  version: "0.1.0",
  displayName: "Vultr",
  description:
    "Vultr cloud: billed spend from invoices and month-to-date charges, account credit, and instances, bare metal, block storage, snapshots, backups, Kubernetes (VKE), Managed Databases, load balancers, firewall groups, VPCs, reserved IPs, DNS, Object Storage, SSH keys and startup scripts.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "In the Vultr customer portal open Account, then API (under Other), and enable the API to get a key. The key has its user's permissions, so use the account owner or a user with the permissions you want Infrawrench to have (Billing is needed for costs). Under Access Control, allow the address Infrawrench connects from.",
      sensitive: true,
      placeholder: "36 uppercase letters and digits",
      helpLink: { label: "Open API settings", url: "https://my.vultr.com/settings/#settingsapi" },
    },
    caCertCredentialField,
  ],
  /**
   * Billed spend: closed invoices' line items spread over the days they
   * cover, plus the open month from pending charges. See `cost-data.ts`.
   * `restatementDays: 62` keeps the previous month inside every incremental
   * window so its invoice replaces the month-to-date estimate.
   */
  costs: {
    dimensions: ["service"],
    maxHistoryDays: 365,
    restatementDays: 62,
    chargeTypes: true,
  },
  credits: {
    label: "Account credit",
    topUpUrl: "https://my.vultr.com/billing/",
  },
  preflight: VULTR_PREFLIGHT,
  statusFeed,
  // Vultr allows 30 requests per second per key; listers fan out at most 6 wide.
  rateLimit: { capacity: 30, refillPerSecond: 20 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new VultrClient(credentials, RESOURCE_TYPES, services),
  terraformExport: vultrTerraformExport,
  parseStatusFeed,
};
