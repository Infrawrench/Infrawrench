import { f, o, rt } from "@infrawrench/plugin-base";
import { SCW_REGIONS } from "../locations.js";

export const PrivateNetworkResourceType = rt({
  id: "private-network",
  name: "Private Network",
  description: "A Scaleway VPC Private Network (vpc/v2)",
  fields: [
    f("name", "Name"),
    f("region", "Region", { kind: "enum", enumValues: SCW_REGIONS, editable: false }),
    f("subnets", "Subnets", { required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("dhcpEnabled", "DHCP", { kind: "boolean", required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
  ],
  outputs: [o("privateNetworkId", "Private Network ID")],
  supportsCreate: true,
  // Edit = rename (`PATCH /private-networks/{id}`).
  supportsUpdate: true,
  iconKey: "network",
});
