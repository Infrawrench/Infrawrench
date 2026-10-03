import { f, o, rt } from "@infrawrench/plugin-base";
import { SCW_ZONES } from "../locations.js";

export const LoadBalancerResourceType = rt({
  id: "load-balancer",
  name: "Load Balancer",
  description: "A Scaleway Load Balancer (lb/v1)",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("zone", "Zone", { kind: "enum", enumValues: SCW_ZONES, editable: false }),
    f("type", "Type", { description: "Offer, e.g. LB-S, LB-GP-M", editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("ipAddresses", "IP Addresses", { required: false, editable: false }),
    f("frontendCount", "Frontends", { kind: "number", required: false, editable: false }),
    f("backendCount", "Backends", { kind: "number", required: false, editable: false }),
    f("privateNetworkCount", "Private Networks", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("sslCompatibilityLevel", "TLS Compatibility", {
      kind: "enum",
      required: false,
      enumValues: [
        "ssl_compatibility_level_intermediate",
        "ssl_compatibility_level_modern",
        "ssl_compatibility_level_old",
      ],
    }),
    f("tags", "Tags", { required: false, description: "Comma-separated" }),
  ],
  outputs: [o("ipv4", "Public IPv4"), o("ipv6", "Public IPv6")],
  supportsCreate: true,
  // Edit = `PUT /lbs/{id}`: name, description, tags and TLS level.
  supportsUpdate: true,
  iconKey: "load-balancer",
});
