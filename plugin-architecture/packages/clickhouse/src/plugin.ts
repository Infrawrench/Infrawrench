import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ClickHouseClient } from "./client.js";
import { ServiceResourceType } from "./resources/service.js";
import { DatabaseResourceType } from "./resources/database.js";

const manifest: PluginManifest = {
  id: "clickhouse",
  version: "0.1.0",
  displayName: "ClickHouse",
  description:
    "Manage ClickHouse Cloud services — view, create, scale, and query your ClickHouse databases.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#FADB14"/>
    <g transform="translate(14,10)">
      <rect x="0" y="0" width="10" height="80" rx="2" fill="#151515"/>
      <rect x="15" y="0" width="10" height="80" rx="2" fill="#151515"/>
      <rect x="30" y="0" width="10" height="80" rx="2" fill="#151515"/>
      <rect x="45" y="24" width="10" height="32" rx="2" fill="#151515"/>
      <rect x="60" y="0" width="10" height="80" rx="2" fill="#151515"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKeyId",
      label: "Cloud API Key ID",
      description: "Your ClickHouse Cloud API key ID for managing services.",
      sensitive: false,
      placeholder: "abc123...",
    },
    {
      key: "apiKeySecret",
      label: "Cloud API Key Secret",
      description: "Your ClickHouse Cloud API key secret.",
      sensitive: true,
      placeholder: "secret...",
    },
    {
      key: "organizationId",
      label: "Organization ID",
      description: "Your ClickHouse Cloud organization ID (UUID).",
      sensitive: false,
      placeholder: "12345678-1234-1234-1234-123456789abc",
    },
    {
      key: "chHost",
      label: "Service Hostname (for SQL)",
      description:
        "HTTPS endpoint of a ClickHouse service for running SQL queries (e.g. abc123.us-east-1.aws.clickhouse.cloud). Leave blank to skip SQL.",
      sensitive: false,
      optional: true,
      placeholder: "abc123.us-east-1.aws.clickhouse.cloud",
    },
    {
      key: "chPort",
      label: "SQL HTTPS Port",
      description: "HTTPS interface port for SQL queries. ClickHouse Cloud uses 8443 by default.",
      sensitive: false,
      placeholder: "8443",
      defaultValue: "8443",
      optional: true,
    },
    {
      key: "chUser",
      label: "SQL Username",
      description: "ClickHouse database user for SQL queries.",
      sensitive: false,
      placeholder: "default",
      defaultValue: "default",
    },
    {
      key: "chPassword",
      label: "SQL Password",
      description: "Password for the SQL user. Leave blank if you skipped the SQL hostname.",
      sensitive: true,
      optional: true,
      placeholder: "password",
    },
    caCertCredentialField,
  ],
  // ClickHouse Cloud usageCost API — daily per-entity spend broken down by
  // cost category (compute, storage, backup, data transfer, ClickPipes).
  // Amounts are CHC credits converted at the $1-per-CHC list price, so
  // committed-spend discounts are not reflected.
  costs: { dimensions: ["service", "resource"], restatementDays: 3 },
};

const resourceTypes: ResourceTypeDefinition[] = [ServiceResourceType, DatabaseResourceType];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new ClickHouseClient(credentials, services),
};
