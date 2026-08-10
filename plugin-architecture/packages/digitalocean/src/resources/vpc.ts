import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean VPC network (`/v2/vpcs`). Every Droplet, NFS share and
 * Dedicated Inference endpoint already records the VPC uuid it lives in, so
 * listing VPCs is what turns those recorded uuids into real graph edges — the
 * `externalId` here is the VPC uuid those fields hold.
 *
 * The list payload carries no member count (DO exposes members on a separate
 * `/v2/vpcs/{id}/members` call), so there is no `resourceCount` field.
 */
export const VpcResourceType = rt({
  name: "VPC",
  id: "vpc",
  description:
    "A DigitalOcean VPC — a private network shared by the Droplets, DOKS nodes, NFS shares and Dedicated Inference endpoints placed in it.",
  fields: [
    f("name", "Name"),
    f("region", "Region", {
      description: "Region slug the VPC lives in, e.g. nyc3. Fixed at creation.",
    }),
    f("ipRange", "IP Range", {
      required: false,
      description: "Private CIDR block, e.g. 10.116.0.0/20. Assigned by DO when left blank.",
    }),
    f("description", "Description", { required: false }),
    f("isDefault", "Default", {
      kind: "boolean",
      required: false,
      description:
        "Whether new resources in this region land here when no VPC is specified. A region's default VPC cannot be deleted.",
    }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("vpcId", "VPC ID", { description: "The VPC uuid, as used by vpc_uuid / vpc_ids" })],
  supportsCreate: true,
  iconKey: "network",
});
