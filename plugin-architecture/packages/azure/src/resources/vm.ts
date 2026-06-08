import { f, o, rt } from "@infrawrench/plugin-base";

export const VMResourceType = rt({
  name: "Virtual Machine",
  id: "azure-vm",
  description: "An Azure Virtual Machine",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("vmSize", "VM Size"),
    f("provisioningState", "Provisioning State", {
      kind: "enum",
      enumValues: ["Succeeded", "Creating", "Updating", "Deleting", "Failed"],
    }),
    f("powerState", "Power State", { required: false }),
    f("osType", "OS Type", { required: false }),
    f("imageReference", "Image", { required: false }),
    f("osDiskSizeGb", "OS Disk Size (GB)", { kind: "number", required: false }),
    f("network", "Virtual Network", {
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
    }),
  ],
  outputs: [o("publicIp", "Public IP"), o("privateIp", "Private IP"), o("fqdn", "FQDN")],
  iconKey: "instance",
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "powerState", value: "VM running" },
    usernameFieldKey: "sshUsername",
  },
  supportsCreate: true,
  supportsMetrics: true,
});
