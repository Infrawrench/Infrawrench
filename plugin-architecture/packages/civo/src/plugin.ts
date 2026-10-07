import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { CIVO_PREFLIGHT, CivoClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { civoRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resources.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { civoTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "civo",
  version: "0.1.0",
  displayName: "Civo",
  description:
    "Civo cloud: instances, volumes and snapshots, Kubernetes (K3s and Talos) with node pools and marketplace apps, managed MySQL and PostgreSQL with backups, load balancers, firewalls, networks, reserved IPs, DNS, Object Stores with a bucket browser, SSH keys, and account quotas.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "In the Civo dashboard click your account name, then Profile, then Security, and under API Keys create a key (it is shown once). A key has full access to the account, so every region is reached with the same key.",
      sensitive: true,
      placeholder: "50 letters and digits",
      helpLink: {
        label: "Open Civo security settings",
        url: "https://dashboard.civo.com/security",
      },
    },
    caCertCredentialField,
  ],
  quotas: {
    label: "Civo quota",
    increaseUrl: "https://dashboard.civo.com/quota/edit",
    partial: false,
  },
  preflight: CIVO_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new CivoClient(credentials, RESOURCE_TYPES, services),
  terraformExport: civoTerraformExport,
  parseStatusFeed: (body) => parseStatusFeed(body),
  remediationCommands: civoRemediationCommands,
};
