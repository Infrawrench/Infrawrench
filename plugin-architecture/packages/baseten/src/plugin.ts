import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { BasetenClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "baseten",
  version: "0.1.0",
  displayName: "Baseten",
  description:
    "Model inference platform. Track billed Baseten spend by model, deployment, instance type, training job and Model API, find deployments keeping idle replicas warm, and manage models, deployments, environments, autoscaling, promotions, chains, training jobs and secrets.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        'A Baseten API key from Settings, API keys. Use a personal key of an organization admin, or a team key with "Manage and call all team models", so models, deployments and billing usage are all readable. A team key only sees its team\'s models.',
      sensitive: true,
      placeholder: "b10_...",
      helpLink: {
        label: "Create a Baseten API key",
        url: "https://app.baseten.co/settings/api_keys",
      },
    },
    caCertCredentialField,
  ],
  /**
   * Billed spend from `GET /v1/billing/usage_summary`: dedicated inference per
   * deployment and chainlet, training per job and Model APIs per model, daily.
   * Baseten serves this from 2026-01-01 (the collector clamps earlier ranges)
   * in windows of at most 31 days. Amounts are usage before credits; credits
   * are only reported as an undated window total.
   */
  costs: {
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
  quotas: {
    label: "Baseten training GPU capacity",
    increaseUrl: "https://docs.baseten.co/training/overview",
    partial: true,
  },
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new BasetenClient(credentials, RESOURCE_TYPES, services),
  parseStatusFeed,
};
