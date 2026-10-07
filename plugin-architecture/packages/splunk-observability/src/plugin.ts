import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { REALMS } from "./api.js";
import { SplunkObservabilityClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { SPLUNK_PREFLIGHT } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { splunkTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "splunk-observability",
  version: "0.1.0",
  displayName: "Splunk Observability Cloud",
  description:
    "Infrastructure monitoring, APM and synthetics from Splunk. Manage detectors, alerts, muting rules, dashboards and charts, teams, members, integrations, access tokens, SLOs and synthetic tests, chart any detector or chart's SignalFlow, and track usage against your organization's limits.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "realm",
      label: "Realm",
      description:
        "Your organization's realm. It is in the app address (app.<realm>.observability.splunkcloud.com) and under your profile, Organizations.",
      sensitive: false,
      defaultValue: "us0",
      regions: REALMS.map((r) => ({ id: r.id, label: r.label, location: r.location })),
    },
    {
      key: "token",
      label: "API Access Token",
      description:
        "An organization access token with the API scope. In Splunk Observability Cloud open Settings, Access Tokens, New Token, choose API token and the power role (read_only lists without editing). Managing access tokens, members and integrations needs a token tied to an admin: use an admin's user API access token from your profile instead.",
      sensitive: true,
      placeholder: "AbCdEf123…",
      helpLink: {
        label: "Create an access token",
        url: "https://help.splunk.com/en/splunk-observability-cloud/administer/authentication-and-security/authentication-tokens/org-access-tokens",
      },
    },
    caCertCredentialField,
  ],
  quotas: {
    label: "Organization limits",
    partial: true,
  },
  preflight: SPLUNK_PREFLIGHT,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new SplunkObservabilityClient(credentials, services),
  terraformExport: splunkTerraformExport,
};
