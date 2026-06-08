import { f, o, rt } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType = rt({
  name: "Load Balancer",
  pinnable: false,
  id: "load-balancer",
  description: "A Cloudflare Load Balancer",
  fields: [
    f("name", "Name"),
    f("fallbackPool", "Fallback Pool", { required: false }),
    f("defaultPools", "Default Pools", { required: false }),
    f("enabled", "Enabled", { kind: "boolean" }),
    f("proxied", "Proxied", { kind: "boolean", required: false }),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("steeringPolicy", "Steering Policy", { required: false }),
    f("createdOn", "Created", { required: false, editable: false }),
    f("modifiedOn", "Modified", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "load-balancer",
});
