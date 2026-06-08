import { f, o, rt } from "@infrawrench/plugin-base";

export const FloatingIpResourceType = rt({
  id: "floating-ip",
  name: "Floating IP",
  plural: "Floating IPs",
  description: "An OVHcloud Public Cloud floating IP",
  fields: [
    f("ip", "IP"),
    f("region", "Region"),
    f("status", "Status", { required: false }),
    f("networkId", "Network ID", { required: false }),
    f("associatedEntity", "Associated Entity", { required: false }),
  ],
  outputs: [o("ip", "IP")],
  iconKey: "ip",
});
