import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { InfisicalClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resources.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { infisicalTerraformExport } from "./terraform.js";

export const manifest = {
  id: "infisical",
  // Infisical Cloud US/EU; self-hosted instances use the user's own URL
  egressHosts: ["app.infisical.com", "us.infisical.com", "eu.infisical.com"],
  displayName: "Infisical",
  description:
    "Open-source secrets, certificate and key management. Manage projects, environments, folders and secrets, watch and trigger secret syncs, run machine identities, mint dynamic-secret leases and certificates, and read audit logs, on Infisical Cloud or a self-hosted instance.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "siteUrl",
      providerHost: true,
      label: "Instance URL",
      description:
        "https://app.infisical.com for US Cloud, https://eu.infisical.com for EU Cloud, or your self-hosted or dedicated instance URL.",
      sensitive: false,
      defaultValue: "https://app.infisical.com",
      placeholder: "https://app.infisical.com",
    },
    {
      key: "clientId",
      label: "Client ID",
      description:
        "Universal Auth client ID of a machine identity. In Infisical go to Organization Settings → Access Control → Identities, create an identity (the Admin organization role lets it list every project and identity), open it, add Universal Auth and copy the Client ID. Then add the identity to each project you want to manage.",
      sensitive: false,
      placeholder: "00000000-0000-0000-0000-000000000000",
      helpLink: {
        label: "Machine identities in Infisical",
        url: "https://infisical.com/docs/documentation/platform/identities/universal-auth",
      },
    },
    {
      key: "clientSecret",
      label: "Client Secret",
      description:
        "A client secret created on the same identity's Universal Auth page (Create Client Secret). Infisical shows it once.",
      sensitive: true,
      placeholder: "64-character client secret",
    },
    {
      key: "organizationSlug",
      label: "Sub-organization (optional)",
      description:
        "Slug of a sub-organization to scope the session to. Leave blank to use the organization the identity was created in.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "my-sub-org",
    },
    caCertCredentialField,
  ]),
  preflight: {
    capabilities: [
      {
        id: "login",
        label: "Sign in",
        description: "Universal Auth login with the client ID and secret.",
        requiredPermissions: [
          { id: "universal-auth", label: "Universal Auth client ID and secret" },
        ],
        essential: true,
      },
      {
        id: "projects",
        label: "Projects",
        description: "List the projects the identity is a member of.",
        requiredPermissions: [{ id: "project-membership", label: "Project membership" }],
        essential: true,
      },
      {
        id: "identities",
        label: "Machine identities",
        description: "List and manage organization machine identities.",
        requiredPermissions: [
          { id: "org-identities", label: "Organization role with Identity access" },
        ],
      },
      {
        id: "audit-logs",
        product: "observability",
        label: "Audit logs and metrics",
        description: "Read audit logs for the Logs and Metrics tabs.",
        requiredPermissions: [
          { id: "org-audit-logs", label: "Organization role with Audit Logs access" },
        ],
      },
    ],
  },
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 4 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new InfisicalClient(credentials, services),
  testCredentials: {
    siteUrl: "https://app.infisical.com",
    clientId: "00000000-0000-0000-0000-000000000000",
    clientSecret: "test-infisical-secret",
  },
  parseStatusFeed,
  terraformExport: infisicalTerraformExport,
});
