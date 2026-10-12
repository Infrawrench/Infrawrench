import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { resolveHost } from "./api.js";
import { GitHubClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { listOwnerOptions } from "./owners.js";
import { GITHUB_PREFLIGHT, githubPolicyTemplate } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { githubRemediationCommands } from "./remediation.js";
import { GITHUB_OAUTH, completeGitHubOAuth, validateOAuthHost } from "./oauth.js";

const manifest: PluginManifest = {
  id: "github",
  version: "0.1.0",
  displayName: "GitHub",
  description:
    "GitHub billing and spend. Track Actions, Copilot, Codespaces, Packages, Git LFS and Advanced Security cost by product, SKU, repository and cost centre, chart Actions minutes and Copilot activity, and manage Copilot seats, runners, caches, codespaces, budgets and cost centres.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "token",
      label: "Personal Access Token",
      description:
        "For an organization, a fine-grained token with the organization as resource owner and the permissions listed under Check credentials. For an enterprise, a classic token with manage_billing:enterprise. The owner must be an owner or billing manager.",
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
        "Whose bill to read, from the organizations and enterprises the token can see. Runners, caches and codespaces are listed per organization.",
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
  // Open Dependabot alerts across the owner's repositories, one owner-wide
  // listing. Needs owner or security manager plus the Dependabot alerts
  // permission, which the billing-focused token does not carry by default;
  // bounded at 5,000 alerts. See `vulnerabilities.ts`.
  vulnerabilities: {
    label: "Dependabot",
    consoleUrl:
      "https://docs.github.com/en/code-security/dependabot/dependabot-alerts/configuring-dependabot-alerts",
    requiresElevatedCredential: true,
    partial: true,
  },
  preflight: GITHUB_PREFLIGHT,
  secretScanning: {
    label: "Secret scanning",
    description:
      "Reads the organization's secret scanning alerts every 30 minutes. The token needs Secret scanning alerts (read, or read and write to close alerts after a rotation) and an organization owner or security manager. Enterprise accounts have no organization-wide alert list.",
    canResolve: true,
    returnsSecretValue: true,
  },
  tokenFormats: [
    {
      id: "personal-access-token",
      label: "GitHub personal access token",
      scannerTypes: [
        "github_personal_access_token",
        "github_oauth_access_token",
        "Github Personal Access Token",
        "GithubFineGrainedPersonalAccessToken",
        "Github OAuth Access Token",
      ],
      prefixes: ["github_pat_", "ghp_", "gho_"],
      credentialFields: ["token"],
      manageUrl: "https://github.com/settings/personal-access-tokens",
    },
  ],
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 1 },
  oauth: GITHUB_OAUTH,
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
      return validateOAuthHost(credentials);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },
  remediationCommands: githubRemediationCommands,
  completeOAuthConnection: completeGitHubOAuth,
};
