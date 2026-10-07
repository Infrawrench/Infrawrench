import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { normaliseEndpoint } from "./api.js";
import { SpaceliftClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { spaceliftTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "spacelift",
  version: "0.1.0",
  displayName: "Spacelift",
  description:
    "Spacelift infrastructure orchestration. Manage spaces, stacks and their outputs, trigger, confirm, discard and stop runs with phase logs, set up drift detection and scheduled runs, and manage contexts, policies, modules and worker pools.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "endpoint",
      label: "Account",
      description:
        "Your Spacelift account name (acme for acme.app.spacelift.io), the hostname for the US region (acme.app.us.spacelift.io) or a self-hosted install, or the full GraphQL URL.",
      sensitive: false,
      placeholder: "acme",
    },
    {
      key: "apiKeyId",
      label: "API Key ID",
      description:
        "Organization settings, API keys, Create API key, type Secret. Give it the spaces it should manage (admin on root manages everything). The 26-character ID is in the file Spacelift downloads. API keys are billed as users while they are in use.",
      sensitive: false,
      placeholder: "01HXXXXXXXXXXXXXXXXXXXXXXX",
      helpLink: {
        label: "Spacelift API keys",
        url: "https://docs.spacelift.io/integrations/api#spacelift-api-key",
      },
    },
    {
      key: "apiKeySecret",
      label: "API Key Secret",
      description:
        "The api_key_secret value from the downloaded file. Spacelift does not show it again.",
      sensitive: true,
      placeholder: "api_key_secret value",
    },
    caCertCredentialField,
  ],
  quotas: { label: "Plan run minutes", partial: true },
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 5 },
};

/** The cloud host must not send the key to a private address someone typed in. */
function validateServerCredentials(credentials: Record<string, string>): string | null {
  let host: string;
  try {
    host = new URL(normaliseEndpoint(credentials["endpoint"])).hostname;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host === "localhost" ||
    /\.(localhost|local|internal)$/.test(host)
  ) {
    return "The Spacelift endpoint is a private address. Infrawrench cloud only connects to public hostnames; use the desktop app or a bastion for a private install.";
  }
  return null;
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new SpaceliftClient(credentials, services),
  parseStatusFeed,
  validateServerCredentials,
  terraformExport: spaceliftTerraformExport,
};
