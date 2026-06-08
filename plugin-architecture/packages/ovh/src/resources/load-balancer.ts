import { f, o, rt } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType = rt({
  id: "load-balancer",
  name: "Load Balancer",
  description: "An OVHcloud Public Cloud load balancer",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("size", "Size", { kind: "enum", required: false, enumValues: ["SMALL", "MEDIUM", "LARGE"] }),
    f("status", "Status", { required: false }),
    f("address", "Address", { required: false }),
    f("description", "Description", { required: false }),
  ],
  outputs: [o("address", "Address")],
  supportsCreate: true,
  iconKey: "load-balancer",
});
