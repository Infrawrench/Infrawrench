import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { TimescaleClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { timescaleRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { timescaleTerraformExport } from "./terraform.js";

export const manifest = {
  id: "timescale",
  // Tiger Cloud (Timescale) REST API; the timescale.com host is the legacy alias
  egressHosts: ["console.cloud.tigerdata.com", "console.cloud.timescale.com"],
  displayName: "Tiger Cloud",
  description:
    "Manage Tiger Data's Tiger Cloud (formerly Timescale Cloud): PostgreSQL and TimescaleDB services, HA and read replicas, forks, pause and resume, resizing, VPCs and peering, IP allow lists, exporters and backups, with metrics, logs and a PostgreSQL console.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "accessKey",
      label: "Public Key",
      description:
        "The public (access) key of a client credential. In the Tiger Cloud console open the project menu at the top left, choose Project settings, then Create credentials. A credential belongs to one project and acts with full access to it.",
      sensitive: false,
      placeholder: "tskey_...",
      helpLink: {
        label: "Create client credentials",
        url: "https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/security/client-credentials",
      },
    },
    {
      key: "secretKey",
      label: "Secret Key",
      description:
        "The secret key shown once, next to the public key, when the credential is created.",
      sensitive: true,
      placeholder: "Secret key",
    },
  ]),
  statusFeed,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new TimescaleClient(credentials, services),
  testCredentials: { accessKey: "tskey_test", secretKey: "test-secret" },
  parseStatusFeed: (body: string) => parseStatusFeed(body),
  terraformExport: timescaleTerraformExport,
  remediationCommands: timescaleRemediationCommands,
});
