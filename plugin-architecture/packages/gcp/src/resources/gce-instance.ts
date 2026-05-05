import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const GceInstanceResourceType: ResourceTypeDefinition = {
  id: "gce-instance",
  displayName: "VM Instance",
  pluralDisplayName: "VM Instances",
  description: "A Google Compute Engine virtual machine instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "zone", label: "Zone", kind: "string", required: true },
    { key: "machineType", label: "Machine Type", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "networkTier", label: "Network Tier", kind: "string", required: false },
    {
      key: "network",
      label: "VPC Network",
      kind: "association",
      required: false,
      description: "VPC network to attach the instance to",
      allowLiteral: true,
      resolvableOutputKeys: ["selfLink"],
      resolvableFrom: [
        {
          pluginId: "gcp",
          resourceTypeId: "vpc-network",
          outputKey: "selfLink",
        },
      ],
    },
  ],
  outputs: [
    { key: "externalIp", label: "External IP", sensitive: false },
    { key: "internalIp", label: "Internal IP", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsMetrics: true,
  sshEndpoint: {
    hostOutputKey: "externalIp",
    runningWhen: { fieldKey: "status", value: "RUNNING" },
    usernameFieldKey: "sshUsername",
  },
  supportsCreate: true,
};
