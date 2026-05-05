import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";

const ARM = "https://management.azure.com";

export interface AzureCreateContext {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body: unknown): Promise<T>;
  put<T>(url: string, body: unknown): Promise<T>;
  patch<T>(url: string, body: unknown): Promise<T>;
  del(url: string): Promise<void>;
  makeId(accountId: string, typeId: string, externalId: string): string;
  graphRequest<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  subscriptionId: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

async function fetchResourceGroups(ctx: AzureCreateContext) {
  const rgs = await ctx.get<{ value: Array<{ name: string }> }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourcegroups?api-version=2022-09-01`,
  );
  return (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
}

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

export async function getAKSCreateConfig(ctx: AzureCreateContext): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: "Cluster Name",
        kind: "text",
        required: true,
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
        key: "kubernetesVersion",
        label: "Kubernetes Version",
        kind: "select",
        required: true,
        options: [
          { id: "1.30", label: "1.30" },
          { id: "1.29", label: "1.29" },
          { id: "1.28", label: "1.28" },
        ],
        defaultValue: "1.30",
      },
      {
        key: "nodeSize",
        label: "Node VM Size",
        kind: "size-picker",
        required: true,
        sizes: [
          {
            id: "Standard_B2s",
            label: "B2s",
            vcpus: 2,
            memoryMb: 4096,
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
        ],
      },
      {
        key: "nodeCount",
        label: "Node Count",
        kind: "number",
        required: true,
        defaultValue: "3",
        minValue: 1,
        maxValue: 100,
      },
    ],
  };
}

export async function getStorageAccountCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: "Storage Account Name",
        kind: "text",
        required: true,
        description: "Globally unique name (3-24 lowercase letters/numbers)",
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
        key: "sku",
        label: "Performance / Replication",
        kind: "select",
        required: true,
        defaultValue: "Standard_LRS",
        options: [
          { id: "Standard_LRS", label: "Standard LRS" },
          { id: "Standard_GRS", label: "Standard GRS" },
          { id: "Standard_ZRS", label: "Standard ZRS" },
          { id: "Standard_RAGRS", label: "Standard RA-GRS" },
          { id: "Premium_LRS", label: "Premium LRS" },
        ],
      },
      {
        key: "kind",
        label: "Kind",
        kind: "select",
        required: true,
        defaultValue: "StorageV2",
        options: [
          { id: "StorageV2", label: "General Purpose v2" },
          { id: "BlobStorage", label: "Blob Storage" },
          { id: "BlockBlobStorage", label: "Block Blob Storage" },
        ],
      },
    ],
  };
}

export async function getCosmosDBCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: "Account Name",
        kind: "text",
        required: true,
        description: "Globally unique Cosmos DB account name",
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
        key: "kind",
        label: "API",
        kind: "select",
        required: true,
        defaultValue: "GlobalDocumentDB",
        options: [
          { id: "GlobalDocumentDB", label: "NoSQL (Core)" },
          { id: "MongoDB", label: "MongoDB" },
        ],
      },
      {
        key: "consistencyLevel",
        label: "Consistency Level",
        kind: "select",
        required: true,
        defaultValue: "Session",
        options: [
          { id: "Strong", label: "Strong" },
          { id: "BoundedStaleness", label: "Bounded Staleness" },
          { id: "Session", label: "Session" },
          { id: "ConsistentPrefix", label: "Consistent Prefix" },
          { id: "Eventual", label: "Eventual" },
        ],
      },
    ],
  };
}

export async function getRedisCacheCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: "Redis Cache Name",
        kind: "text",
        required: true,
        description: "Globally unique DNS name",
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
        key: "sku",
        label: "Pricing Tier",
        kind: "select",
        required: true,
        defaultValue: "Basic",
        options: [
          { id: "Basic", label: "Basic" },
          { id: "Standard", label: "Standard" },
          { id: "Premium", label: "Premium" },
        ],
      },
      {
        key: "capacity",
        label: "Cache Size",
        kind: "select",
        required: true,
        defaultValue: "0",
        options: [
          { id: "0", label: "C0 (250 MB)" },
          { id: "1", label: "C1 (1 GB)" },
          { id: "2", label: "C2 (2.5 GB)" },
          { id: "3", label: "C3 (6 GB)" },
          { id: "4", label: "C4 (13 GB)" },
          { id: "5", label: "C5 (26 GB)" },
          { id: "6", label: "C6 (53 GB)" },
        ],
      },
    ],
  };
}

export async function getFlexibleDBCreateConfig(
  ctx: AzureCreateContext,
  dbEngine: string,
  versions: string[],
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: `${dbEngine} Server Name`,
        kind: "text",
        required: true,
        description: `Globally unique ${dbEngine} server name`,
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
        key: "version",
        label: `${dbEngine} Version`,
        kind: "select",
        required: true,
        defaultValue: versions[0]!,
        options: versions.map((v) => ({ id: v, label: v })),
      },
      {
        key: "sku",
        label: "Compute Tier",
        kind: "size-picker",
        required: true,
        sizes: [
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
            id: "Standard_D2ds_v4",
            label: "D2ds v4",
            vcpus: 2,
            memoryMb: 8192,
            category: "General Purpose",
          },
          {
            id: "Standard_D4ds_v4",
            label: "D4ds v4",
            vcpus: 4,
            memoryMb: 16384,
            category: "General Purpose",
          },
          {
            id: "Standard_D8ds_v4",
            label: "D8ds v4",
            vcpus: 8,
            memoryMb: 32768,
            category: "General Purpose",
          },
          {
            id: "Standard_E2ds_v4",
            label: "E2ds v4",
            vcpus: 2,
            memoryMb: 16384,
            category: "Memory Optimized",
          },
          {
            id: "Standard_E4ds_v4",
            label: "E4ds v4",
            vcpus: 4,
            memoryMb: 32768,
            category: "Memory Optimized",
          },
        ],
      },
      {
        key: "storageSizeGb",
        label: "Storage Size",
        kind: "disk-slider",
        required: true,
        minGb: 32,
        maxGb: 16384,
        defaultGb: 128,
        stepGb: 32,
      },
      {
        key: "adminUsername",
        label: "Admin Username",
        kind: "text",
        required: true,
        defaultValue: "adminuser",
      },
      {
        key: "adminPassword",
        label: "Admin Password",
        kind: "text",
        required: true,
        description: "Must meet Azure password complexity requirements",
      },
    ],
  };
}

export async function getSQLDatabaseCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  // List existing SQL servers
  const servers = await ctx.get<{ value: Array<{ name: string; id: string }> }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Sql/servers?api-version=2023-05-01-preview`,
  );
  const serverOptions = (servers.value ?? []).map((s) => {
    const sRg = s.id.match(/resourceGroups\/([^/]+)/i)?.[1] ?? "";
    return { id: `${sRg}/${s.name}`, label: s.name };
  });

  return {
    fields: [
      { key: "databaseName", label: "Database Name", kind: "text", required: true },
      ...(serverOptions.length > 0
        ? [
            {
              key: "existingServer" as const,
              label: "Existing SQL Server",
              kind: "select" as const,
              required: false,
              options: [{ id: "", label: "(Create new server)" }, ...serverOptions],
              description: "Select an existing server or create a new one",
            },
          ]
        : []),
      {
        key: "serverName",
        label: "New SQL Server Name",
        kind: "text",
        required: false,
        description: "Globally unique server name (only if creating new server)",
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
        key: "adminUsername",
        label: "Server Admin Username",
        kind: "text",
        required: false,
        defaultValue: "sqladmin",
        description: "Only for new server",
      },
      {
        key: "adminPassword",
        label: "Server Admin Password",
        kind: "text",
        required: false,
        description: "Only for new server. Must meet complexity requirements.",
      },
      {
        key: "sku",
        label: "Pricing Tier",
        kind: "select",
        required: true,
        defaultValue: "Basic",
        options: [
          { id: "Basic", label: "Basic (5 DTU, ~$5/mo)" },
          { id: "S0", label: "Standard S0 (10 DTU, ~$15/mo)" },
          { id: "S1", label: "Standard S1 (20 DTU, ~$30/mo)" },
          { id: "S2", label: "Standard S2 (50 DTU, ~$75/mo)" },
          { id: "P1", label: "Premium P1 (125 DTU, ~$465/mo)" },
          { id: "GP_S_Gen5_1", label: "General Purpose Serverless (1 vCore)" },
          { id: "GP_Gen5_2", label: "General Purpose Provisioned (2 vCores)" },
        ],
      },
      {
        key: "maxSizeGb",
        label: "Max Size",
        kind: "select",
        required: true,
        defaultValue: "2",
        options: [
          { id: "1", label: "1 GB" },
          { id: "2", label: "2 GB" },
          { id: "5", label: "5 GB" },
          { id: "10", label: "10 GB" },
          { id: "50", label: "50 GB" },
          { id: "100", label: "100 GB" },
          { id: "250", label: "250 GB" },
        ],
      },
    ],
  };
}

export async function getDiskCreateConfig(ctx: AzureCreateContext): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      { key: "name", label: "Disk Name", kind: "text", required: true },
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
        key: "sku",
        label: "Disk Type",
        kind: "select",
        required: true,
        defaultValue: "Premium_LRS",
        options: [
          { id: "Standard_LRS", label: "Standard HDD (LRS)" },
          { id: "StandardSSD_LRS", label: "Standard SSD (LRS)" },
          { id: "Premium_LRS", label: "Premium SSD (LRS)" },
          { id: "PremiumV2_LRS", label: "Premium SSD v2 (LRS)" },
          { id: "UltraSSD_LRS", label: "Ultra Disk" },
        ],
      },
      {
        key: "diskSizeGb",
        label: "Size",
        kind: "disk-slider",
        required: true,
        minGb: 1,
        maxGb: 32767,
        defaultGb: 128,
        stepGb: 1,
      },
    ],
  };
}

export async function getAppServiceCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "App Name",
        kind: "text",
        required: true,
        description: "Globally unique name (becomes <name>.azurewebsites.net)",
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
        key: "runtime",
        label: "Runtime Stack",
        kind: "select",
        required: true,
        defaultValue: "NODE|20-lts",
        options: [
          { id: "NODE|20-lts", label: "Node.js 20 LTS" },
          { id: "NODE|18-lts", label: "Node.js 18 LTS" },
          { id: "PYTHON|3.12", label: "Python 3.12" },
          { id: "PYTHON|3.11", label: "Python 3.11" },
          { id: "DOTNETCORE|8.0", label: ".NET 8" },
          { id: "DOTNETCORE|6.0", label: ".NET 6" },
          { id: "JAVA|17-java17", label: "Java 17" },
          { id: "PHP|8.3", label: "PHP 8.3" },
          { id: "GO|1.21", label: "Go 1.21" },
        ],
      },
      {
        key: "sku",
        label: "App Service Plan SKU",
        kind: "select",
        required: true,
        defaultValue: "B1",
        options: [
          { id: "F1", label: "Free (F1)" },
          { id: "B1", label: "Basic B1 (~$13/mo)" },
          { id: "B2", label: "Basic B2 (~$26/mo)" },
          { id: "S1", label: "Standard S1 (~$69/mo)" },
          { id: "S2", label: "Standard S2 (~$138/mo)" },
          { id: "P1v3", label: "Premium v3 P1 (~$138/mo)" },
          { id: "P2v3", label: "Premium v3 P2 (~$276/mo)" },
        ],
      },
    ],
  };
}

export async function getFunctionAppCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  // List storage accounts for the required storage binding
  const storageAccounts = await ctx.get<{ value: Array<{ id: string; name: string }> }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`,
  );
  const saOptions = (storageAccounts.value ?? []).map((sa) => {
    const saRg = sa.id.match(/resourceGroups\/([^/]+)/i)?.[1] ?? "";
    return { id: `${saRg}/${sa.name}`, label: sa.name };
  });

  return {
    fields: [
      {
        key: "name",
        label: "Function App Name",
        kind: "text",
        required: true,
        description: "Globally unique name (becomes <name>.azurewebsites.net)",
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
        key: "runtime",
        label: "Runtime Stack",
        kind: "select",
        required: true,
        defaultValue: "node",
        options: [
          { id: "node", label: "Node.js" },
          { id: "python", label: "Python" },
          { id: "dotnet-isolated", label: ".NET (Isolated)" },
          { id: "java", label: "Java" },
          { id: "powershell", label: "PowerShell" },
        ],
      },
      {
        key: "runtimeVersion",
        label: "Runtime Version",
        kind: "select",
        required: true,
        defaultValue: "~4",
        options: [{ id: "~4", label: "Functions v4" }],
      },
      {
        key: "storageAccount",
        label: "Storage Account",
        kind: "select",
        required: true,
        options: saOptions,
        description: "Storage account required for function triggers and state",
      },
      {
        key: "sku",
        label: "Hosting Plan",
        kind: "select",
        required: true,
        defaultValue: "Y1",
        options: [
          { id: "Y1", label: "Consumption (Serverless, pay per execution)" },
          { id: "B1", label: "Basic B1 (~$13/mo)" },
          { id: "S1", label: "Standard S1 (~$69/mo)" },
          { id: "EP1", label: "Elastic Premium EP1 (~$171/mo)" },
        ],
      },
    ],
  };
}

export async function getContainerInstanceCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      { key: "name", label: "Container Group Name", kind: "text", required: true },
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
        key: "image",
        label: "Container Image",
        kind: "text",
        required: true,
        description: "Docker image (e.g. mcr.microsoft.com/azuredocs/aci-helloworld:latest)",
      },
      {
        key: "osType",
        label: "OS Type",
        kind: "select",
        required: true,
        defaultValue: "Linux",
        options: [
          { id: "Linux", label: "Linux" },
          { id: "Windows", label: "Windows" },
        ],
      },
      {
        key: "cpu",
        label: "CPU Cores",
        kind: "select",
        required: true,
        defaultValue: "1",
        options: [
          { id: "0.5", label: "0.5 cores" },
          { id: "1", label: "1 core" },
          { id: "2", label: "2 cores" },
          { id: "4", label: "4 cores" },
        ],
      },
      {
        key: "memoryGb",
        label: "Memory (GB)",
        kind: "select",
        required: true,
        defaultValue: "1.5",
        options: [
          { id: "0.5", label: "0.5 GB" },
          { id: "1", label: "1 GB" },
          { id: "1.5", label: "1.5 GB" },
          { id: "2", label: "2 GB" },
          { id: "4", label: "4 GB" },
          { id: "8", label: "8 GB" },
        ],
      },
      {
        key: "port",
        label: "Port",
        kind: "text",
        required: false,
        defaultValue: "80",
        description: "Container port to expose",
      },
      {
        key: "restartPolicy",
        label: "Restart Policy",
        kind: "select",
        required: true,
        defaultValue: "Always",
        options: [
          { id: "Always", label: "Always" },
          { id: "OnFailure", label: "On Failure" },
          { id: "Never", label: "Never" },
        ],
      },
    ],
  };
}

export async function getMessagingNamespaceCreateConfig(
  ctx: AzureCreateContext,
  label: string,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: `${label} Name`,
        kind: "text",
        required: true,
        description: "Globally unique namespace name",
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
        key: "sku",
        label: "Pricing Tier",
        kind: "select",
        required: true,
        defaultValue: "Standard",
        options: [
          { id: "Basic", label: "Basic" },
          { id: "Standard", label: "Standard" },
          { id: "Premium", label: "Premium" },
        ],
      },
    ],
  };
}

export async function getPublicIPCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      { key: "name", label: "Public IP Name", kind: "text", required: true },
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
        key: "sku",
        label: "SKU",
        kind: "select",
        required: true,
        defaultValue: "Standard",
        options: [
          { id: "Basic", label: "Basic" },
          { id: "Standard", label: "Standard" },
        ],
      },
      {
        key: "allocationMethod",
        label: "Allocation",
        kind: "select",
        required: true,
        defaultValue: "Static",
        options: [
          { id: "Static", label: "Static" },
          { id: "Dynamic", label: "Dynamic" },
        ],
      },
      {
        key: "ipVersion",
        label: "IP Version",
        kind: "select",
        required: true,
        defaultValue: "IPv4",
        options: [
          { id: "IPv4", label: "IPv4" },
          { id: "IPv6", label: "IPv6" },
        ],
      },
    ],
  };
}

export async function getLogAnalyticsCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "Workspace Name",
        kind: "text",
        required: true,
        description: "Name for the Log Analytics workspace",
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
        key: "sku",
        label: "Pricing Tier",
        kind: "select",
        required: true,
        defaultValue: "PerGB2018",
        options: [
          { id: "PerGB2018", label: "Pay-as-you-go (Per GB)" },
          { id: "Free", label: "Free (500 MB/day limit)" },
          { id: "Standalone", label: "Standalone" },
          { id: "PerNode", label: "Per Node (OMS)" },
        ],
      },
      {
        key: "retentionInDays",
        label: "Data Retention",
        kind: "select",
        required: true,
        defaultValue: "30",
        options: [
          { id: "30", label: "30 days" },
          { id: "60", label: "60 days" },
          { id: "90", label: "90 days" },
          { id: "120", label: "120 days" },
          { id: "180", label: "180 days" },
          { id: "365", label: "365 days" },
        ],
      },
    ],
  };
}

export async function getLoadBalancerCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "Load Balancer Name",
        kind: "text",
        required: true,
        description: "Name for the load balancer",
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
        key: "sku",
        label: "SKU",
        kind: "select",
        required: true,
        options: [
          { id: "Standard", label: "Standard" },
          { id: "Basic", label: "Basic" },
        ],
        defaultValue: "Standard",
      },
    ],
  };
}

export async function getSimpleCreateConfig(
  ctx: AzureCreateContext,
  nameLabel: string,
  description: string,
  _typeId: string,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      { key: "name", label: nameLabel, kind: "text", required: true, description },
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
    ],
  };
}

export async function getVNetCreateConfig(ctx: AzureCreateContext): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "VNet Name",
        kind: "text",
        required: true,
        description: "Name for the virtual network",
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
        key: "addressSpace",
        label: "Address Space (CIDR)",
        kind: "text",
        required: true,
        defaultValue: "10.0.0.0/16",
        description: "IPv4 address range in CIDR notation",
      },
      {
        key: "subnetName",
        label: "Default Subnet Name",
        kind: "text",
        required: true,
        defaultValue: "default",
      },
      {
        key: "subnetPrefix",
        label: "Subnet Address Prefix",
        kind: "text",
        required: true,
        defaultValue: "10.0.0.0/24",
      },
    ],
  };
}

export async function getKeyVaultCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "Key Vault Name",
        kind: "text",
        required: true,
        description: "Globally unique name (3-24 alphanumeric characters and hyphens)",
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
        key: "sku",
        label: "SKU",
        kind: "select",
        required: true,
        defaultValue: "standard",
        options: [
          { id: "standard", label: "Standard" },
          { id: "premium", label: "Premium (HSM-backed keys)" },
        ],
      },
      {
        key: "enableSoftDelete",
        label: "Soft Delete",
        kind: "select",
        required: true,
        defaultValue: "true",
        options: [
          { id: "true", label: "Enabled (recommended)" },
          { id: "false", label: "Disabled" },
        ],
      },
    ],
  };
}

export async function getContainerRegistryCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "Registry Name",
        kind: "text",
        required: true,
        description: "Globally unique name (5-50 alphanumeric characters)",
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
        key: "sku",
        label: "SKU",
        kind: "select",
        required: true,
        defaultValue: "Basic",
        options: [
          { id: "Basic", label: "Basic (~$0.167/day)" },
          { id: "Standard", label: "Standard (~$0.667/day)" },
          { id: "Premium", label: "Premium (~$1.667/day, geo-replication)" },
        ],
      },
      {
        key: "adminEnabled",
        label: "Admin User",
        kind: "select",
        required: true,
        defaultValue: "false",
        options: [
          { id: "false", label: "Disabled" },
          { id: "true", label: "Enabled" },
        ],
      },
    ],
  };
}

export async function createFlexibleDB(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
  typeId: string,
  resourceProvider: string,
  apiVersion: string,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const version = fields["version"]!;
  const sku = fields["sku"]!;
  const storageSizeGb = Number(fields["storageSizeGb"] ?? "128");
  const adminUsername = fields["adminUsername"] ?? "adminuser";
  const adminPassword = fields["adminPassword"] ?? "";

  // Determine tier from SKU name
  const tier = sku.startsWith("Standard_B")
    ? "Burstable"
    : sku.startsWith("Standard_E")
      ? "MemoryOptimized"
      : "GeneralPurpose";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${resourceProvider}/${name}?api-version=${apiVersion}`,
    {
      location,
      sku: { name: sku, tier },
      properties: {
        version,
        administratorLogin: adminUsername,
        administratorLoginPassword: adminPassword,
        storage: { storageSizeGB: storageSizeGb },
        backup: { backupRetentionDays: 7 },
      },
    },
  );

  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, typeId, `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: typeId,
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      state: String(props?.["state"] ?? "Creating"),
      version,
      sku,
      tier,
      storageSizeGb,
      haEnabled: false,
      backupRetentionDays: 7,
    },
    resolvedOutputs: {
      fqdn: String(props?.["fullyQualifiedDomainName"] ?? ""),
      administratorLogin: adminUsername,
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createSQLDatabase(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const dbName = fields["databaseName"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const existingServer = fields["existingServer"] ?? "";
  const skuName = fields["sku"] ?? "Basic";
  const maxSizeGb = Number(fields["maxSizeGb"] ?? "2");

  let serverName: string;
  let serverRg: string;

  if (existingServer) {
    const parts = existingServer.split("/");
    serverRg = parts[0] ?? "";
    serverName = parts[1] ?? "";
  } else {
    serverName = fields["serverName"]!;
    serverRg = rg;
    const adminUsername = fields["adminUsername"] ?? "sqladmin";
    const adminPassword = fields["adminPassword"] ?? "";

    // Create SQL Server
    await ctx.put(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${serverRg}/providers/Microsoft.Sql/servers/${serverName}?api-version=2023-05-01-preview`,
      {
        location,
        properties: {
          administratorLogin: adminUsername,
          administratorLoginPassword: adminPassword,
        },
      },
    );
  }

  // Determine tier
  const isVCoreBased =
    skuName.startsWith("GP_") || skuName.startsWith("BC_") || skuName.startsWith("HS_");
  const tier =
    skuName === "Basic"
      ? "Basic"
      : skuName.startsWith("S")
        ? "Standard"
        : skuName.startsWith("P")
          ? "Premium"
          : skuName.startsWith("GP_")
            ? "GeneralPurpose"
            : skuName.startsWith("BC_")
              ? "BusinessCritical"
              : "GeneralPurpose";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${serverRg}/providers/Microsoft.Sql/servers/${serverName}/databases/${dbName}?api-version=2023-05-01-preview`,
    {
      location,
      sku: { name: skuName, tier },
      properties: {
        maxSizeBytes: isVCoreBased ? undefined : maxSizeGb * 1073741824,
        collation: "SQL_Latin1_General_CP1_CI_AS",
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-sql-database", `${serverRg}/${serverName}/${dbName}`),
    pluginId: "azure",
    resourceTypeId: "azure-sql-database",
    accountId,
    displayName: `${serverName}/${dbName}`,
    fields: {
      name: dbName,
      serverName,
      resourceGroup: serverRg,
      location,
      status: String(props?.["status"] ?? "Creating"),
      edition: tier,
      serviceLevelObjective: skuName,
      maxSizeBytes: maxSizeGb * 1073741824,
      collation: "SQL_Latin1_General_CP1_CI_AS",
      zoneRedundant: false,
    },
    resolvedOutputs: {
      serverFqdn: `${serverName}.database.windows.net`,
    },
    secretStates: [],
    externalId: `${serverRg}/${serverName}/${dbName}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createDisk(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Premium_LRS";
  const diskSizeGb = Number(fields["diskSizeGb"] ?? "128");

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Compute/disks/${name}?api-version=2023-10-02`,
    {
      location,
      sku: { name: sku },
      properties: {
        diskSizeGB: diskSizeGb,
        creationData: { createOption: "Empty" },
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-disk", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-disk",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      diskSizeGb,
      diskState: "Unattached",
      sku,
      osType: "",
      managedBy: "",
      encryption: String(props?.["encryption"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createAppService(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const runtime = fields["runtime"] ?? "NODE|20-lts";
  const sku = fields["sku"] ?? "B1";

  // Create an App Service Plan first
  const planName = `${name}-plan`;
  await ctx.put(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}?api-version=2023-01-01`,
    {
      location,
      kind: "linux",
      properties: { reserved: true },
      sku: { name: sku },
    },
  );

  // Create the Web App
  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${name}?api-version=2023-01-01`,
    {
      location,
      kind: "app,linux",
      properties: {
        serverFarmId: `/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}`,
        siteConfig: {
          linuxFxVersion: runtime,
        },
        httpsOnly: true,
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-app-service", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-app-service",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      state: String(props?.["state"] ?? "Running"),
      kind: "app,linux",
      appServicePlan: planName,
      httpsOnly: true,
      linuxFxVersion: runtime,
    },
    resolvedOutputs: {
      defaultHostName: String(props?.["defaultHostName"] ?? `${name}.azurewebsites.net`),
      outboundIpAddresses: String(props?.["outboundIpAddresses"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createFunctionApp(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const runtime = fields["runtime"] ?? "node";
  const runtimeVersion = fields["runtimeVersion"] ?? "~4";
  const storageRef = fields["storageAccount"] ?? "";
  const [storageRg, storageAccountName] = storageRef.split("/");
  const sku = fields["sku"] ?? "Y1";

  // Create consumption plan
  const planName = `${name}-plan`;
  const isConsumption = sku === "Y1";
  await ctx.put(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}?api-version=2023-01-01`,
    {
      location,
      kind: "functionapp",
      properties: { reserved: true },
      sku: { name: sku, tier: isConsumption ? "Dynamic" : undefined },
    },
  );

  // Get storage account key
  const storageKeys = await ctx.post<{ keys?: Array<{ value: string }> }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${storageRg}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}/listKeys?api-version=2023-01-01`,
    {},
  );
  const storageKey = storageKeys.keys?.[0]?.value ?? "";
  const storageConnStr = `DefaultEndpointsProtocol=https;AccountName=${storageAccountName};AccountKey=${storageKey};EndpointSuffix=core.windows.net`;

  // Create function app
  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${name}?api-version=2023-01-01`,
    {
      location,
      kind: "functionapp,linux",
      properties: {
        serverFarmId: `/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}`,
        siteConfig: {
          linuxFxVersion: "",
          appSettings: [
            { name: "FUNCTIONS_EXTENSION_VERSION", value: runtimeVersion },
            { name: "FUNCTIONS_WORKER_RUNTIME", value: runtime },
            { name: "AzureWebJobsStorage", value: storageConnStr },
          ],
        },
        httpsOnly: true,
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-function-app", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-function-app",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      state: String(props?.["state"] ?? "Running"),
      kind: "functionapp,linux",
      runtime,
      runtimeVersion,
      appServicePlan: planName,
      httpsOnly: true,
    },
    resolvedOutputs: {
      defaultHostName: String(props?.["defaultHostName"] ?? `${name}.azurewebsites.net`),
      outboundIpAddresses: String(props?.["outboundIpAddresses"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createContainerInstance(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const image = fields["image"]!;
  const osType = fields["osType"] ?? "Linux";
  const cpu = Number(fields["cpu"] ?? "1");
  const memoryGb = Number(fields["memoryGb"] ?? "1.5");
  const port = Number(fields["port"] ?? "80");
  const restartPolicy = fields["restartPolicy"] ?? "Always";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerInstance/containerGroups/${name}?api-version=2023-05-01`,
    {
      location,
      properties: {
        osType,
        restartPolicy,
        containers: [
          {
            name,
            properties: {
              image,
              resources: { requests: { cpu, memoryInGB: memoryGb } },
              ports: [{ port, protocol: "TCP" }],
            },
          },
        ],
        ipAddress: {
          type: "Public",
          ports: [{ port, protocol: "TCP" }],
        },
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  const ipAddr = props?.["ipAddress"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-container-instance", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-container-instance",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      osType,
      restartPolicy,
      containers: 1,
      ipAddress: String(ipAddr?.["ip"] ?? ""),
      fqdn: String(ipAddr?.["fqdn"] ?? ""),
    },
    resolvedOutputs: {
      ipAddress: String(ipAddr?.["ip"] ?? ""),
      fqdn: String(ipAddr?.["fqdn"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createMessagingNamespace(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
  typeId: string,
  provider: string,
  apiVersion: string,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Standard";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${provider}/${name}?api-version=${apiVersion}`,
    {
      location,
      sku: { name: sku, tier: sku },
      properties: {},
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, typeId, `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: typeId,
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      status: String(props?.["status"] ?? ""),
    },
    resolvedOutputs: {
      serviceBusEndpoint: String(props?.["serviceBusEndpoint"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createPublicIP(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Standard";
  const allocationMethod = fields["allocationMethod"] ?? "Static";
  const ipVersion = fields["ipVersion"] ?? "IPv4";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/publicIPAddresses/${name}?api-version=2023-09-01`,
    {
      location,
      sku: { name: sku },
      properties: {
        publicIPAllocationMethod: allocationMethod,
        publicIPAddressVersion: ipVersion,
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-public-ip", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-public-ip",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      allocationMethod,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      ipVersion,
    },
    resolvedOutputs: {
      ipAddress: String(props?.["ipAddress"] ?? ""),
      fqdn: String((props?.["dnsSettings"] as Record<string, unknown> | undefined)?.["fqdn"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createLogAnalyticsWorkspace(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "PerGB2018";
  const retentionInDays = Number(fields["retentionInDays"] ?? "30");

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.OperationalInsights/workspaces/${name}?api-version=2022-10-01`,
    {
      location,
      properties: {
        sku: { name: sku },
        retentionInDays,
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-log-analytics", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-log-analytics",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      retentionInDays,
      dailyQuotaGb: -1,
    },
    resolvedOutputs: {
      customerId: String(props?.["customerId"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createSimpleResource(
  ctx: AzureCreateContext,
  accountId: string,
  typeId: string,
  fields: Record<string, string>,
  provider: string,
  apiVersion: string,
  extraProperties: Record<string, unknown>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${provider}/${name}?api-version=${apiVersion}`,
    { location, properties: extraProperties },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, typeId, `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: typeId,
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createVNet(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const addressSpace = fields["addressSpace"] ?? "10.0.0.0/16";
  const subnetName = fields["subnetName"] ?? "default";
  const subnetPrefix = fields["subnetPrefix"] ?? "10.0.0.0/24";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${name}?api-version=2023-09-01`,
    {
      location,
      properties: {
        addressSpace: { addressPrefixes: [addressSpace] },
        subnets: [{ name: subnetName, properties: { addressPrefix: subnetPrefix } }],
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-vnet", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-vnet",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      addressSpace,
      subnetCount: 1,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createKeyVault(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "standard";
  const enableSoftDelete = fields["enableSoftDelete"] !== "false";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.KeyVault/vaults/${name}?api-version=2023-07-01`,
    {
      location,
      properties: {
        tenantId: ctx.tenantId,
        sku: { family: "A", name: sku },
        enableSoftDelete,
        enableRbacAuthorization: true,
        accessPolicies: [],
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-key-vault", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-key-vault",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      vaultUri: String(props?.["vaultUri"] ?? `https://${name}.vault.azure.net/`),
      enableSoftDelete,
    },
    resolvedOutputs: {
      vaultUri: String(props?.["vaultUri"] ?? `https://${name}.vault.azure.net/`),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createContainerRegistry(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Basic";
  const adminEnabled = fields["adminEnabled"] === "true";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerRegistry/registries/${name}?api-version=2023-07-01`,
    {
      location,
      sku: { name: sku },
      properties: { adminUserEnabled: adminEnabled },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-container-registry", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-container-registry",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      loginServer: String(props?.["loginServer"] ?? `${name.toLowerCase()}.azurecr.io`),
      adminEnabled,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
    },
    resolvedOutputs: {
      loginServer: String(props?.["loginServer"] ?? `${name.toLowerCase()}.azurecr.io`),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Create an Entra ID app registration + matching service principal. Three Graph calls:
 * 1. POST /applications → creates the app, returns object `id` and `appId` (different GUIDs).
 * 2. POST /servicePrincipals with `{appId}` → creates the SP, returns `id` (SP object id).
 * 3. (optional) PUT roleAssignment on ARM if a role is requested — not wired in this version;
 *    users assign roles via the Azure portal or future policy-picker support.
 */
export async function createAppRegistration(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const displayName = fields["displayName"] ?? "";
  if (!displayName) throw new Error("displayName is required");
  const app = await ctx.graphRequest<{
    id?: string;
    appId?: string;
    displayName?: string;
    signInAudience?: string;
    createdDateTime?: string;
  }>("POST", "/applications", { displayName });
  const objectId = app.id ?? "";
  const appId = app.appId ?? "";
  if (!objectId || !appId) throw new Error("Graph returned an empty application");
  // Create the SP — without this, the app can't be used as a principal for role assignments.
  let spId = "";
  try {
    const sp = await ctx.graphRequest<{ id?: string }>("POST", "/servicePrincipals", { appId });
    spId = sp.id ?? "";
  } catch (e) {
    // Roll back the app if SP creation fails so we don't leak an orphan.
    let cleanupNote = "";
    try {
      await ctx.graphRequest("DELETE", `/applications/${objectId}`);
    } catch (cleanupErr) {
      cleanupNote = ` (cleanup of orphaned app ${objectId} also failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)})`;
    }
    const baseMsg = e instanceof Error ? e.message : String(e);
    throw new Error(`Service principal creation failed${cleanupNote}: ${baseMsg}`);
  }
  const now = new Date().toISOString();
  return {
    id: ctx.makeId(accountId, "azure-app-registration", objectId),
    pluginId: "azure",
    resourceTypeId: "azure-app-registration",
    accountId,
    displayName,
    fields: {
      displayName,
      appId,
      objectId,
      servicePrincipalId: spId,
      signInAudience: String(app.signInAudience ?? ""),
      createdDateTime: String(app.createdDateTime ?? now),
    },
    resolvedOutputs: { appId, tenantId: ctx.tenantId },
    secretStates: [],
    externalId: objectId,
    createdAt: String(app.createdDateTime ?? now),
    updatedAt: now,
  };
}

export async function createResourceGroup(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const location = fields["region"]!;
  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourcegroups/${name}?api-version=2022-09-01`,
    { location },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-resource-group", name),
    pluginId: "azure",
    resourceTypeId: "azure-resource-group",
    accountId,
    displayName: name,
    fields: {
      name,
      location,
      provisioningState: String(props?.["provisioningState"] ?? "Succeeded"),
    },
    resolvedOutputs: { resourceId: String(result["id"] ?? "") },
    secretStates: [],
    externalId: name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

export async function createAKSCluster(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const k8sVersion = fields["kubernetesVersion"]!;
  const nodeSize = fields["nodeSize"]!;
  const nodeCount = Number(fields["nodeCount"] ?? "3");

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerService/managedClusters/${name}?api-version=2024-01-01`,
    {
      location,
      properties: {
        kubernetesVersion: k8sVersion,
        dnsPrefix: `${name}-dns`,
        agentPoolProfiles: [
          {
            name: "nodepool1",
            count: nodeCount,
            vmSize: nodeSize,
            osType: "Linux",
            mode: "System",
          },
        ],
        servicePrincipalProfile: {
          clientId: ctx.clientId,
          secret: ctx.clientSecret,
        },
      },
      identity: { type: "SystemAssigned" },
    },
  );

  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-aks-cluster", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-aks-cluster",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      kubernetesVersion: k8sVersion,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      powerState: "Running",
      nodeCount,
      nodePoolCount: 1,
      networkPlugin: "",
      tier: "Free",
    },
    resolvedOutputs: {
      fqdn: String(props?.["fqdn"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createStorageAccount(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Standard_LRS";
  const kind = fields["kind"] ?? "StorageV2";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}?api-version=2023-01-01`,
    {
      location,
      kind,
      sku: { name: sku },
      properties: { supportsHttpsTrafficOnly: true, accessTier: "Hot" },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  const primaryEndpoints = props?.["primaryEndpoints"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-storage-account", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-storage-account",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      kind,
      sku,
      provisioningState: String(props?.["provisioningState"] ?? "Succeeded"),
      accessTier: "Hot",
      httpsOnly: true,
      primaryLocation: location,
      statusOfPrimary: "available",
    },
    resolvedOutputs: {
      primaryBlobEndpoint: String(
        primaryEndpoints?.["blob"] ?? `https://${name}.blob.core.windows.net/`,
      ),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createCosmosDB(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const kind = fields["kind"] ?? "GlobalDocumentDB";
  const consistencyLevel = fields["consistencyLevel"] ?? "Session";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${name}?api-version=2023-11-15`,
    {
      location,
      kind,
      properties: {
        databaseAccountOfferType: "Standard",
        locations: [{ locationName: location, failoverPriority: 0 }],
        consistencyPolicy: { defaultConsistencyLevel: consistencyLevel },
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-cosmos-db", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-cosmos-db",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      kind,
      databaseAccountOfferType: "Standard",
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      consistencyLevel,
      enableAutomaticFailover: false,
      enableMultipleWriteLocations: false,
      readLocations: location,
      writeLocations: location,
    },
    resolvedOutputs: {
      documentEndpoint: String(
        props?.["documentEndpoint"] ?? `https://${name}.documents.azure.com:443/`,
      ),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createRedisCache(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const skuName = fields["sku"] ?? "Basic";
  const capacity = Number(fields["capacity"] ?? "0");
  const skuFamily = skuName === "Premium" ? "P" : "C";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Cache/redis/${name}?api-version=2023-08-01`,
    {
      location,
      properties: {
        sku: { name: skuName, family: skuFamily, capacity },
        enableNonSslPort: false,
        redisVersion: "6",
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-redis-cache", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-redis-cache",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku: skuName,
      capacity,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      redisVersion: "6",
      nonSslPort: false,
      shardCount: 0,
    },
    resolvedOutputs: {
      hostName: String(props?.["hostName"] ?? `${name}.redis.cache.windows.net`),
      port: "6380",
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
