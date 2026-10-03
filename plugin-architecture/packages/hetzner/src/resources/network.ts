import { f, o, rt } from "@infrawrench/plugin-base";

export const NetworkResourceType = rt({
  name: "Network",
  id: "network",
  description: "A Hetzner Cloud private network with routes and subnets",
  fields: [
    f("name", "Name"),
    f("ipRange", "IP Range", { editable: false }),
    f("subnetCount", "Subnets", { kind: "number", required: false, editable: false }),
    f("routeCount", "Routes", { kind: "number", required: false, editable: false }),
    f("serverCount", "Servers", { kind: "number", required: false, editable: false }),
    f("serverIds", "Server IDs", {
      required: false,
      description: "Comma-separated IDs of the servers attached to this network",
      editable: false,
    }),
    f("loadBalancerIds", "Load Balancer IDs", {
      required: false,
      description: "Comma-separated IDs of the load balancers attached to this network",
      editable: false,
    }),
    f("exposesRoutesToVswitch", "vSwitch Routes", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("networkId", "Network ID")],
  // Plain id arrays on the /networks payload; each target type's externalId is
  // the same numeric id stringified.
  dependsOn: [
    { fieldKey: "serverIds", targetTypeId: "server", label: "attached" },
    { fieldKey: "loadBalancerIds", targetTypeId: "load-balancer", label: "attached" },
  ],
  supportsCreate: true,
  // Edit = `PUT` on the object itself (name, plus the fields left editable).
  supportsUpdate: true,
  iconKey: "network",
  attachTargets: [
    { pluginId: "hetzner", resourceTypeId: "server", verb: "Attach network" },
    { pluginId: "hetzner", resourceTypeId: "load-balancer", verb: "Attach network" },
  ],
});
