import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getVMCreateConfig(ctx: AzureCreateContext): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: "VM Name",
        kind: "text",
        required: true,
        description: "Name for the virtual machine",
      },
      {
        key: "resourceGroup",
        label: "Resource Group",
        kind: "select",
        required: true,
        options: rgOptions,
      },
      {
        key: "region",
        label: "Region",
        kind: "region-picker",
        required: true,
        regions: AZURE_REGIONS,
      },
      {
        key: "size",
        label: "VM Size",
        kind: "size-picker",
        required: true,
        sizes: [
          {
            id: "Standard_B1s",
            label: "B1s",
            vcpus: 1,
            memoryMb: 1024,
            category: "Burstable",
          },
          {
            id: "Standard_B1ms",
            label: "B1ms",
            vcpus: 1,
            memoryMb: 2048,
            category: "Burstable",
          },
          {
            id: "Standard_B2s",
            label: "B2s",
            vcpus: 2,
            memoryMb: 4096,
            category: "Burstable",
          },
          {
            id: "Standard_B2ms",
            label: "B2ms",
            vcpus: 2,
            memoryMb: 8192,
            category: "Burstable",
          },
          {
            id: "Standard_B4ms",
            label: "B4ms",
            vcpus: 4,
            memoryMb: 16384,
            category: "Burstable",
          },
          {
            id: "Standard_D2s_v5",
            label: "D2s v5",
            vcpus: 2,
            memoryMb: 8192,
            category: "General purpose",
          },
          {
            id: "Standard_D4s_v5",
            label: "D4s v5",
            vcpus: 4,
            memoryMb: 16384,
            category: "General purpose",
          },
          {
            id: "Standard_D8s_v5",
            label: "D8s v5",
            vcpus: 8,
            memoryMb: 32768,
            category: "General purpose",
          },
          {
            id: "Standard_D16s_v5",
            label: "D16s v5",
            vcpus: 16,
            memoryMb: 65536,
            category: "General purpose",
          },
          {
            id: "Standard_D32s_v5",
            label: "D32s v5",
            vcpus: 32,
            memoryMb: 131072,
            category: "General purpose",
          },
          {
            id: "Standard_E2s_v5",
            label: "E2s v5",
            vcpus: 2,
            memoryMb: 16384,
            category: "Memory optimized",
          },
          {
            id: "Standard_E4s_v5",
            label: "E4s v5",
            vcpus: 4,
            memoryMb: 32768,
            category: "Memory optimized",
          },
          {
            id: "Standard_E8s_v5",
            label: "E8s v5",
            vcpus: 8,
            memoryMb: 65536,
            category: "Memory optimized",
          },
          {
            id: "Standard_F2s_v2",
            label: "F2s v2",
            vcpus: 2,
            memoryMb: 4096,
            category: "Compute optimized",
          },
          {
            id: "Standard_F4s_v2",
            label: "F4s v2",
            vcpus: 4,
            memoryMb: 8192,
            category: "Compute optimized",
          },
          {
            id: "Standard_F8s_v2",
            label: "F8s v2",
            vcpus: 8,
            memoryMb: 16384,
            category: "Compute optimized",
          },
        ],
      },
      {
        key: "image",
        label: "OS Image",
        kind: "image-picker",
        required: true,
        images: [
          {
            id: "Canonical:0001-com-ubuntu-server-jammy:22_04-lts:latest",
            label: "Ubuntu 22.04 LTS",
            family: "ubuntu",
            category: "Ubuntu",
          },
          {
            id: "Canonical:ubuntu-24_04-lts:server:latest",
            label: "Ubuntu 24.04 LTS",
            family: "ubuntu",
            category: "Ubuntu",
          },
          {
            id: "Canonical:0001-com-ubuntu-server-focal:20_04-lts:latest",
            label: "Ubuntu 20.04 LTS",
            family: "ubuntu",
            category: "Ubuntu",
          },
          {
            id: "Debian:debian-12:12:latest",
            label: "Debian 12",
            family: "debian",
            category: "Debian",
          },
          {
            id: "Debian:debian-11:11:latest",
            label: "Debian 11",
            family: "debian",
            category: "Debian",
          },
          {
            id: "RedHat:RHEL:9-lvm:latest",
            label: "RHEL 9",
            family: "rhel",
            category: "Red Hat",
          },
          {
            id: "RedHat:RHEL:8-lvm:latest",
            label: "RHEL 8",
            family: "rhel",
            category: "Red Hat",
          },
          {
            id: "OpenLogic:CentOS:7_9:latest",
            label: "CentOS 7.9",
            family: "centos",
            category: "CentOS",
          },
          {
            id: "SUSE:sles-15-sp5:gen2:latest",
            label: "SLES 15 SP5",
            family: "suse",
            category: "SUSE",
          },
          {
            id: "MicrosoftWindowsServer:WindowsServer:2022-datacenter-g2:latest",
            label: "Windows Server 2022",
            family: "windows",
            category: "Windows",
          },
          {
            id: "MicrosoftWindowsServer:WindowsServer:2019-datacenter-gensecond:latest",
            label: "Windows Server 2019",
            family: "windows",
            category: "Windows",
          },
        ],
      },
      {
        key: "bootDiskSizeGb",
        label: "Boot Disk Size",
        kind: "disk-slider",
        required: true,
        minGb: 30,
        maxGb: 4095,
        defaultGb: 64,
        stepGb: 1,
      },
      {
        key: "sshKey",
        label: "SSH Public Key",
        kind: "ssh-key-picker",
        required: false,
        description: "SSH public key for Linux VMs",
      },
      {
        key: "adminUsername",
        label: "Admin Username",
        kind: "text",
        required: true,
        defaultValue: "azureuser",
        description: "Username for the VM administrator account",
      },
      {
        key: "addExtraDisk",
        label: "Extra Managed Disk",
        kind: "select",
        required: false,
        defaultValue: "false",
        options: [
          { id: "false", label: "None" },
          { id: "true", label: "Add an extra data disk" },
        ],
      },
      {
        key: "extraDiskSizeGb",
        label: "Extra Disk Size",
        kind: "disk-slider",
        required: false,
        minGb: 32,
        maxGb: 32767,
        defaultGb: 128,
        stepGb: 32,
        showWhen: { fieldKey: "addExtraDisk", fieldValue: "true" },
      },
      {
        key: "extraDiskSku",
        label: "Extra Disk SKU",
        kind: "select",
        required: false,
        defaultValue: "Premium_LRS",
        options: [
          { id: "Standard_LRS", label: "Standard HDD" },
          { id: "StandardSSD_LRS", label: "Standard SSD" },
          { id: "Premium_LRS", label: "Premium SSD" },
        ],
        showWhen: { fieldKey: "addExtraDisk", fieldValue: "true" },
      },
      {
        key: "network",
        label: "Virtual Network",
        kind: "resource-picker",
        required: false,
        description: "Virtual network to attach the VM to",
        associationSources: [
          { pluginId: "azure", resourceTypeId: "azure-vnet", outputKey: "resourceId" },
        ],
      },
      {
        key: "securityGroup",
        label: "Network Security Group (firewall)",
        kind: "resource-picker",
        required: false,
        description: "Apply an existing NSG to the VM. Leave blank to auto-create one.",
        associationSources: [
          { pluginId: "azure", resourceTypeId: "azure-nsg", outputKey: "resourceId" },
        ],
      },
    ],
  };
}

export async function createVM(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const vmSize = fields["size"]!;
  const adminUsername = fields["adminUsername"] ?? "azureuser";
  const sshKey = fields["sshKey"] ?? "";
  const bootDiskSizeGb = Number(fields["bootDiskSizeGb"] ?? "64");

  // Parse image reference (publisher:offer:sku:version)
  const imageParts = (fields["image"] ?? "").split(":");
  const imageReference = {
    publisher: imageParts[0] ?? "",
    offer: imageParts[1] ?? "",
    sku: imageParts[2] ?? "",
    version: imageParts[3] ?? "latest",
  };

  const isLinux = !imageReference.publisher.toLowerCase().includes("windows");

  // Step 1: Create or reuse a VNet + Subnet
  const vnetName = `${name}-vnet`;
  const subnetName = "default";
  await ctx.put(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${vnetName}?api-version=2023-09-01`,
    {
      location,
      properties: {
        addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
        subnets: [{ name: subnetName, properties: { addressPrefix: "10.0.0.0/24" } }],
      },
    },
  );
  const subnetId = `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${vnetName}/subnets/${subnetName}`;

  // Step 2: Create a public IP
  const pipName = `${name}-pip`;
  const pipResult = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/publicIPAddresses/${pipName}?api-version=2023-09-01`,
    {
      location,
      sku: { name: "Standard" },
      properties: { publicIPAllocationMethod: "Static" },
    },
  );
  const pipId = String(pipResult["id"] ?? "");

  // Step 3: Resolve NSG. If the caller picked an existing NSG via the
  // resource-picker field, use it; otherwise auto-create one with a default
  // SSH (Linux) or RDP (Windows) allow rule.
  let nsgId = fields["securityGroup"]?.trim() ?? "";
  if (!nsgId) {
    const nsgName = `${name}-nsg`;
    const nsgRules = isLinux
      ? [
          {
            name: "AllowSSH",
            properties: {
              protocol: "Tcp",
              sourceAddressPrefix: "*",
              destinationAddressPrefix: "*",
              sourcePortRange: "*",
              destinationPortRange: "22",
              access: "Allow",
              priority: 1000,
              direction: "Inbound",
            },
          },
        ]
      : [
          {
            name: "AllowRDP",
            properties: {
              protocol: "Tcp",
              sourceAddressPrefix: "*",
              destinationAddressPrefix: "*",
              sourcePortRange: "*",
              destinationPortRange: "3389",
              access: "Allow",
              priority: 1000,
              direction: "Inbound",
            },
          },
        ];
    const nsgResult = await ctx.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/networkSecurityGroups/${nsgName}?api-version=2023-09-01`,
      { location, properties: { securityRules: nsgRules } },
    );
    nsgId = String(nsgResult["id"] ?? "");
  }

  // Step 4: Create a NIC
  const nicName = `${name}-nic`;
  const nicResult = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/networkInterfaces/${nicName}?api-version=2023-09-01`,
    {
      location,
      properties: {
        networkSecurityGroup: { id: nsgId },
        ipConfigurations: [
          {
            name: "ipconfig1",
            properties: {
              subnet: { id: subnetId },
              publicIPAddress: { id: pipId },
              privateIPAllocationMethod: "Dynamic",
            },
          },
        ],
      },
    },
  );
  const nicId = String(nicResult["id"] ?? "");

  // Step 5: Create the VM
  const addExtraDisk = fields["addExtraDisk"] === "true";
  const extraDiskSizeGb = Number(fields["extraDiskSizeGb"] ?? 128);
  const extraDiskSku = fields["extraDiskSku"] ?? "Premium_LRS";
  const vmBody: Record<string, unknown> = {
    location,
    properties: {
      hardwareProfile: { vmSize },
      storageProfile: {
        imageReference,
        osDisk: {
          createOption: "FromImage",
          diskSizeGB: bootDiskSizeGb,
          managedDisk: { storageAccountType: "Premium_LRS" },
        },
        ...(addExtraDisk
          ? {
              dataDisks: [
                {
                  lun: 0,
                  name: `${name}-data`,
                  createOption: "Empty",
                  diskSizeGB: extraDiskSizeGb,
                  managedDisk: { storageAccountType: extraDiskSku },
                },
              ],
            }
          : {}),
      },
      osProfile: {
        computerName: name,
        adminUsername,
        ...(isLinux && sshKey
          ? {
              linuxConfiguration: {
                disablePasswordAuthentication: true,
                ssh: {
                  publicKeys: [
                    {
                      path: `/home/${adminUsername}/.ssh/authorized_keys`,
                      keyData: sshKey,
                    },
                  ],
                },
              },
            }
          : {}),
      },
      networkProfile: {
        networkInterfaces: [{ id: nicId, properties: { primary: true } }],
      },
    },
  };

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${name}?api-version=2024-03-01`,
    vmBody,
  );

  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-vm", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-vm",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      vmSize,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      powerState: "",
      osType: isLinux ? "Linux" : "Windows",
      imageReference: `${imageReference.publisher}/${imageReference.offer}/${imageReference.sku}`,
      osDiskSizeGb: bootDiskSizeGb,
      sshUsername: adminUsername,
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
