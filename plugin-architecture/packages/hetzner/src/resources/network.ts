import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NetworkResourceType: ResourceTypeDefinition = {
  id: "network",
  displayName: "Network",
  pluralDisplayName: "Networks",
  description: "A Hetzner Cloud private network with routes and subnets",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "ipRange", label: "IP Range", kind: "string", required: true },
    { key: "subnetCount", label: "Subnets", kind: "number", required: false },
    { key: "routeCount", label: "Routes", kind: "number", required: false },
    { key: "serverCount", label: "Servers", kind: "number", required: false },
    { key: "exposesRoutesToVswitch", label: "vSwitch Routes", kind: "boolean", required: false },
  ],
  outputs: [{ key: "networkId", label: "Network ID", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "network",
  attachTargets: [
    { pluginId: "hetzner", resourceTypeId: "server", verb: "Attach network" },
    { pluginId: "hetzner", resourceTypeId: "load-balancer", verb: "Attach network" },
  ],
};
