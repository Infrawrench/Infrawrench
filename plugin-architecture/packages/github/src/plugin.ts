import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { resolveHost } from "./api.js";
import { GitHubClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { listOwnerOptions } from "./owners.js";
import { GITHUB_PREFLIGHT, githubPolicyTemplate } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "github",
  version: "0.1.0",
  displayName: "GitHub",
  description:
    "GitHub billing and spend. Track Actions, Copilot, Codespaces, Packages, Git LFS and Advanced Security cost by product, SKU, repository and cost centre with discounts, chart Actions minutes, Copilot activity and premium requests, and manage Copilot seats, larger and self-hosted runners, Actions caches, codespaces, budgets and cost centres.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "token",
      label: "Personal Access Token",
      description:
        "For an organization, a fine-grained token with the organization as resource owner and the permissions listed under Check credentials. For an enterprise, a classic token with manage_billing:enterprise (fine-grained tokens cannot reach enterprise endpoints). The token's owner must be an owner or billing manager.",
      sensitive: true,
      placeholder: "github_pat_… or ghp_…",
      helpLink: {
        label: "Create a fine-grained token",
        url: "https://github.com/settings/personal-access-tokens/new",
      },
    },
    {
      key: "host",
      label: "GitHub Host",
      description:
        "github.com, or for GitHub Enterprise Cloud with data residency the address you sign in at, such as octocorp.ghe.com.",
      sensitive: false,
      defaultValue: "github.com",
      placeholder: "github.com",
    },
    {
      key: "owner",
      label: "Organization or Enterprise",
      description:
        "Whose bill to read. Pick from the organizations and enterprises the token can see. Enterprise accounts cover billing, budgets, cost centres, Copilot seats and larger runners; runners, caches and codespaces are listed per organization.",
      sensitive: false,
      placeholder: "octo-org or enterprise:octo-enterprise",
      providerOptions: { dependsOn: ["token", "host"] },
    },
    caCertCredentialField,
  ],
  costs: {
    // The usage report: dated line items with gross, discount and net, by
    // product (service), repository (resource) and SKU / organization / cost
    // centre (tags). Gross is written as usage and the discount as a credit,
    // so charge types are meaningful.
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 4,
    chargeTypes: true,
  },
  preflight: GITHUB_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 1 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new GitHubClient(credentials, services),
  parseStatusFeed,
  policyTemplate: githubPolicyTemplate,
  listCredentialOptions: async (fieldKey, credentials, services) => {
    if (fieldKey !== "owner") throw new Error(`GitHub plugin: "${fieldKey}" has no choices`);
    return listOwnerOptions(credentials, services);
  },
  validateServerCredentials: (credentials) => {
    try {
      resolveHost(credentials["host"]);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },
};
