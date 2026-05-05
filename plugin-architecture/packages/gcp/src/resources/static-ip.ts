import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const StaticIpResourceType: ResourceTypeDefinition = {
  id: "static-ip",
  displayName: "Static IP",
  pluralDisplayName: "Static IPs",
  description: "A Google Cloud reserved static external IP address",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "address", label: "Address", kind: "string", required: false },
    { key: "addressType", label: "Type", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "networkTier", label: "Network Tier", kind: "string", required: false },
    { key: "ipVersion", label: "IP Version", kind: "string", required: false },
    // Drag/Attach surface: the VM this static IP is attached to (optional until attached)
    {
      key: "attachedVmName",
      label: "Attached VM",
      kind: "string",
      required: false,
      description: "Name of the VM this static IP is attached to (if any)",
    },
    {
      key: "attachedVmZone",
      label: "Attached VM Zone",
      kind: "string",
      required: false,
      description: "Zone of the VM this static IP is attached to (if any)",
    },
  ],
  outputs: [{ key: "address", label: "IP Address", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  attachTargets: [
    {
      pluginId: "gcp",
      resourceTypeId: "gce-instance",
      // Optional: allow drop onto VMs to attach the IP
      verb: "attach",
    },
  ],
};
