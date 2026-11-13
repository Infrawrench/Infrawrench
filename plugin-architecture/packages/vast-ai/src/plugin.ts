import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { VAST_CI_EXECUTOR } from "./ci-executor.js";
import { VastClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { vastRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";

export const manifest = {
  id: "vast-ai",
  egressHosts: ["console.vast.ai"],
  displayName: "Vast.ai",
  description:
    "GPU marketplace. Rent instances from a live offer search, start, stop, reboot and rebid them, and manage templates, volumes, SSH keys, Serverless endpoints and account environment variables, plus billed charges and credit.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
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
  ]),
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
  // CI jobs run in a rented instance (`cloud: vast-ai/container`). See `ci-executor.ts`.
  ciExecutor: VAST_CI_EXECUTOR,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new VastClient(credentials, RESOURCE_TYPES, services),
  testCredentials: { apiKey: "test-vast-key" },
  remediationCommands: vastRemediationCommands,
});
