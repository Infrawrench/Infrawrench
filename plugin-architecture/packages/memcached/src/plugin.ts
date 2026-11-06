import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type {
  PluginManifest,
  ResourceTypeDefinition,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { MemcachedClient } from "./client.js";
import { MemcachedInstanceResourceType } from "./resources/memcached-instance.js";

export const manifest = {
  id: "memcached",
  egressHosts: [],
  displayName: "Memcached",
  sshTunnel: {
    label: "Memcached",
    defaultPort: 11211,
    credentials: { connectionString: "memcached://localhost:{port}" },
  },
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#6B8E23"/>
    <text x="50" y="65" font-size="42" text-anchor="middle" fill="white" font-family="monospace" font-weight="bold">MC</text>
  </svg>`,
  credentialFields: defineCredentials([
    {
      key: "connectionString",
      label: "Server(s)",
      description: "host:port, comma-separated for multiple servers.",
      sensitive: false,
      placeholder: "localhost:11211",
    },
  ]),
  kvDriver: {
    driver: "memcached",
    credentialKey: "connectionString",
  },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

const resourceTypes: ResourceTypeDefinition[] = [MemcachedInstanceResourceType];

export const plugin = definePlugin({
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new MemcachedClient(credentials, services),
  testCredentials: { connectionString: "localhost:11211" },
});
