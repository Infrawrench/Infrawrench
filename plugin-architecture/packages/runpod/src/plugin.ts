import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { RunpodClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { runpodRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { runpodTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "runpod",
  version: "0.1.0",
  displayName: "Runpod",
  description:
    "GPU cloud. Pods with start, stop, restart and SSH, Serverless endpoints with queue health, templates, network volumes, registry credentials and SSH keys, plus billed spend, balance, savings plans and account limits.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Runpod API key, from the console's Settings, API Keys, Create API Key (console.runpod.io/user/settings). Choose All permission to manage resources; a Read Only key lists everything and reads billing but cannot create, change or delete.",
      sensitive: true,
      placeholder: "rpa_…",
      helpLink: {
        label: "Manage Runpod API keys",
        url: "https://docs.runpod.io/get-started/api-keys",
      },
    },
    caCertCredentialField,
  ],
  /**
   * Billed spend from Runpod's REST billing history: per-pod and
   * per-Serverless-endpoint charges plus network storage, bucketed by day in
   * USD. Recent days can still move while a pod is running, so a short
   * restatement window absorbs them.
   */
  costs: {
    dimensions: ["service", "region", "resource"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
  commitments: { kinds: ["savings_plan"] },
  credits: {
    label: "Runpod balance",
    topUpUrl: "https://console.runpod.io/user/billing",
  },
  quotas: {
    label: "Runpod limits",
    increaseUrl: "https://console.runpod.io/user/billing",
    partial: true,
  },
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new RunpodClient(credentials, RESOURCE_TYPES, services),
  terraformExport: runpodTerraformExport,
  remediationCommands: runpodRemediationCommands,
  parseStatusFeed,
};
