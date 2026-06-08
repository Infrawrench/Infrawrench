import { f, rt } from "@infrawrench/plugin-base";

export const PrivateNetworkResourceType = rt({
  id: "private-network",
  name: "Private Network",
  description: "An OVHcloud Public Cloud private network",
  fields: [
    f("name", "Name"),
    f("regions", "Regions", { required: false }),
    f("vlanId", "VLAN ID", { kind: "number", required: false }),
    f("status", "Status", { required: false }),
    f("type", "Type", { required: false }),
  ],
  supportsCreate: true,
  iconKey: "network",
});
