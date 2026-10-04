import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { DatadogClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { DATADOG_PREFLIGHT, datadogPolicyTemplate } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { DEFAULT_SITE_ID, SITE_REGIONS } from "./sites.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { datadogTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "datadog",
  version: "0.1.0",
  displayName: "Datadog",
  description:
    "Monitoring and observability. Track Datadog spend by product and organization with month-end projections and cost attribution by tag, chart hourly usage, and manage monitors, downtimes, dashboards, SLOs, synthetic tests, hosts, users and API and application keys.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "site",
      label: "Datadog Site",
      description:
        "The Datadog site your organization lives on: the one in the address you sign in at (app.datadoghq.com is US1, app.datadoghq.eu is EU, us5.datadoghq.com is US5). Keys only work against their own site.",
      sensitive: false,
      optional: true,
      defaultValue: DEFAULT_SITE_ID,
      regions: SITE_REGIONS,
      helpLink: {
        label: "Find your Datadog site",
        url: "https://docs.datadoghq.com/getting_started/site/",
      },
    },
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Datadog API key from Organization Settings, API Keys. It identifies the organization. For cost data, use a key from the parent organization: child organizations cannot read cost.",
      sensitive: true,
      placeholder: "32 hexadecimal characters",
      helpLink: {
        label: "Manage API keys",
        url: "https://app.datadoghq.com/organization-settings/api-keys",
      },
    },
    {
      key: "appKey",
      label: "Application Key",
      description:
        "A Datadog application key from Organization Settings, Application Keys (or Personal Settings for your own). It carries its owner's permissions. Cost data needs Usage Read and Billing Read; to keep the account read-only, create a scoped key with only the read scopes listed under Check credentials.",
      sensitive: true,
      placeholder: "40 hexadecimal characters",
      helpLink: {
        label: "Manage application keys",
        url: "https://app.datadoghq.com/organization-settings/application-keys",
      },
    },
    caCertCredentialField,
  ],
  costs: {
    // Usage Metering cost endpoints: product → service, the Datadog region →
    // region, and the sub-organization and pricing model (committed vs
    // on-demand) as the `org` and `pricing` tags. Daily for the current and
    // previous month (estimated, differenced from month-to-date totals), and
    // finalised monthly totals dated to the 1st before that. Datadog keeps
    // 15 months of cost history.
    dimensions: ["service", "region", "tag"],
    maxHistoryDays: 450,
    // Estimated cost lags up to 72 hours and is revised while the month is
    // open. 35 days re-reads most of the previous month every pass and can
    // never contain a whole month older than the estimated window, which is
    // what keeps a month from being filed both daily and as a monthly total
    // (see `cost-data.ts`).
    restatementDays: 35,
  },
  preflight: DATADOG_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 1 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new DatadogClient(credentials, services),
  parseStatusFeed,
  policyTemplate: datadogPolicyTemplate,
  terraformExport: datadogTerraformExport,
};
