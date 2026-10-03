import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean load balancer (`/v2/load_balancers`). Covers all three
 * flavours DO sells: the regional HTTP load balancer, the regional network
 * (TCP/UDP) load balancer, and the global load balancer that fronts other
 * regional load balancers.
 *
 * Shape verified against digitalocean/openapi
 * (`specification/resources/load_balancers/models/load_balancer_base.yml`).
 * `size_unit` is the node count that replaced the deprecated `size` slug;
 * `region` comes back as a full region object and is flattened to its slug.
 */
export const LoadBalancerResourceType = rt({
  name: "Load Balancer",
  id: "load-balancer",
  description: "A DigitalOcean load balancer: regional HTTP, regional network (TCP/UDP) or global.",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false, editable: false }),
    f("lbType", "Type", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["REGIONAL", "REGIONAL_NETWORK", "GLOBAL"],
      description: "Fixed at creation.",
    }),
    f("network", "Network", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["EXTERNAL", "INTERNAL"],
      description: "Internal load balancers have no public IP. Fixed at creation.",
    }),
    f("sizeUnit", "Nodes", {
      kind: "number",
      required: false,
      description:
        "Number of load balancer nodes (1-100). Each node adds connection capacity and is billed separately. DO allows one resize per hour.",
    }),
    f("redirectHttpToHttps", "Redirect HTTP to HTTPS", {
      kind: "boolean",
      required: false,
      description: "Redirect port 80 requests to HTTPS on 443.",
    }),
    f("httpIdleTimeoutSeconds", "HTTP Idle Timeout (s)", {
      kind: "number",
      required: false,
      description: "Idle timeout for HTTP connections to the target Droplets, 30-600 seconds.",
    }),
    f("enableProxyProtocol", "PROXY Protocol", { kind: "boolean", required: false }),
    f("enableBackendKeepalive", "Backend Keepalive", { kind: "boolean", required: false }),
    f("tlsCipherPolicy", "TLS Cipher Policy", {
      kind: "enum",
      required: false,
      enumValues: ["DEFAULT", "STRONG"],
    }),
    f("status", "Status", { required: false, editable: false }),
    f("dropletIds", "Target Droplet IDs", {
      required: false,
      editable: false,
      description:
        "Comma-separated Droplet IDs behind the load balancer. Empty when targets are chosen by tag.",
    }),
    f("dropletTag", "Target Tag", {
      required: false,
      editable: false,
      description: "Droplet tag that selects the targets, when the load balancer uses one.",
    }),
    f("forwardingRules", "Forwarding Rules", {
      required: false,
      editable: false,
      description: "entry → target, e.g. https:443 → http:80",
    }),
    f("vpcUuid", "VPC", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [
    o("ip", "Public IPv4"),
    o("ipv6", "Public IPv6"),
    o("loadBalancerId", "Load Balancer ID"),
  ],
  dependsOn: [
    { fieldKey: "dropletIds", targetTypeId: "droplet", label: "routes to" },
    { fieldKey: "vpcUuid", targetTypeId: "vpc", label: "in VPC" },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "load-balancer",
  /**
   * A load balancer bills per node whether or not anything sits behind it.
   * The lister always writes both target fields (`""` when unset), so a
   * regional load balancer with neither Droplets nor a tag is pure cost.
   * Global load balancers target other load balancers, not Droplets, so the
   * `lbType` guard keeps them out.
   */
  orphanRule: {
    conditions: [
      { fieldKey: "dropletIds", when: "equals", value: "" },
      { fieldKey: "dropletTag", when: "equals", value: "" },
      { fieldKey: "lbType", when: "equals", value: "REGIONAL" },
    ],
    reason: "Load balancer has no target Droplets (DigitalOcean bills every node regardless)",
  },
});
