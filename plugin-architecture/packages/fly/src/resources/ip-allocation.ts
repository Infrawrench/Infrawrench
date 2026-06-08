import { f, o, rt } from "@infrawrench/plugin-base";

export const IpAllocationResourceType = rt({
  name: "IP Allocation",
  id: "ip-allocation",
  description: "A public IPv4 or IPv6 allocation for a Fly.io app",
  parentTypeId: "app",
  fields: [
    f("address", "Address"),
    f("appName", "App"),
    f("type", "Type", { required: false }),
    f("region", "Region", { required: false }),
    f("network", "Network", { required: false }),
    f("private", "Private", { kind: "boolean", required: false }),
  ],
  outputs: [o("address", "Address")],
  iconKey: "network",
});
