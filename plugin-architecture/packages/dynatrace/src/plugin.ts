import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { DynatraceClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { DYNATRACE_PREFLIGHT, dynatracePolicyTemplate } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { dynatraceTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "dynatrace",
  version: "0.1.0",
  displayName: "Dynatrace",
  description:
    "Full-stack observability. Browse hosts, services, process groups, web applications and Kubernetes clusters with their metrics and logs, triage problems, manage SLOs, synthetic monitors, alerting profiles, maintenance windows and access tokens, run DQL against Grail, and track platform subscription cost.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "environmentUrl",
      label: "Environment URL",
      description:
        "The address of your Dynatrace environment, as shown in the browser: https://<id>.apps.dynatrace.com or https://<id>.live.dynatrace.com for SaaS, https://<host>/e/<environment-id> for Managed or an Environment ActiveGate.",
      sensitive: false,
      placeholder: "https://abc12345.apps.dynatrace.com",
    },
    {
      key: "apiToken",
      label: "Access Token",
      description:
        "A classic access token (dt0c01.…). In Dynatrace open Access Tokens, select Generate new token and add the scopes listed under Check credentials: entities.read, problems.read/write, metrics.read, slo.read/write, ExternalSyntheticIntegration, settings.read/write, apiTokens.read/write and logs.read.",
      sensitive: true,
      placeholder: "dt0c01.ABC123…",
      helpLink: {
        label: "Create an access token",
        url: "https://docs.dynatrace.com/docs/manage/identity-access-management/access-tokens-and-oauth-clients/access-tokens",
      },
    },
    {
      key: "platformToken",
      label: "Platform Token (optional)",
      description:
        "A platform token (dt0s16.…) for DQL against Grail and Grail logs. Create it at myaccount.dynatrace.com, Platform tokens, for this environment with storage:buckets:read plus the storage:*:read scopes for the data you want to query (logs, events, bizevents, spans, metrics, entities). Not available on Managed.",
      sensitive: true,
      optional: true,
      placeholder: "dt0s16.ABC123…",
      helpLink: {
        label: "Create a platform token",
        url: "https://docs.dynatrace.com/docs/manage/identity-access-management/access-tokens-and-oauth-clients/platform-tokens",
      },
    },
    {
      key: "accountUuid",
      label: "Account UUID (for cost)",
      description:
        "Only needed for platform subscription cost. The UUID in the address bar of Account Management (myaccount.dynatrace.com/…/<uuid>).",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "12345678-abcd-…",
    },
    {
      key: "oauthClientId",
      label: "OAuth Client ID (for cost)",
      description:
        "An OAuth client from Account Management, Identity & access management, OAuth clients, with the View usage and consumption (account-uac-read) account permission.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "dt0s02.ABC123",
    },
    {
      key: "oauthClientSecret",
      label: "OAuth Client Secret (for cost)",
      description: "The secret shown once when the OAuth client is created.",
      sensitive: true,
      optional: true,
      advanced: true,
      placeholder: "dt0s02.ABC123.…",
    },
    caCertCredentialField,
  ],
  costs: {
    // DPS daily cost per capability for this environment
    // (`/sub/v2/accounts/{a}/subscriptions/{s}/environments/cost`). One record
    // per day; bookings can trail by a day or two.
    dimensions: ["service", "tag"],
    maxHistoryDays: 365,
    restatementDays: 5,
  },
  preflight: DYNATRACE_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new DynatraceClient(credentials, services),
  parseStatusFeed,
  policyTemplate: dynatracePolicyTemplate,
  terraformExport: dynatraceTerraformExport,
};
