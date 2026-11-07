import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ClerkClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resources.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

export const manifest = {
  id: "clerk",
  egressHosts: ["api.clerk.com"],
  displayName: "Clerk",
  description:
    "Authentication and user management. Manage users and sessions, organizations and memberships, domains and their DNS records, JWT templates, OAuth applications, enterprise SSO connections, machines, allow and block lists, invitations, redirect URLs, sign-up restrictions and webhooks.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "secretKey",
      label: "Secret Key",
      description:
        "The instance's Backend API secret key. In the Clerk Dashboard open your application, pick the instance (Development or Production) and go to Configure → API keys → Secret keys. Each instance has its own key; add one account per instance.",
      sensitive: true,
      placeholder: "sk_live_…",
      helpLink: {
        label: "Open API keys in the Clerk Dashboard",
        url: "https://dashboard.clerk.com/last-active?path=api-keys",
      },
    },
    caCertCredentialField,
  ]),
  preflight: {
    capabilities: [
      {
        id: "instance",
        label: "Instance access",
        description: "The secret key reads the instance.",
        requiredPermissions: [{ id: "secret-key", label: "A valid secret key" }],
        essential: true,
      },
    ],
  },
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 5 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new ClerkClient(credentials, services),
  testCredentials: { secretKey: "sk_test_clerkcontract" },
  parseStatusFeed,
});
