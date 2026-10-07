import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { HoneycombClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { HONEYCOMB_PREFLIGHT } from "./preflight.js";
import { DEFAULT_REGION_ID, REGION_PICKER } from "./regions.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { honeycombTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "honeycomb",
  version: "0.1.0",
  displayName: "Honeycomb",
  description:
    "Observability for distributed systems. Manage Honeycomb environments, datasets and their settings, columns, derived columns, triggers, SLOs and burn alerts, boards, markers, recipients and API keys, and chart event volume, latency, error rate and SLO compliance through the Query Data API.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "region",
      label: "Region",
      description:
        "Where your Honeycomb team lives: US if you sign in at ui.honeycomb.io, EU if at ui.eu1.honeycomb.io. Keys only work in their own region.",
      sensitive: false,
      optional: true,
      defaultValue: DEFAULT_REGION_ID,
      regions: REGION_PICKER,
    },
    {
      key: "managementKeyId",
      label: "Management Key ID",
      description:
        "Optional, but needed to list every environment and manage API keys. Create one in Honeycomb under Team Settings, API Keys, Management Keys, with the environments:read, environments:write, api-keys:read and api-keys:write scopes (read-only scopes give a read-only account). You can paste the joined id:secret value here.",
      sensitive: false,
      optional: true,
      placeholder: "hcxmk_01…",
      helpLink: {
        label: "Manage team API keys",
        url: "https://docs.honeycomb.io/configure/teams/manage-api-keys/",
      },
    },
    {
      key: "managementKeySecret",
      label: "Management Key Secret",
      description: "The secret shown once when the management key is created.",
      sensitive: true,
      optional: true,
      placeholder: "32 characters",
    },
    {
      key: "configurationKey",
      label: "Configuration Key",
      description:
        "Optional with a management key, required without one. A configuration key from Environment Settings, API Keys, for one environment. Give it Manage Queries and Columns, Run Queries, Manage Triggers, Manage SLOs, Manage Public Boards, Manage Markers and Manage Recipients. Other environments can be connected later from their own page.",
      sensitive: true,
      optional: true,
      placeholder: "22 characters",
      helpLink: {
        label: "Manage environment API keys",
        url: "https://docs.honeycomb.io/configure/environments/manage-api-keys/",
      },
    },
    caCertCredentialField,
  ],
  preflight: HONEYCOMB_PREFLIGHT,
  statusFeed,
  // Query results are limited to 10 runs a minute per key; listing fans out
  // per dataset, so keep the bucket modest.
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new HoneycombClient(credentials, services),
  parseStatusFeed,
  terraformExport: honeycombTerraformExport,
};
