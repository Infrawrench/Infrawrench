import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { PostgresClient } from "./client.js";
import { PostgresDatabaseResourceType } from "./resources/pg-database.js";
import { PostgresSchemaResourceType } from "./resources/pg-schema.js";

const manifest: PluginManifest = {
  id: "postgres",
  version: "0.1.0",
  displayName: "PostgreSQL",
  description: "Connect to and inspect PostgreSQL databases — connection string can be linked to a DigitalOcean Managed Database.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#336791"/>
    <text x="50" y="68" font-size="52" text-anchor="middle" fill="white" font-family="serif">🐘</text>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  peerPlugins: ["digitalocean"],
  credentialFields: [
    {
      key: "connectionString",
      label: "Connection String",
      description: "PostgreSQL connection URI. You can also link this to a DigitalOcean Managed Database after adding.",
      sensitive: true,
      placeholder: "postgresql://user:pass@host:5432/dbname",
    },
  ],
  sqlDriver: {
    driver: "postgres",
    credentialKey: "connectionString",
  },
};

const resourceTypes: ResourceTypeDefinition[] = [
  PostgresDatabaseResourceType,
  PostgresSchemaResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new PostgresClient(credentials),
};
