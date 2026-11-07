import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import { attemptFn } from "@infrawrench/plugin-base/effect";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ConvexClient } from "./client.js";
import { CONVEX_LOGO } from "./logo.js";
import { CONVEX_OAUTH, completeConvexOAuth } from "./oauth.js";
import { CONVEX_PREFLIGHT } from "./preflight.js";
import { convexRemediationCommands } from "./remediation.js";
import { resourceTypes } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

export const manifest = {
  id: "convex",
  // *.convex.cloud is each deployment's own Deployment API (regional hosts included)
  egressHosts: ["api.convex.dev", "*.convex.cloud"],
  displayName: "Convex",
  description:
    "Convex projects and deployments: environment variables, deploy keys, custom domains, log streams, usage limits and team access.",
  logoSvg: CONVEX_LOGO,
  credentialFields: defineCredentials([
    {
      key: "accessToken",
      label: "Team Access Token",
      description:
        "Create one in the Convex dashboard under Team Settings > Access Tokens. It acts with your role on the team, so an admin token can manage everything; a developer token can manage deployments but not members or production settings an admin controls.",
      sensitive: true,
      placeholder: "Paste the token Convex shows once",
      helpLink: {
        label: "Create a team access token",
        url: "https://dashboard.convex.dev/team/settings/access-tokens",
      },
    },
    caCertCredentialField,
  ]),
  // Convex has no billing API; usage limits are reported as quotas instead.
  quotas: {
    label: "Usage limits",
    partial: true,
    increaseUrl: "https://dashboard.convex.dev",
  },
  statusFeed,
  preflight: CONVEX_PREFLIGHT,
  oauth: CONVEX_OAUTH,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new ConvexClient(credentials, services),
  testCredentials: { accessToken: "test-convex-team-token" },
  parseStatusFeed,
  remediationCommands: convexRemediationCommands,
  completeOAuthConnection: attemptFn(completeConvexOAuth),
});
