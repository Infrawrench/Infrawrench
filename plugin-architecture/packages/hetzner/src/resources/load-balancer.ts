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
    f("targetServerIds", "Target Servers", {
      required: false,
      description:
        "Comma-separated IDs of the servers traffic is routed to, including those resolved from label selectors",
    }),
    f("networkIds", "Networks", {
      required: false,
      description: "Comma-separated IDs of the private networks this load balancer is attached to",
    }),
  ],
  outputs: [o("ipv4", "IPv4"), o("ipv6", "IPv6"), o("loadBalancerId", "Load Balancer ID")],
  // Both are ids off the /load_balancers payload; each target type's
  // externalId is the same numeric id stringified.
  dependsOn: [
    { fieldKey: "targetServerIds", targetTypeId: "server", label: "routes to" },
    { fieldKey: "networkIds", targetTypeId: "network", label: "attached to" },
  ],
  iconKey: "load-balancer",
  supportsMetrics: true,
  attachTargets: [
    { pluginId: "hetzner", resourceTypeId: "server", matchField: "location", verb: "Add target" },
  ],
});
