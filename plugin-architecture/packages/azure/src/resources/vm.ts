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
    f("vnetName", "VNet", { required: false }),
    f("subnetName", "Subnet", { required: false }),
    f("networkResourceGroup", "Network Resource Group", {
      required: false,
      description: "Resource group holding the VNet the primary NIC sits in",
    }),
    f("networkSecurityGroup", "Network Security Group", { required: false }),
    f("publicIpName", "Public IP Address", { required: false }),
    f("osDiskName", "OS Disk", { required: false }),
    f("dataDiskNames", "Data Disks", { required: false }),
    f("managedIdentities", "Managed Identities", { required: false }),
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
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    {
      fieldKey: "vnetName",
      targetTypeId: "azure-vnet",
      matchTemplate: "{networkResourceGroup}/{vnetName}",
      label: "in VNet",
    },
    {
      fieldKey: "subnetName",
      targetTypeId: "azure-subnet",
      matchTemplate: "{networkResourceGroup}/{vnetName}/{subnetName}",
      label: "in subnet",
    },
    {
      fieldKey: "networkSecurityGroup",
      targetTypeId: "azure-nsg",
      targetKey: "name",
      label: "guarded by",
    },
    {
      fieldKey: "publicIpName",
      targetTypeId: "azure-public-ip",
      targetKey: "name",
      label: "reachable at",
    },
    { fieldKey: "osDiskName", targetTypeId: "azure-disk", targetKey: "name", label: "boots from" },
    {
      fieldKey: "dataDiskNames",
      targetTypeId: "azure-disk",
      targetKey: "name",
      label: "data disk",
    },
    {
      fieldKey: "managedIdentities",
      targetTypeId: "azure-managed-identity",
      targetKey: "name",
      label: "runs as",
    },
  ],
  iconKey: "instance",
  // Sleep/wake schedules: virtualMachines start / deallocate. Deallocate (not
  // powerOff) releases the compute so VM billing stops; disks and public IPs
  // keep billing. Values are the instance-view display statuses the lister
  // stores ("VM running", "VM deallocated", …).
  lifecycle: {
    startActionId: "start",
    stopActionId: "deallocate",
    statusFieldKey: "powerState",
    runningValues: ["VM running", "VM starting"],
    stoppedValues: ["VM deallocated", "VM deallocating", "VM stopped"],
  },
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "powerState", value: "VM running" },
    usernameFieldKey: "sshUsername",
  },
  supportsCreate: true,
  supportsMetrics: true,
});
