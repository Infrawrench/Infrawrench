import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { AstraPluginClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { astraTerraformExport } from "./terraform.js";
import { astraRemediationCommands } from "./remediation.js";

const manifest: PluginManifest = {
  id: "datastax-astra",
  version: "0.1.0",
  displayName: "DataStax Astra",
  description:
    "Manage Astra DB Serverless vector and non-vector databases, regions, keyspaces, collections, access lists, CDC, private endpoints, snapshots and PCU groups, plus Astra Streaming tenants, roles, users and application tokens.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "token",
      label: "Application Token",
      description:
        "An application token from the Astra Portal: Settings, Tokens, Generate token. The Organization Administrator role covers everything here; Database Administrator is enough for databases, keyspaces and collections. Metrics need a paid plan and the Manage Metrics permission.",
      sensitive: true,
      placeholder: "AstraCS:...",
      helpLink: {
        label: "Create an application token",
        url: "https://docs.datastax.com/en/astra-db-serverless/administration/manage-application-tokens.html",
      },
    },
  ],
  statusFeed,
  // DevOps API: documented fair-use limits; stay well under them.
  rateLimit: { capacity: 10, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new AstraPluginClient(credentials, services),
  parseStatusFeed: (body: string) => parseStatusFeed(body),
  terraformExport: astraTerraformExport,
  remediationCommands: astraRemediationCommands,
};
