import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { LambdaCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "lambda-cloud",
  version: "0.1.0",
  displayName: "Lambda Cloud",
  description:
    "GPU cloud. On-demand instances with live capacity and price pickers, launch, restart and terminate, persistent filesystems, firewall rulesets and SSH keys.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Lambda Cloud API key, from the Lambda Cloud dashboard's API keys page (cloud.lambda.ai/api-keys), Generate API key. Keys are team-wide and carry full access; Lambda shows the key only once.",
      sensitive: true,
      placeholder: "secret_…",
      helpLink: { label: "Lambda Cloud API keys", url: "https://cloud.lambda.ai/api-keys" },
    },
    caCertCredentialField,
  ],
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) =>
    new LambdaCloudClient(credentials, RESOURCE_TYPES, services),
  parseStatusFeed,
};
