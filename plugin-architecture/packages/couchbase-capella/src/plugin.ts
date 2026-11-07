import type { PluginEffect } from "@infrawrench/plugin-base";
import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import { attempt } from "@infrawrench/plugin-base/effect";
import type {
  CredentialFieldOption,
  HostServices,
  PluginManifest,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { createCapellaApi } from "./api.js";
import { CapellaClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { capellaRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { capellaTerraformExport } from "./terraform.js";

export const manifest = {
  id: "couchbase-capella",
  egressHosts: ["cloudapi.cloud.couchbase.com"],
  displayName: "Couchbase Capella",
  description:
    "Manage Couchbase Capella projects, operational and free-tier clusters, App Services, buckets, scopes and collections, database credentials, allowed CIDRs, backups and schedules, XDCR, users and API keys, with billed cost and prepaid credits.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "API Key Token",
      description:
        "A Management API key token from the Capella UI: Organization Settings, API Keys, Generate Key. Organization Owner covers everything here (cost data and prepaid credits need it); Project Owner on a project is enough to manage that project's clusters. Add this server's address to the key's allowed CIDRs.",
      sensitive: true,
      placeholder: "dGVzdC1rZXk...",
      helpLink: {
        label: "Management API keys",
        url: "https://docs.couchbase.com/cloud/management-api-guide/management-api-start.html",
      },
    },
    {
      key: "organizationId",
      label: "Organization",
      description: "The organization the key belongs to, listed from the key.",
      sensitive: false,
      placeholder: "ffffffff-aaaa-1414-eeee-000000000000",
      providerOptions: { dependsOn: ["apiKey"] },
    },
  ]),
  costs: {
    // Categorized billing per cluster (resource) with the organization total's
    // remainder unattributed; daily within a month, so chunks stay inside one.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
  credits: { label: "Prepaid credits", topUpUrl: "https://cloud.couchbase.com" },
  statusFeed,
  // Documented: 100 requests per minute per API key.
  rateLimit: { capacity: 10, refillPerSecond: 1.5 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new CapellaClient(credentials, services),
  testCredentials: { apiKey: "test-capella-key", organizationId: "org-1" },
  parseStatusFeed: (body: string) => parseStatusFeed(body),
  terraformExport: capellaTerraformExport,
  remediationCommands: capellaRemediationCommands,
  listCredentialOptions(
    fieldKey: string,
    credentials: Record<string, string>,
    services?: HostServices,
  ): PluginEffect<CredentialFieldOption[]> {
    return attempt(async () => {
      if (fieldKey !== "organizationId") return [];
      const apiKey = (credentials["apiKey"] ?? "").trim();
      if (!apiKey) throw new Error("Enter the API key first.");
      const res = await createCapellaApi({
        apiKey,
        ...(services?.http ? { http: services.http } : {}),
      }).get("/v4/organizations");
      return (res?.data ?? []).map((o) => ({ id: o.id, label: o.name ?? o.id, description: o.id }));
    });
  },
});
