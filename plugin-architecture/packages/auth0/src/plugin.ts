import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { Auth0Client } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resources.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { auth0TerraformExport } from "./terraform.js";

/** Management API scopes the plugin uses, for the credential help text. */
const SCOPES = [
  "read:tenant_settings update:tenant_settings read:branding update:branding",
  "read:clients create:clients update:clients delete:clients read:client_keys update:client_keys",
  "read:resource_servers create:resource_servers update:resource_servers delete:resource_servers",
  "read:connections create:connections update:connections delete:connections",
  "read:users create:users update:users delete:users read:user_idp_tokens create:user_tickets",
  "read:roles create:roles update:roles delete:roles",
  "read:organizations create:organizations update:organizations delete:organizations read:organization_members create:organization_members delete:organization_members read:organization_connections create:organization_connections delete:organization_connections create:organization_invitations",
  "read:actions create:actions update:actions delete:actions",
  "read:log_streams create:log_streams update:log_streams delete:log_streams",
  "read:custom_domains create:custom_domains update:custom_domains delete:custom_domains",
  "read:attack_protection update:attack_protection read:logs read:stats",
].join(" ");

const manifest: PluginManifest = {
  id: "auth0",
  version: "0.1.0",
  displayName: "Auth0",
  description:
    "Customer identity platform. Manage applications, APIs, connections, users, roles, organizations, Actions (with deploy), log streams, custom domains, tenant settings, branding and attack protection, and read tenant logs and daily sign-in stats.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "domain",
      label: "Tenant Domain",
      description:
        "Your tenant's canonical Auth0 domain, shown under Settings → General as the tenant domain, e.g. acme.us.auth0.com. Use it even if you have a custom domain: the Management API only answers on the canonical one.",
      sensitive: false,
      placeholder: "acme.us.auth0.com",
    },
    {
      key: "clientId",
      label: "Client ID",
      description: `Of a Machine to Machine application authorized for the Auth0 Management API. In the dashboard: Applications → Applications → Create Application → Machine to Machine, choose "Auth0 Management API", then select scopes. Read-only accounts need only the read:* scopes. Full list used: ${SCOPES}.`,
      sensitive: false,
      placeholder: "AaiyAPdpYdesoKnqjj8HJqRn4T5titww",
      helpLink: {
        label: "Get Management API access tokens",
        url: "https://auth0.com/docs/secure/tokens/access-tokens/management-api-access-tokens/get-management-api-access-tokens-for-production",
      },
    },
    {
      key: "clientSecret",
      label: "Client Secret",
      description: "The same application's client secret (Settings tab).",
      sensitive: true,
      placeholder: "64-character secret",
    },
    caCertCredentialField,
  ],
  preflight: {
    capabilities: [
      {
        id: "tenant",
        label: "Tenant settings",
        requiredPermissions: [{ id: "read:tenant_settings", label: "read:tenant_settings" }],
        essential: true,
      },
      {
        id: "applications",
        label: "Applications",
        requiredPermissions: [{ id: "read:clients", label: "read:clients" }],
      },
      {
        id: "users",
        label: "Users",
        requiredPermissions: [{ id: "read:users", label: "read:users" }],
      },
      {
        id: "actions",
        label: "Actions",
        requiredPermissions: [{ id: "read:actions", label: "read:actions" }],
      },
      { id: "logs", label: "Logs", requiredPermissions: [{ id: "read:logs", label: "read:logs" }] },
      {
        id: "stats",
        label: "Sign-in stats",
        requiredPermissions: [{ id: "read:stats", label: "read:stats" }],
      },
    ],
  },
  quotas: {
    label: "Management API rate limit",
    partial: true,
    increaseUrl:
      "https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy",
  },
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new Auth0Client(credentials, services),
  parseStatusFeed,
  terraformExport: auth0TerraformExport,
};
