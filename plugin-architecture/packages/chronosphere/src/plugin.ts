import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ChronosphereClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { CHRONO_PREFLIGHT } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { chronosphereTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "chronosphere",
  version: "0.1.0",
  displayName: "Chronosphere",
  description:
    "Cloud-native observability platform, now Cortex XCOR. Manage monitors, notification policies, notifiers, collections, buckets, teams, dashboards, SLOs, rollup, drop and recording rules, muting rules and service accounts, and chart or run PromQL against your tenant.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "org",
      label: "Organization",
      description:
        "Your tenant name: the <org> in https://<org>.chronosphere.io. Pasting the whole address works too.",
      sensitive: false,
      placeholder: "acme",
    },
    {
      key: "apiToken",
      label: "API Token",
      description:
        "A service account token (recommended) or a personal access token. In Chronosphere select Go to Admin, then Platform, Service Accounts, + Service Account, choose Unrestricted and copy the token, which is shown once. A restricted (telemetry-only) account can only run PromQL.",
      sensitive: true,
      placeholder: "chronosphere token",
    },
    caCertCredentialField,
  ],
  preflight: CHRONO_PREFLIGHT,
  rateLimit: { capacity: 10, refillPerSecond: 3 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new ChronosphereClient(credentials, services),
  terraformExport: chronosphereTerraformExport,
};
