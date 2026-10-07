import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ConvexClient } from "./client.js";
import { CONVEX_LOGO } from "./logo.js";
import { CONVEX_PREFLIGHT } from "./preflight.js";
import { convexRemediationCommands } from "./remediation.js";
import { resourceTypes } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "convex",
  version: "0.1.0",
  displayName: "Convex",
  description:
    "Convex projects and deployments: environment variables, deploy keys, custom domains, log streams, usage limits and team access.",
  logoSvg: CONVEX_LOGO,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
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
  ],
  // Convex has no billing API; usage limits are reported as quotas instead.
  quotas: {
    label: "Usage limits",
    partial: true,
    increaseUrl: "https://dashboard.convex.dev",
  },
  statusFeed,
  preflight: CONVEX_PREFLIGHT,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new ConvexClient(credentials, services),
  parseStatusFeed,
  remediationCommands: convexRemediationCommands,
};
