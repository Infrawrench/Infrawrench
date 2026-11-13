import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { UPCLOUD_PREFLIGHT, UpCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { upcloudRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resources.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { upcloudTerraformExport } from "./terraform.js";
import { UPCLOUD_CI_EXECUTOR } from "./ci-executor.js";

export const manifest = {
  id: "upcloud",
  egressHosts: ["api.upcloud.com"],
  displayName: "UpCloud",
  description:
    "UpCloud: billed spend per resource from the monthly billing summary, prepaid credits, account limits, and servers, storage and backups, templates, private networks and routers, floating IPs, Managed Kubernetes, Managed Databases, Managed Load Balancers and Managed Object Storage.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiToken",
      label: "API Token",
      description:
        "Create a token in the UpCloud Control Panel under Account, API Tokens (it is shown once and lasts up to 365 days). Leave empty to sign in with an API user below instead.",
      sensitive: true,
      optional: true,
      placeholder: "ucat_…",
      helpLink: {
        label: "How to create an API token",
        url: "https://upcloud.com/docs/guides/managing-api-tokens/",
      },
    },
    {
      key: "username",
      label: "API Username",
      description:
        "A user with API access, created in the Hub under People (tick Allow API connections). Give it the Billing role for costs. Not needed with a token.",
      sensitive: false,
      optional: true,
      placeholder: "api-infrawrench",
    },
    {
      key: "password",
      label: "API Password",
      description: "The API user's password. Not needed with a token.",
      sensitive: true,
      optional: true,
    },
    caCertCredentialField,
  ]),
  /**
   * Billed spend from `/account/billing/summary/{YYYY-MM}`: month totals per
   * resource, dated to the 1st (period-native), restated while the month is
   * open. `restatementDays: 62` keeps the previous month's 1st in every
   * incremental window.
   */
  costs: {
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 62,
    periodNative: true,
  },
  credits: { label: "Prepaid credits", topUpUrl: "https://hub.upcloud.com/billing" },
  quotas: {
    label: "Account limits",
    increaseUrl: "https://hub.upcloud.com/support",
    partial: true,
  },
  preflight: UPCLOUD_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 5 },
  // CI jobs on a fresh machine per job. See ci-executor.ts.
  ciExecutor: UPCLOUD_CI_EXECUTOR,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new UpCloudClient(credentials, RESOURCE_TYPES, services),
  testCredentials: { apiToken: "ucat_01TESTTOKEN0000000000000000", username: "", password: "" },
  terraformExport: upcloudTerraformExport,
  parseStatusFeed,
  remediationCommands: upcloudRemediationCommands,
});
