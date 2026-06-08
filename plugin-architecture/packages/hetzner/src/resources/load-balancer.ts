import { f, o, rt } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType = rt({
  name: "Load Balancer",
  id: "load-balancer",
  description: "A Hetzner Cloud Load Balancer with services, targets, and public IPs",
  fields: [
    f("name", "Name"),
    f("status", "Status", { kind: "enum", enumValues: ["running", "initializing", "unknown"] }),
    f("type", "Type", { required: false }),
    f("location", "Location", { required: false }),
    f("ipv4", "IPv4", { required: false }),
    f("ipv6", "IPv6", { required: false }),
    f("targetCount", "Targets", { kind: "number", required: false }),
    f("serviceCount", "Services", { kind: "number", required: false }),
  ],
  outputs: [o("ipv4", "IPv4"), o("ipv6", "IPv6"), o("loadBalancerId", "Load Balancer ID")],
  iconKey: "load-balancer",
  supportsMetrics: true,
  attachTargets: [
    { pluginId: "hetzner", resourceTypeId: "server", matchField: "location", verb: "Add target" },
  ],
});
