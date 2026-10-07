import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { VastClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { vastRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";

const manifest: PluginManifest = {
  id: "vast-ai",
  version: "0.1.0",
  displayName: "Vast.ai",
  description:
    "GPU marketplace. Rent instances from a live offer search, start, stop, reboot and rebid them, and manage templates, volumes, SSH keys, Serverless endpoints and account environment variables, plus billed charges and credit.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Vast.ai API key, from the console's Keys page (cloud.vast.ai/manage-keys), +New. The default full-access key covers everything; a scoped key needs instance_read/write, user_read/write, misc and billing_read.",
      sensitive: true,
      placeholder: "",
      helpLink: { label: "Vast.ai API keys", url: "https://cloud.vast.ai/manage-keys/" },
    },
    caCertCredentialField,
  ],
  /**
   * Billed spend from Vast's per-contract charges (GPU, storage, bandwidth,
   * volumes), allocated to days by each charge item's time span.
   */
  costs: {
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
  credits: {
    label: "Vast.ai credit",
    topUpUrl: "https://cloud.vast.ai/billing/",
  },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new VastClient(credentials, RESOURCE_TYPES, services),
  remediationCommands: vastRemediationCommands,
};
