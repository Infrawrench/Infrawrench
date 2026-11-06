import { f, o, rt } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType = rt({
  id: "load-balancer",
  name: "Load Balancer",
  description:
    "An OVHcloud Public Cloud load balancer from the older beta API; new deployments use the Public Cloud Load Balancer type",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true }),
    f("size", "Size", {
      showcase: true,
      kind: "enum",
      required: false,
      enumValues: ["SMALL", "MEDIUM", "LARGE"],
    }),
    f("status", "Status", { showcase: true, required: false }),
    f("address", "Address", { showcase: true, required: false }),
    f("description", "Description", { required: false }),
  ],
  outputs: [o("address", "Address")],
  supportsCreate: true,
  iconKey: "load-balancer",
});
