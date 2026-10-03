import { f, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean VPC peering (`/v2/vpc_peerings`): a private route between
 * exactly two VPCs, within or across regions. Only the name is mutable.
 */
export const VpcPeeringResourceType = rt({
  name: "VPC Peering",
  id: "vpc-peering",
  description: "A private connection between two DigitalOcean VPCs.",
  fields: [
    f("name", "Name", { description: "Letters, digits and dashes only. Unique per team." }),
    f("status", "Status", { required: false, editable: false }),
    f("vpcIds", "VPCs", {
      required: false,
      editable: false,
      description: "The two peered VPC UUIDs, comma-separated.",
    }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "vpcIds", targetTypeId: "vpc", label: "peers" }],
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "network",
});
