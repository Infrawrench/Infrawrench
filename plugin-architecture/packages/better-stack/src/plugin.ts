import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { BetterStackClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { BETTER_STACK_PREFLIGHT } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { betterStackTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "better-stack",
  version: "0.1.0",
  displayName: "Better Stack",
  description:
    "Uptime monitoring, incident management, status pages and telemetry. Manage Better Stack monitors, heartbeats, status pages, on-call calendars, incidents, escalation policies, Telemetry sources and dashboards, chart response times and source events, tail and query logs with SQL, and track daily cost per product.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description:
        "A global API token (Better Stack, API tokens, Global API tokens) covers Uptime, Telemetry, team members and cost data for every team. A team Uptime API token (API tokens, Team-based tokens) also works but sees only that team's Uptime objects and no cost.",
      sensitive: true,
      placeholder: "24 characters",
      helpLink: {
        label: "Create a global API token",
        url: "https://betterstack.com/settings/global-api-tokens",
      },
    },
    {
      key: "telemetryToken",
      label: "Telemetry API Token (optional)",
      description:
        "Only needed when the token above is a team Uptime token: a team Telemetry API token (API tokens, Team-based tokens, Telemetry API tokens) for sources and dashboards.",
      sensitive: true,
      optional: true,
      placeholder: "24 characters",
    },
    caCertCredentialField,
  ],
  costs: {
    // Usage API: product -> service, billed item -> resource (with its name
    // as the `item` tag). Daily dollars, at most 400 days per request; today
    // is not finalized and is restated on later passes.
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 400,
    restatementDays: 3,
  },
  preflight: BETTER_STACK_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new BetterStackClient(credentials, services),
  parseStatusFeed,
  terraformExport: betterStackTerraformExport,
};
