import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NfsShareResourceType: ResourceTypeDefinition = {
  id: "nfs-share",
  displayName: "NFS Share",
  pluralDisplayName: "NFS Shares",
  description:
    "A DigitalOcean Network File Storage share — POSIX-compliant NFSv4.1 mountable across Droplets and DOKS nodes inside a VPC",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "sizeGib", label: "Size (GiB)", kind: "number", required: true },
    {
      key: "performanceTier",
      label: "Performance Tier",
      kind: "enum",
      required: false,
      enumValues: ["standard", "high-performance"],
    },
    { key: "vpcIds", label: "VPC IDs", kind: "string", required: false },
    { key: "mountTarget", label: "Mount Target", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
  ],
  outputs: [
    { key: "mountCommand", label: "Mount Command", sensitive: false },
    { key: "mountTarget", label: "Mount Target", sensitive: false },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "nfs",
};
