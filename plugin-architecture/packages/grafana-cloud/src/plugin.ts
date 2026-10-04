import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { GrafanaCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { GRAFANA_PREFLIGHT, grafanaPolicyTemplate } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { grafanaCloudTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "grafana-cloud",
  version: "0.1.0",
  displayName: "Grafana Cloud",
  description:
    "Hosted Grafana, metrics, logs, traces and profiles. Track Grafana Cloud spend by product and stack from billed usage, chart each stack's active series and ingest, and manage stacks, installed plugins, access policies and tokens, members, and each connected stack's dashboards, alert rules, contact points, data sources and synthetic checks.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "token",
      label: "Access Policy Token",
      description:
        "A Grafana Cloud access policy token (glc_…). Create an access policy for your organization in the Grafana Cloud portal under Security, Access policies, give it the scopes listed under Check credentials (orgs:read and stacks:read at minimum), then add a token to it.",
      sensitive: true,
      placeholder: "glc_…",
      helpLink: {
        label: "Create an access policy",
        url: "https://grafana.com/docs/grafana-cloud/security-and-account-management/authentication-and-permissions/access-policies/create-access-policies/",
      },
    },
    {
      key: "orgSlug",
      label: "Organization Slug",
      description:
        "Leave blank: the organization is read from the token. Only needed if Infrawrench says it cannot tell; it is the part after grafana.com/orgs/ in your portal address.",
      sensitive: false,
      optional: true,
      placeholder: "acme",
    },
    caCertCredentialField,
  ],
  costs: {
    // Billed usage per month (`/api/orgs/{org}/billed-usage`): product →
    // service, stack → resource and the `stack` tag, the stack's region →
    // region. Monthly totals dated to the 1st (period-native); the current
    // month is month to date. 62 restatement days always reach back to the
    // previous month's 1st, so a month is re-read until well after it closes.
    // Grafana keeps 12 months of billed usage.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 62,
    periodNative: true,
  },
  preflight: GRAFANA_PREFLIGHT,
  statusFeed,
  // The access policy routes allow 600 requests an hour per org.
  rateLimit: { capacity: 10, refillPerSecond: 0.5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new GrafanaCloudClient(credentials, services),
  parseStatusFeed,
  policyTemplate: grafanaPolicyTemplate,
  terraformExport: grafanaCloudTerraformExport,
};
