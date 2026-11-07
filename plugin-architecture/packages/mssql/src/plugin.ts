import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type {
  PluginManifest,
  ResourceTypeDefinition,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { MSSQLClient } from "./client.js";
import { MSSQLDatabaseResourceType } from "./resources/mssql-database.js";

export const manifest = {
  id: "mssql",
  egressHosts: [],
  displayName: "SQL Server",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="12" fill="#A91D22"/><text x="50" y="62" text-anchor="middle" font-family="system-ui,Arial" font-weight="700" font-size="36" fill="white">SQL</text></svg>`,
  credentialFields: defineCredentials([
    {
      key: "connectionString",
      label: "Connection String",
      description: "SQL Server connection URI.",
      sensitive: true,
      placeholder: "mssql://user:pass@host:1433/dbname?encrypt=true&trustServerCertificate=false",
    },
  ]),
  sqlDriver: {
    driver: "mssql",
    credentialKey: "connectionString",
  },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

const resourceTypes: ResourceTypeDefinition[] = [MSSQLDatabaseResourceType];

export const plugin = definePlugin({
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new MSSQLClient(credentials, services),
  testCredentials: {
    connectionString:
      "mssql://user:pass@localhost:1433/db?encrypt=true&trustServerCertificate=true",
  },
});
