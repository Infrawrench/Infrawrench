import { f, o, rt } from "@infrawrench/plugin-base";

export const VMResourceType = rt({
  name: "Virtual Machine",
  id: "azure-vm",
  description: "An Azure Virtual Machine",
  fields: [
    // Azure VM names are immutable; the only editable field is vmSize (the
    // right-sizing resize path), so everything else is locked out of Edit.
    f("name", "Name", { editable: false }),
    f("resourceGroup", "Resource Group", { editable: false }),
    f("location", "Location", { editable: false }),
    f("vmSize", "VM Size", {
      description:
        "ARM SKU, e.g. Standard_D2s_v5. Changing it resizes the VM (Azure restarts it during the change)",
    }),
    f("provisioningState", "Provisioning State", {
      editable: false,
      kind: "enum",
      enumValues: ["Succeeded", "Creating", "Updating", "Deleting", "Failed"],
    }),
    f("powerState", "Power State", { required: false, editable: false }),
    f("osType", "OS Type", { required: false, editable: false }),
    f("imageReference", "Image", { required: false, editable: false }),
    f("osDiskSizeGb", "OS Disk Size (GB)", { kind: "number", required: false, editable: false }),
    f("vnetName", "VNet", { required: false, editable: false }),
    f("subnetName", "Subnet", { required: false, editable: false }),
    f("networkResourceGroup", "Network Resource Group", {
      required: false,
      description: "Resource group holding the VNet the primary NIC sits in",
      editable: false,
    }),
    f("networkSecurityGroup", "Network Security Group", { required: false, editable: false }),
    f("publicIpName", "Public IP Address", { required: false, editable: false }),
    f("osDiskName", "OS Disk", { required: false, editable: false }),
    f("dataDiskNames", "Data Disks", { required: false, editable: false }),
    f("managedIdentities", "Managed Identities", { required: false, editable: false }),
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
  // Edit = change VM size only (Azure VM names are immutable).
  supportsUpdate: true,
  supportsMetrics: true,
  // Right-sizing: the create form's static SKU list carries capacity; prices
  // hydrate per region through getCreateSizePricing (keyless Retail Prices
  // API). Memory is "Available Memory Bytes" — an agentless platform metric.
  rightsizing: {
    sizeFieldKey: "vmSize",
    // The create form's size-picker key differs from the stored field.
    createSizeFieldKey: "size",
    regionFieldKey: "location",
    // The metrics module stores Azure Monitor's own localized names
    // (metric.name.localizedValue), not the descriptor labels.
    cpuMetric: { seriesLabel: "Percentage CPU" },
    memoryMetric: { seriesLabel: "Available Memory Bytes", interpretation: "available-bytes" },
    // Family letters + the suffix letters after the digits + version — keeps
    // D ↔ Dp (arm) and s/ms/ps variants apart: Standard_D4s_v5 → (D, s, v5).
    sizeFamilyPattern: "^Standard_([A-Z]+)\\d+([a-z]*)(?:_(v\\d+))?$",
    resizeNote:
      "Azure resizes a running VM but restarts it during the change. If the new size isn't available on the VM's current hardware cluster, deallocate the VM first and retry.",
  },
});
