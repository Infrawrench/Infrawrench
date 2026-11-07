import type { PluginEffect } from "@infrawrench/plugin-base";
import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import { attempt } from "@infrawrench/plugin-base/effect";
import type {
  CredentialFieldOption,
  HostServices,
  PluginManifest,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { managementApi } from "./api.js";
import { AxiomClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { AXIOM_PREFLIGHT } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { axiomTerraformExport } from "./terraform.js";

export const manifest = {
  id: "axiom",
  // Management API plus the edge deployments (us-east-1.aws.edge.axiom.co, eu-central-1.aws.edge.axiom.co) that APL queries run on.
  egressHosts: ["api.axiom.co", "*.edge.axiom.co"],
  displayName: "Axiom",
  description:
    "Event, log, trace and metrics storage queried with APL. Manage Axiom datasets, fields, virtual fields, monitors, notifiers, dashboards, views, saved queries, annotations, API tokens and users, query datasets with APL, tail their events, and chart ingest, query compute and plan limits.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
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
  ]),
  preflight: AXIOM_PREFLIGHT,
  statusFeed,
  quotas: {
    label: "Plan limits",
    increaseUrl: "https://app.axiom.co/settings/plan",
    partial: true,
  },
  rateLimit: { capacity: 10, refillPerSecond: 2 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new AxiomClient(credentials, services),
  testCredentials: { token: "xaat-test-token" },
  parseStatusFeed,
  terraformExport: axiomTerraformExport,
  listCredentialOptions(
    fieldKey: string,
    credentials: Record<string, string>,
    services?: HostServices,
  ): PluginEffect<CredentialFieldOption[]> {
    return attempt(async () => {
      if (fieldKey !== "orgId") return [];
      const token = (credentials["token"] ?? "").trim();
      if (!token) return [];
      const orgs = await managementApi({
        token,
        ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
        ...(services?.http ? { http: services.http } : {}),
      }).get("/orgs");
      return (orgs ?? [])
        .filter((o) => o.id)
        .map((o) => ({
          id: o.id,
          label: o.name ?? o.id,
          description: o.id,
        }));
    });
  },
});
