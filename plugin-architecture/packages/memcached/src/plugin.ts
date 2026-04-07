import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { MemcachedClient } from "./client.js";
import { MemcachedInstanceResourceType } from "./resources/memcached-instance.js";

const manifest: PluginManifest = {
  id: "memcached",
  version: "0.1.0",
  displayName: "Memcached",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#6B8E23"/>
    <text x="50" y="65" font-size="42" text-anchor="middle" fill="white" font-family="monospace" font-weight="bold">MC</text>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "connectionString",
      label: "Server(s)",
      description: "host:port — or comma-separated for multiple servers.",
      sensitive: false,
      placeholder: "localhost:11211",
    },
  ],
  kvDriver: {
    driver: "memcached",
    credentialKey: "connectionString",
  },
};

const resourceTypes: ResourceTypeDefinition[] = [MemcachedInstanceResourceType];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new MemcachedClient(credentials, services),
};
