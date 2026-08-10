import { f, o, rt } from "@infrawrench/plugin-base";

export const NfsShareResourceType = rt({
  name: "NFS Share",
  id: "nfs-share",
  description:
    "A DigitalOcean Network File Storage share — POSIX-compliant NFSv4.1 mountable across Droplets and DOKS nodes inside a VPC",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("sizeGib", "Size (GiB)", { kind: "number" }),
    f("performanceTier", "Performance Tier", {
      kind: "enum",
      required: false,
      enumValues: ["standard", "high-performance"],
    }),
    f("vpcIds", "VPC IDs", { required: false }),
    f("mountTarget", "Mount Target", { required: false }),
    f("status", "Status", { required: false }),
  ],
  outputs: [o("mountCommand", "Mount Command"), o("mountTarget", "Mount Target")],
  // Comma-joined `vpc_ids` — one edge per VPC the share is exported to.
  dependsOn: [{ fieldKey: "vpcIds", targetTypeId: "vpc", label: "exported to" }],
  parentTypeId: "project",
  showInSidebar: true,
  supportsCreate: true,
  iconKey: "nfs",
  attachTargets: [
    {
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      matchField: "region",
    },
  ],
});
