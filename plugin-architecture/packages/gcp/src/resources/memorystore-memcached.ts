import { f, o, rt } from "@infrawrench/plugin-base";

export const MemorystoreMemcachedResourceType = rt({
  name: "Memorystore Memcached",
  plural: "Memorystore Memcached",
  id: "memorystore-memcached",
  description: "A Google Cloud Memorystore for Memcached instance",
  fields: [
    f("name", "Name"),
    f("location", "Location"),
    f("state", "State", { required: false }),
    f("nodeCount", "Node Count", { kind: "number", required: false }),
    f("cpuCount", "vCPUs Per Node", { kind: "number", required: false }),
    f("memorySizeMb", "Memory Per Node (MB)", { kind: "number", required: false }),
    f("memcacheVersion", "Memcached Version", { required: false }),
    f("discoveryEndpoint", "Discovery Endpoint", { required: false }),
    f("authorizedNetwork", "Authorized Network", {
      required: false,
      description: "Name of the VPC network the instance is connected to",
    }),
  ],
  outputs: [o("discoveryEndpoint", "Discovery Endpoint")],
  // The API returns the full network name; the lister keeps its last segment,
  // which is what a vpc-network's `name` field holds.
  dependsOn: [
    {
      fieldKey: "authorizedNetwork",
      targetTypeId: "vpc-network",
      targetKey: "name",
      label: "in network",
    },
  ],
  supportsCreate: true,
});
