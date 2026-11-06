import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ChronosphereClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { CHRONO_PREFLIGHT } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { chronosphereTerraformExport } from "./terraform.js";

export const manifest = {
  id: "chronosphere",
  // Each tenant is <org>.chronosphere.io (config API and Prometheus API on the same host).
  egressHosts: ["*.chronosphere.io"],
  displayName: "Chronosphere",
  description:
    "Cloud-native observability platform, now Cortex XCOR. Manage monitors, notification policies, notifiers, collections, buckets, teams, dashboards, SLOs, rollup, drop and recording rules, muting rules and service accounts, and chart or run PromQL against your tenant.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
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
  ]),
  preflight: CHRONO_PREFLIGHT,
  rateLimit: { capacity: 10, refillPerSecond: 3 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new ChronosphereClient(credentials, services),
  testCredentials: { org: "acme", apiToken: "chrono-test-token" },
  terraformExport: chronosphereTerraformExport,
});
