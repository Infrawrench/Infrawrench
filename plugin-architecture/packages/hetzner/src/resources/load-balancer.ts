import { f, o, rt } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType = rt({
  name: "Load Balancer",
  id: "load-balancer",
  description: "A Hetzner Cloud Load Balancer with services, targets, and public IPs",
  equivalence: "load-balancer",
  fields: [
    f("name", "Name"),
    f("targetHealth", "Target Health", {
      showcase: true,
      kind: "enum",
      enumValues: ["healthy", "degraded", "unhealthy", "unknown"],
      required: false,
      description:
        "Health checks across every target and service port. Unknown means no check has reported yet, including a load balancer with no targets",
      editable: false,
    }),
    f("type", "Type", { required: false, editable: false }),
    f("location", "Location", {
      showcase: true,
      required: false,
      editable: false,
      sizing: "region",
    }),
    f("ipv4", "IPv4", { required: false, editable: false }),
    f("ipv6", "IPv6", { required: false, editable: false }),
    f("targetCount", "Targets", {
      showcase: true,
      kind: "number",
      required: false,
      editable: false,
    }),
    f("serviceCount", "Services", {
      showcase: true,
      kind: "number",
      required: false,
      editable: false,
      usage: { limit: { field: "maxServices" }, unit: "services" },
    }),
    // `load_balancer_type.max_targets` / `max_services` on GET
    // /load_balancers: "Number of targets a single Load Balancer can have",
    // "Number of services a Load Balancer of this type can have"
    // (https://docs.hetzner.cloud/cloud.spec.json, read 2026-11-23). Only
    // services carry a usage: the docs do not say whether a label selector
    // counts as one target or as each server it matches.
    f("maxTargets", "Max Targets", { kind: "number", required: false, editable: false }),
    f("maxServices", "Max Services", { kind: "number", required: false, editable: false }),
    // Same traffic pair as a server: outbound bytes this billing period
    // against the type's free monthly allowance.
    f("outgoingTrafficBytes", "Outgoing Traffic (bytes)", {
      kind: "number",
      required: false,
      editable: false,
      usage: {
        limit: { field: "includedTrafficBytes" },
        unit: "bytes",
        cycle: { period: "monthly", anchorDay: 1 },
        label: "Traffic",
      },
    }),
    f("includedTrafficBytes", "Included Traffic (bytes)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("targetServerIds", "Target Servers", {
      required: false,
      description:
        "Comma-separated IDs of the servers traffic is routed to, including those resolved from label selectors",
      editable: false,
    }),
    f("networkIds", "Networks", {
      required: false,
      description: "Comma-separated IDs of the private networks this load balancer is attached to",
      editable: false,
    }),
  ],
  outputs: [o("ipv4", "IPv4"), o("ipv6", "IPv6"), o("loadBalancerId", "Load Balancer ID")],
  // Both are ids off the /load_balancers payload; each target type's
  // externalId is the same numeric id stringified.
  dependsOn: [
    { fieldKey: "targetServerIds", targetTypeId: "server", label: "routes to" },
    { fieldKey: "networkIds", targetTypeId: "network", label: "attached to" },
  ],
  supportsCreate: true,
  // Edit = `PUT` on the object itself (name, plus the fields left editable).
  supportsUpdate: true,
  iconKey: "load-balancer",
  supportsMetrics: true,
  attachTargets: [
    { pluginId: "hetzner", resourceTypeId: "server", matchField: "location", verb: "Add target" },
  ],
});
