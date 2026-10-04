import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ModalClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "modal",
  version: "0.1.0",
  displayName: "Modal",
  description:
    "Serverless GPU and CPU compute. Track Modal spend per app and per resource type (each GPU type, CPU, memory) with credits and plan adjustments, environment spend limits and concurrency caps, and manage environments, apps, functions and their schedules, volumes, secrets, dicts and queues, with invocation, cold-start and latency charts.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "tokenId",
      label: "Token ID",
      description:
        "The ID half of a Modal API token, from Settings, API Tokens in the Modal dashboard (or `token_id` in ~/.modal.toml after `modal token new`). A token sees every environment of its workspace; use one from a workspace on the Team or Enterprise plan for cost data.",
      sensitive: false,
      placeholder: "ak-…",
      helpLink: { label: "Manage Modal API tokens", url: "https://modal.com/settings/tokens" },
    },
    {
      key: "tokenSecret",
      label: "Token Secret",
      description:
        "The secret half of the same token. Modal shows it only once, when the token is created.",
      sensitive: true,
      placeholder: "as-…",
      helpLink: { label: "Manage Modal API tokens", url: "https://modal.com/settings/tokens" },
    },
    caCertCredentialField,
  ],
  costs: {
    // The workspace billing report: daily cost per Modal object (app,
    // sandbox, volume…) split by resource type (each GPU type, CPU, memory),
    // with user tags. The monthly summary's adjustments (credits, plan,
    // reservations, egress allowance) are written as charge-typed rows on
    // the 1st of each cycle.
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 365,
    // Billing data usually lands within minutes but can be delayed, and the
    // current cycle's adjustments are dated to its 1st: 35 days keeps that
    // day inside every incremental window.
    restatementDays: 35,
    chargeTypes: true,
  },
  quotas: {
    label: "Environment limits",
    increaseUrl: "https://modal.com/settings",
    // Only the per-environment caps a workspace manager has set are visible;
    // workspace-wide plan limits are not exposed.
    partial: true,
  },
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new ModalClient(credentials, services),
  parseStatusFeed,
};
