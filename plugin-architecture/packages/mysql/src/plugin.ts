import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { MySQLClient } from "./client.js";
import { MySQLDatabaseResourceType } from "./resources/mysql-database.js";

const manifest: PluginManifest = {
  id: "mysql",
  version: "0.1.0",
  displayName: "MySQL",
  description: "Connect to and inspect MySQL databases.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#00758f"/>
    <text x="50" y="68" font-size="52" text-anchor="middle" fill="white" font-family="serif">🐬</text>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "connectionString",
      label: "Connection String",
      description: "MySQL connection URI.",
      sensitive: true,
      placeholder: "mysql://user:pass@host:3306/dbname",
    },
  ],
  sqlDriver: {
    driver: "mysql",
    credentialKey: "connectionString",
  },
};

const resourceTypes: ResourceTypeDefinition[] = [MySQLDatabaseResourceType];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new MySQLClient(credentials, services),
};
