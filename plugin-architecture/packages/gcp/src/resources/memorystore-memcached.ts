import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const MemorystoreMemcachedResourceType: ResourceTypeDefinition = {
  id: "memorystore-memcached",
  displayName: "Memorystore Memcached",
  pluralDisplayName: "Memorystore Memcached",
  description: "A Google Cloud Memorystore for Memcached instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "nodeCount", label: "Node Count", kind: "number", required: false },
    { key: "cpuCount", label: "vCPUs Per Node", kind: "number", required: false },
    { key: "memorySizeMb", label: "Memory Per Node (MB)", kind: "number", required: false },
    { key: "memcacheVersion", label: "Memcached Version", kind: "string", required: false },
    { key: "discoveryEndpoint", label: "Discovery Endpoint", kind: "string", required: false },
  ],
  outputs: [{ key: "discoveryEndpoint", label: "Discovery Endpoint", sensitive: false }],
  dashboardPinnable: true,
};
