import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { axFetch } from "./api.js";
import { AxiomClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { AXIOM_PREFLIGHT } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { axiomTerraformExport } from "./terraform.js";
import type { AxOrg } from "./types.js";

const manifest: PluginManifest = {
  id: "axiom",
  version: "0.1.0",
  displayName: "Axiom",
  description:
    "Event, log, trace and metrics storage queried with APL. Manage Axiom datasets, fields, virtual fields, monitors, notifiers, dashboards, views, saved queries, annotations, API tokens and users, query datasets with APL, tail their events, and chart ingest, query compute and plan limits.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "token",
      label: "API Token",
      description:
        "An advanced API token from Axiom under Settings, API tokens. Give it read (and, to manage them, create, update and delete) on Datasets, Monitors, Notifiers, Dashboards, Views, Annotations, API tokens and Users, plus Query on the datasets you want to query or chart. A personal access token (Settings, Profile) also works and sees everything you can, but needs the organization below and cannot query edge deployments directly.",
      sensitive: true,
      placeholder: "xaat-… or xapt-…",
      helpLink: { label: "Create an API token", url: "https://app.axiom.co/settings/api-tokens" },
    },
    {
      key: "orgId",
      label: "Organization",
      description:
        "Only needed with a personal access token: the organization to manage. Picked from the organizations the token can see.",
      sensitive: false,
      optional: true,
      placeholder: "axiom-abcd",
      providerOptions: { dependsOn: ["token"], emptyLabel: "The token's organization" },
    },
    caCertCredentialField,
  ],
  preflight: AXIOM_PREFLIGHT,
  statusFeed,
  quotas: {
    label: "Plan limits",
    increaseUrl: "https://app.axiom.co/settings/plan",
    partial: true,
  },
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new AxiomClient(credentials, services),
  parseStatusFeed,
  terraformExport: axiomTerraformExport,
  async listCredentialOptions(
    fieldKey: string,
    credentials: Record<string, string>,
    services?: HostServices,
  ): Promise<CredentialFieldOption[]> {
    if (fieldKey !== "orgId") return [];
    const token = (credentials["token"] ?? "").trim();
    if (!token) return [];
    const orgs = await axFetch<AxOrg[]>(
      {
        token,
        ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
        ...(services?.http ? { http: services.http } : {}),
      },
      "/v2/orgs",
    );
    return (orgs ?? [])
      .filter((o) => o.id)
      .map((o) => ({
        id: o.id as string,
        label: o.name ?? (o.id as string),
        description: o.id as string,
      }));
  },
};
