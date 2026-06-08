import { f, o, rt } from "@infrawrench/plugin-base";

export const NetworkResourceType = rt({
  name: "Network",
  id: "network",
  description: "A Hetzner Cloud private network with routes and subnets",
  fields: [
    f("name", "Name"),
    f("ipRange", "IP Range"),
    f("subnetCount", "Subnets", { kind: "number", required: false }),
    f("routeCount", "Routes", { kind: "number", required: false }),
    f("serverCount", "Servers", { kind: "number", required: false }),
    f("exposesRoutesToVswitch", "vSwitch Routes", { kind: "boolean", required: false }),
  ],
  outputs: [o("networkId", "Network ID")],
  iconKey: "network",
  attachTargets: [
    { pluginId: "hetzner", resourceTypeId: "server", verb: "Attach network" },
    { pluginId: "hetzner", resourceTypeId: "load-balancer", verb: "Attach network" },
  ],
});
