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
  // Drop an NFS share onto a droplet to allow that droplet's VPC to
  // mount it. DO grants NFS access at VPC scope, not per-droplet (per
  // nfs_actions.yml: `attach` action takes vpc_id), so the plugin
  // resolves the droplet's vpc_uuid and registers it on the share's
  // allowed VPCs. Region match isn't enforced by DO here, but a share
  // is only reachable from droplets sharing its region — the drop hint
  // would mislead otherwise, so the host enforces matchField=region.
  attachTargets: [
    {
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      matchField: "region",
    },
  ],
};
