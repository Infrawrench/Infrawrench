import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { PAPERSPACE_CI_EXECUTOR } from "./ci-executor.js";
import { PaperspaceClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { paperspaceRemediationCommands } from "./remediation.js";

export const manifest = {
  id: "paperspace",
  egressHosts: ["api.paperspace.com"],
  displayName: "Paperspace",
  description:
    "GPU machines from DigitalOcean's Paperspace. Machines with start, stop and resize, snapshots, custom templates, shared drives, private networks, static IPs, startup scripts, projects, container deployments with metrics, and registry credentials.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Paperspace API key: in the Paperspace console click your profile icon, Team Settings, API Keys, enter a name and click Add. Keys act for you within that team and see everything the team owns.",
      sensitive: true,
      placeholder: "",
      helpLink: {
        label: "Paperspace API keys",
        url: "https://docs.digitalocean.com/reference/paperspace/api-keys/",
      },
    },
    caCertCredentialField,
  ]),
  statusFeed,
  // CI jobs on a fresh machine per job (`cloud: paperspace/vm`). See `ci-executor.ts`.
  ciExecutor: PAPERSPACE_CI_EXECUTOR,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) =>
    new PaperspaceClient(credentials, RESOURCE_TYPES, services),
  testCredentials: { apiKey: "test-paperspace-key" },
  parseStatusFeed,
  remediationCommands: paperspaceRemediationCommands,
});
