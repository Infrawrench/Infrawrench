import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VMResourceType: ResourceTypeDefinition = {
  id: "azure-vm",
  displayName: "Virtual Machine",
  pluralDisplayName: "Virtual Machines",
  description: "An Azure Virtual Machine",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "vmSize", label: "VM Size", kind: "string", required: true },
    {
      key: "provisioningState",
      label: "Provisioning State",
      kind: "enum",
      required: true,
      enumValues: ["Succeeded", "Creating", "Updating", "Deleting", "Failed"],
    },
    { key: "powerState", label: "Power State", kind: "string", required: false },
    { key: "osType", label: "OS Type", kind: "string", required: false },
    { key: "imageReference", label: "Image", kind: "string", required: false },
    { key: "osDiskSizeGb", label: "OS Disk Size (GB)", kind: "number", required: false },
    {
      key: "network",
      label: "Virtual Network",
      kind: "association",
      required: false,
      description: "Virtual network to attach the VM to",
      allowLiteral: true,
      resolvableOutputKeys: ["resourceId"],
      resolvableFrom: [
        {
          pluginId: "azure",
          resourceTypeId: "azure-vnet",
          outputKey: "resourceId",
        },
      ],
    },
  ],
  outputs: [
    { key: "publicIp", label: "Public IP", sensitive: false },
    { key: "privateIp", label: "Private IP", sensitive: false },
    { key: "fqdn", label: "FQDN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "instance",
  sshEndpoint: {
    hostOutputKey: "publicIp",
    runningWhen: { fieldKey: "powerState", value: "VM running" },
    usernameFieldKey: "sshUsername",
  },
  supportsCreate: true,
  supportsMetrics: true,
};
