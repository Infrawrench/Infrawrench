import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { resolveHost } from "./api.js";
import { PostHogClient, listOrganizations } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { POSTHOG_PREFLIGHT, posthogPolicyTemplate } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { posthogTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "posthog",
  version: "0.1.0",
  displayName: "PostHog",
  description:
    "Product analytics, feature flags and experiments. Manage projects, feature flags, experiments, cohorts, dashboards, insights, actions, annotations, destinations, batch exports and members, run HogQL, chart events and flag evaluations, and track spend by product and project.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "region",
      label: "Region",
      description:
        "Where your PostHog Cloud organization lives. For self-hosted PostHog, fill in Instance URL below.",
      sensitive: false,
      defaultValue: "us",
      regions: [
        { id: "us", label: "US Cloud", location: "us.posthog.com" },
        { id: "eu", label: "EU Cloud", location: "eu.posthog.com" },
      ],
    },
    {
      key: "apiKey",
      label: "Personal API Key",
      description:
        "A personal API key (phx_…). In PostHog open Settings, Personal API keys, Create personal API key, limit it to your organization and pick the scopes listed under Check credentials (read and write for the objects you want to manage, query:read, billing:read for costs).",
      sensitive: true,
      placeholder: "phx_…",
      helpLink: {
        label: "Create a personal API key",
        url: "https://posthog.com/docs/api#private-endpoint-authentication",
      },
    },
    {
      key: "organizationId",
      label: "Organization",
      description:
        "Which organization to manage. Leave it on the default to use the key's current organization.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["region", "apiKey"], emptyLabel: "Current organization" },
    },
    {
      key: "host",
      label: "Instance URL (self-hosted)",
      description:
        "Only for self-hosted PostHog: the address of your instance. Leave blank for PostHog Cloud.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "https://posthog.example.com",
    },
    caCertCredentialField,
  ],
  costs: {
    // /api/billing/spend/ by usage type and project, per day, in USD.
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
  preflight: POSTHOG_PREFLIGHT,
  statusFeed,
  // CRUD endpoints allow 480 requests a minute and 4,800 an hour per key
  // (1.33/s sustained); analytics endpoints 240/min and 1,200/h.
  rateLimit: { capacity: 10, refillPerSecond: 1 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new PostHogClient(credentials, services),
  parseStatusFeed,
  policyTemplate: posthogPolicyTemplate,
  terraformExport: posthogTerraformExport,
  async listCredentialOptions(fieldKey, credentials, services) {
    if (fieldKey !== "organizationId") return [];
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) return [];
    const { baseUrl, region } = resolveHost(
      credentials["region"] ?? "us",
      credentials["host"] ?? "",
    );
    const orgs = await listOrganizations({
      baseUrl,
      region,
      apiKey,
      ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
      ...(services?.http ? { http: services.http } : {}),
    });
    return orgs.map((o) => ({
      id: String(o["id"]),
      label: String(o["name"] ?? o["id"]),
      ...(o["slug"] ? { description: String(o["slug"]) } : {}),
    }));
  },
};
