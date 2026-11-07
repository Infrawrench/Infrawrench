import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { KoyebClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { koyebRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { koyebTerraformExport } from "./terraform.js";
import { koyebDeployEvents } from "./deploy-events.js";

export const manifest = {
  id: "koyeb",
  egressHosts: ["app.koyeb.com"],
  displayName: "Koyeb",
  description:
    "Serverless platform. Manage apps, web services, workers and Postgres databases with deployments, rollbacks, scaling, pause and resume, plus secrets, domains, volumes and snapshots, with logs, metrics, the current invoice, quotas and a spending alert.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiToken",
      label: "API Access Token",
      description:
        "An organization API access token from the Koyeb control panel, Settings, API, Create API access token. It is scoped to that organization and has full access to it.",
      sensitive: true,
      placeholder: "Paste the token Koyeb shows once",
      helpLink: { label: "Open Koyeb API settings", url: "https://app.koyeb.com/settings/api" },
    },
    caCertCredentialField,
  ]),
  costs: {
    dimensions: ["service"],
    periodNative: true,
    restatementDays: 62,
    maxHistoryDays: 62,
    chargeTypes: true,
  },
  quotas: {
    label: "Koyeb organization quotas",
    increaseUrl: "https://app.koyeb.com/settings/plans",
  },
  statusFeed,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  deployEvents: koyebDeployEvents,
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new KoyebClient(credentials, RESOURCE_TYPES, services),
  testCredentials: { apiToken: "test-token" },
  parseStatusFeed,
  terraformExport: koyebTerraformExport,
  remediationCommands: koyebRemediationCommands,
});
