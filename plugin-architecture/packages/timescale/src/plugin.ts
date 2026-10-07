import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { TimescaleClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { timescaleTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "timescale",
  version: "0.1.0",
  displayName: "Tiger Cloud",
  description:
    "Manage Tiger Data's Tiger Cloud (formerly Timescale Cloud): PostgreSQL and TimescaleDB services, HA and read replicas, forks, pause and resume, resizing, VPCs and peering, IP allow lists, exporters and backups, with metrics, logs and a PostgreSQL console.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
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
  ],
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new TimescaleClient(credentials, services),
  parseStatusFeed: (body: string) => parseStatusFeed(body),
  terraformExport: timescaleTerraformExport,
};
