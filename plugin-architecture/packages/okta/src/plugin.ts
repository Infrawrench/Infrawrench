import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { DEFAULT_SCOPES } from "./api.js";
import { OktaClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resources.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { oktaTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "okta",
  version: "0.1.0",
  displayName: "Okta",
  description:
    "Workforce and customer identity. Manage users and their lifecycle, groups, app assignments, authorization servers, policies, network zones, API tokens, event hooks, custom domains and trusted origins, read the System Log, and watch sign-in and rate-limit metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "orgUrl",
      label: "Okta Org URL",
      description:
        "Your Okta org's address, e.g. https://acme.okta.com (the admin console address works too).",
      sensitive: false,
      placeholder: "https://acme.okta.com",
    },
    {
      key: "apiToken",
      label: "API Token",
      description:
        "Option 1. In the Admin Console go to Security → API → Tokens → Create token. The token acts with the permissions of the admin who creates it (Super Administrator manages everything; Read-only Administrator browses). Leave blank to use a service app instead.",
      sensitive: true,
      optional: true,
      placeholder: "00aBcD…",
      helpLink: {
        label: "Create an API token",
        url: "https://developer.okta.com/docs/guides/create-an-api-token/main/",
      },
    },
    {
      key: "clientId",
      label: "Service App Client ID",
      description:
        "Option 2. Applications → Applications → Create App Integration → API Services. On the app, set client authentication to Public key / Private key, add a key, grant the Okta API scopes you need on the Okta API Scopes tab, and assign an admin role on the Admin roles tab.",
      sensitive: false,
      optional: true,
      placeholder: "0oa1b2c3d4E5F6g7H8i9",
      helpLink: {
        label: "OAuth for Okta service apps",
        url: "https://developer.okta.com/docs/guides/implement-oauth-for-okta-serviceapp/main/",
      },
    },
    {
      key: "privateKey",
      label: "Service App Private Key",
      description:
        "The private key for the service app: the JWK Okta shows when it generates a key, or a PKCS#8 PEM (-----BEGIN PRIVATE KEY-----). RSA and EC P-256 keys work. DPoP is handled automatically.",
      sensitive: true,
      optional: true,
      multiline: true,
      placeholder: '{"kty":"RSA","kid":"…","d":"…"} or -----BEGIN PRIVATE KEY-----',
    },
    {
      key: "keyId",
      label: "Key ID (kid)",
      description:
        "The key's ID from the app's Public Keys list. Read from the JWK when it carries one.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "abc123",
    },
    {
      key: "scopes",
      label: "Granted Scopes",
      description: `Space-separated Okta API scopes granted to the service app. Okta rejects the token request if any scope is not granted, so list exactly what you granted. Default: ${DEFAULT_SCOPES}.`,
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "okta.users.read okta.groups.read okta.logs.read",
    },
    caCertCredentialField,
  ],
  preflight: {
    capabilities: [
      {
        id: "org",
        label: "Org settings",
        requiredPermissions: [{ id: "okta.orgs.read", label: "okta.orgs.read" }],
        essential: true,
      },
      {
        id: "users",
        label: "Users",
        requiredPermissions: [
          { id: "okta.users.read", label: "okta.users.read (okta.users.manage to edit)" },
        ],
      },
      {
        id: "groups",
        label: "Groups",
        requiredPermissions: [
          { id: "okta.groups.read", label: "okta.groups.read (okta.groups.manage to edit)" },
        ],
      },
      {
        id: "apps",
        label: "Applications",
        requiredPermissions: [
          { id: "okta.apps.read", label: "okta.apps.read (okta.apps.manage to edit)" },
        ],
      },
      {
        id: "security",
        label: "Network zones",
        requiredPermissions: [{ id: "okta.networkZones.read", label: "okta.networkZones.read" }],
      },
      {
        id: "logs",
        label: "System Log and metrics",
        requiredPermissions: [{ id: "okta.logs.read", label: "okta.logs.read" }],
      },
    ],
  },
  quotas: {
    label: "API rate limits",
    partial: true,
    increaseUrl: "https://developer.okta.com/docs/reference/rl-best-practices/",
  },
  statusFeed,
  // Okta's org-wide management limits start around 600 requests/minute per endpoint family.
  rateLimit: { capacity: 20, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new OktaClient(credentials, services),
  parseStatusFeed,
  terraformExport: oktaTerraformExport,
};
