import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { RedisClient } from "./client.js";
import { RedisInstanceResourceType } from "./resources/redis-instance.js";

const manifest: PluginManifest = {
  id: "redis",
  version: "0.1.0",
  displayName: "Redis",
  description: "Connect to and inspect Redis instances.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#D82C20"/>
    <text x="50" y="68" font-size="48" text-anchor="middle" fill="white" font-family="monospace" font-weight="bold">R</text>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "connectionString",
      label: "Connection String",
      description: "Redis connection URI (redis://[:password@]host[:port][/db] or rediss:// for TLS).",
      sensitive: true,
      placeholder: "redis://localhost:6379",
    },
  ],
  kvDriver: {
    driver: "redis",
    credentialKey: "connectionString",
  },
};

const resourceTypes: ResourceTypeDefinition[] = [
  RedisInstanceResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new RedisClient(credentials, services),
};
