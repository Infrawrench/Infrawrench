import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { CrusoeClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { crusoeTerraformExport } from "./terraform.js";
import { crusoeRemediationCommands } from "./remediation.js";

const API_KEYS_HELP = {
  label: "Manage Crusoe API keys",
  url: "https://docs.cloud.crusoe.ai/identity-and-security/managing-api-keys",
};

const manifest: PluginManifest = {
  id: "crusoe",
  version: "0.1.0",
  displayName: "Crusoe Cloud",
  description:
    "GPU cloud. Track billed Crusoe spend by product line, project, region and resource, follow credits, reservations and quotas, and manage VMs, disks, snapshots, VPC networks, subnets, firewall rules, managed Kubernetes clusters and node pools, load balancers and SSH keys.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessKeyId",
      label: "Access Key",
      description:
        "A Crusoe Cloud API access key, from the console's Security tab, Tokens, Generate token. The key acts as the user who created it and sees every organization and project that user belongs to.",
      sensitive: false,
      placeholder: "",
      helpLink: API_KEYS_HELP,
    },
    {
      key: "secretKey",
      label: "Secret Key",
      description:
        "The secret key shown once next to the access key. Billing data, credits and quotas need a key created by a user with the organization's admin or billing role.",
      sensitive: true,
      placeholder: "",
      helpLink: API_KEYS_HELP,
    },
    {
      key: "monitoringToken",
      label: "Monitoring Token (optional)",
      description:
        "A Crusoe monitoring token for the VM metrics API (`crusoe monitoring tokens create`). Leave blank to sign metrics requests with the access key instead.",
      sensitive: true,
      optional: true,
      placeholder: "",
    },
    caCertCredentialField,
  ],
  /**
   * Billed spend from Crusoe's own billing export: on-demand and spot costs
   * per resource (the console's Billing page) plus Intelligence Billing for
   * serverless inference. Crusoe keeps this data from 2025-05-01; reserved
   * instance purchases and tax are not part of it (reservations are reported
   * separately as commitments). Usage is finalised daily shortly after
   * midnight UTC, so a short restatement window absorbs late rows.
   */
  costs: {
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 400,
    restatementDays: 4,
  },
  commitments: { kinds: ["reservation"] },
  credits: {
    label: "Crusoe credits",
    topUpUrl: "https://console.crusoecloud.com/billing",
    requiresElevatedCredential: true,
  },
  quotas: {
    label: "Crusoe quotas",
    increaseUrl: "https://docs.cloud.crusoe.ai/usage-billing/viewing-quotas",
    partial: false,
  },
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new CrusoeClient(credentials, RESOURCE_TYPES, services),
  terraformExport: crusoeTerraformExport,
  remediationCommands: crusoeRemediationCommands,
  parseStatusFeed,
};
