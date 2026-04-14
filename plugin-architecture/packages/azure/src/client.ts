import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceStatus,
  ResourceTypeDefinition,
  StorageObject,
  CreateResourceConfig,
  DashboardStat,
} from "@infrawrench/plugin-base";
import {
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";
import { fetchAccessToken, fetchStorageAccessToken, type AzureCredentials } from "./auth.js";
import type { ListerContext } from "./resource-listers.js";
import * as listers from "./resource-listers.js";

const ARM = "https://management.azure.com";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Static VM price lookup (East US pay-as-you-go Linux monthly) */
const VM_SIZE_PRICES: Record<string, number> = {
  Standard_B1s: 7.59,
  Standard_B1ms: 15.18,
  Standard_B2s: 30.37,
  Standard_B2ms: 60.74,
  Standard_B4ms: 121.47,
  Standard_D2s_v5: 70.08,
  Standard_D4s_v5: 140.16,
  Standard_D8s_v5: 280.32,
  Standard_D16s_v5: 560.64,
  Standard_D32s_v5: 1121.28,
  Standard_E2s_v5: 91.98,
  Standard_E4s_v5: 183.96,
  Standard_E8s_v5: 367.92,
  Standard_F2s_v2: 61.32,
  Standard_F4s_v2: 122.64,
  Standard_F8s_v2: 245.28,
};

interface TokenCache {
  token: string;
  expiresAt: number;
}

const AZURE_REGIONS = [
  { id: "eastus", label: "East US", location: "Virginia, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "eastus2", label: "East US 2", location: "Virginia, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "westus", label: "West US", location: "California, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "westus2", label: "West US 2", location: "Washington, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "westus3", label: "West US 3", location: "Arizona, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "centralus", label: "Central US", location: "Iowa, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  {
    id: "northcentralus",
    label: "North Central US",
    location: "Illinois, USA",
    flag: "\u{1F1FA}\u{1F1F8}",
  },
  {
    id: "southcentralus",
    label: "South Central US",
    location: "Texas, USA",
    flag: "\u{1F1FA}\u{1F1F8}",
  },
  {
    id: "canadacentral",
    label: "Canada Central",
    location: "Toronto, Canada",
    flag: "\u{1F1E8}\u{1F1E6}",
  },
  {
    id: "canadaeast",
    label: "Canada East",
    location: "Quebec, Canada",
    flag: "\u{1F1E8}\u{1F1E6}",
  },
  { id: "northeurope", label: "North Europe", location: "Ireland", flag: "\u{1F1EE}\u{1F1EA}" },
  { id: "westeurope", label: "West Europe", location: "Netherlands", flag: "\u{1F1F3}\u{1F1F1}" },
  { id: "uksouth", label: "UK South", location: "London, UK", flag: "\u{1F1EC}\u{1F1E7}" },
  { id: "ukwest", label: "UK West", location: "Cardiff, UK", flag: "\u{1F1EC}\u{1F1E7}" },
  {
    id: "francecentral",
    label: "France Central",
    location: "Paris, France",
    flag: "\u{1F1EB}\u{1F1F7}",
  },
  {
    id: "germanywestcentral",
    label: "Germany West Central",
    location: "Frankfurt, Germany",
    flag: "\u{1F1E9}\u{1F1EA}",
  },
  {
    id: "swedencentral",
    label: "Sweden Central",
    location: "G\u00e4vle, Sweden",
    flag: "\u{1F1F8}\u{1F1EA}",
  },
  { id: "norwayeast", label: "Norway East", location: "Oslo, Norway", flag: "\u{1F1F3}\u{1F1F4}" },
  {
    id: "switzerlandnorth",
    label: "Switzerland North",
    location: "Z\u00fcrich, Switzerland",
    flag: "\u{1F1E8}\u{1F1ED}",
  },
  { id: "eastasia", label: "East Asia", location: "Hong Kong", flag: "\u{1F1ED}\u{1F1F0}" },
  {
    id: "southeastasia",
    label: "Southeast Asia",
    location: "Singapore",
    flag: "\u{1F1F8}\u{1F1EC}",
  },
  { id: "japaneast", label: "Japan East", location: "Tokyo, Japan", flag: "\u{1F1EF}\u{1F1F5}" },
  { id: "japanwest", label: "Japan West", location: "Osaka, Japan", flag: "\u{1F1EF}\u{1F1F5}" },
  {
    id: "australiaeast",
    label: "Australia East",
    location: "Sydney, Australia",
    flag: "\u{1F1E6}\u{1F1FA}",
  },
  {
    id: "australiasoutheast",
    label: "Australia Southeast",
    location: "Melbourne, Australia",
    flag: "\u{1F1E6}\u{1F1FA}",
  },
  {
    id: "koreacentral",
    label: "Korea Central",
    location: "Seoul, South Korea",
    flag: "\u{1F1F0}\u{1F1F7}",
  },
  {
    id: "centralindia",
    label: "Central India",
    location: "Pune, India",
    flag: "\u{1F1EE}\u{1F1F3}",
  },
  {
    id: "southindia",
    label: "South India",
    location: "Chennai, India",
    flag: "\u{1F1EE}\u{1F1F3}",
  },
  {
    id: "brazilsouth",
    label: "Brazil South",
    location: "S\u00e3o Paulo, Brazil",
    flag: "\u{1F1E7}\u{1F1F7}",
  },
  {
    id: "southafricanorth",
    label: "South Africa North",
    location: "Johannesburg, South Africa",
    flag: "\u{1F1FF}\u{1F1E6}",
  },
  { id: "uaenorth", label: "UAE North", location: "Dubai, UAE", flag: "\u{1F1E6}\u{1F1EA}" },
  {
    id: "qatarcentral",
    label: "Qatar Central",
    location: "Doha, Qatar",
    flag: "\u{1F1F6}\u{1F1E6}",
  },
  {
    id: "polandcentral",
    label: "Poland Central",
    location: "Warsaw, Poland",
    flag: "\u{1F1F5}\u{1F1F1}",
  },
  { id: "italynorth", label: "Italy North", location: "Milan, Italy", flag: "\u{1F1EE}\u{1F1F9}" },
];

export class AzureClient implements PluginClient {
  private readonly creds: AzureCredentials;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private tokenCache: TokenCache | null = null;
  private storageTokenCache: TokenCache | null = null;

  constructor(credentials: Record<string, string>, resourceTypes: ResourceTypeDefinition[] = []) {
    this.resourceTypes = resourceTypes;
    const tenantId = credentials["tenantId"];
    const clientId = credentials["clientId"];
    const clientSecret = credentials["clientSecret"];
    const subscriptionId = credentials["subscriptionId"];
    if (!tenantId || !clientId || !clientSecret || !subscriptionId) {
      throw new Error("Azure plugin: missing tenantId, clientId, clientSecret, or subscriptionId");
    }
    this.creds = { tenantId, clientId, clientSecret, subscriptionId };
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }
    const t = await fetchAccessToken(this.creds);
    this.tokenCache = { token: t, expiresAt: now + 3_600_000 };
    return t;
  }

  private async storageToken(): Promise<string> {
    const now = Date.now();
    if (this.storageTokenCache && this.storageTokenCache.expiresAt > now + 60_000) {
      return this.storageTokenCache.token;
    }
    const t = await fetchStorageAccessToken(this.creds);
    this.storageTokenCache = { token: t, expiresAt: now + 3_600_000 };
    return t;
  }

  private async get<T>(url: string): Promise<T> {
    const tok = await this.token();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Azure API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const tok = await this.token();
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Azure API POST ${res.status}: ${await res.text()}`);
    if (res.status === 204 || res.headers.get("content-length") === "0") return {} as T;
    return res.json() as Promise<T>;
  }

  private async put<T>(url: string, body: unknown): Promise<T> {
    const tok = await this.token();
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Azure API PUT ${res.status}: ${await res.text()}`);
    if (res.status === 204 || res.headers.get("content-length") === "0") return {} as T;
    return res.json() as Promise<T>;
  }

  private async del(url: string): Promise<void> {
    const tok = await this.token();
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok && res.status !== 204 && res.status !== 202) {
      throw new Error(`Azure API DELETE ${res.status}: ${await res.text()}`);
    }
  }

  private makeId(accountId: string, typeId: string, externalId: string): string {
    return `${accountId}:${typeId}:${externalId}`;
  }

  private get ctx(): ListerContext {
    return {
      get: <T>(url: string) => this.get<T>(url),
      post: <T>(url: string, body: unknown) => this.post<T>(url, body),
      put: <T>(url: string, body: unknown) => this.put<T>(url, body),
      del: (url: string) => this.del(url),
      id: (accountId, typeId, externalId) => this.makeId(accountId, typeId, externalId),
      now: () => new Date().toISOString(),
      subscriptionId: this.creds.subscriptionId,
    };
  }

  private static readonly LISTERS: Record<
    string,
    (ctx: ListerContext, accountId: string) => Promise<ResourceInstance[]>
  > = {
    "azure-resource-group": listers.listResourceGroups,
    "azure-vm": listers.listVMs,
    "azure-disk": listers.listDisks,
    "azure-vnet": listers.listVNets,
    "azure-aks-cluster": listers.listAKSClusters,
    "azure-sql-database": listers.listSQLDatabases,
    "azure-cosmos-db": listers.listCosmosDBAccounts,
    "azure-storage-account": listers.listStorageAccounts,
    "azure-function-app": listers.listFunctionApps,
    "azure-app-service": listers.listAppServices,
    "azure-container-instance": listers.listContainerInstances,
    "azure-key-vault": listers.listKeyVaults,
    "azure-redis-cache": listers.listRedisCaches,
    "azure-service-bus": listers.listServiceBusNamespaces,
    "azure-container-registry": listers.listContainerRegistries,
    "azure-load-balancer": listers.listLoadBalancers,
    "azure-dns-zone": listers.listDNSZones,
    "azure-nsg": listers.listNSGs,
    "azure-public-ip": listers.listPublicIPs,
    "azure-postgres-flexible": listers.listPostgresFlexibleServers,
    "azure-mysql-flexible": listers.listMySQLFlexibleServers,
    "azure-event-hub": listers.listEventHubNamespaces,
    "azure-app-gateway": listers.listAppGateways,
    "azure-log-analytics": listers.listLogAnalyticsWorkspaces,
    "azure-managed-identity": listers.listManagedIdentities,
    "azure-firewall": listers.listFirewalls,
  };

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const lister = AzureClient.LISTERS[typeId];
    if (!lister) throw new Error(`Azure plugin: unknown resource type "${typeId}"`);
    return lister(this.ctx, accountId);
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Azure plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    // For AKS kubeconfig, we need to fetch it via API
    if (typeId === "azure-aks-cluster" && outputKey === "kubeconfig") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const [rg, name] = (resource.externalId ?? "").split("/");
      const kubeconfigData = await this.post<{ kubeconfigs?: Array<{ value: string }> }>(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerService/managedClusters/${name}/listClusterUserCredential?api-version=2024-01-01`,
        {},
      );
      const encoded = kubeconfigData.kubeconfigs?.[0]?.value ?? "";
      return atob(encoded);
    }

    // For Cosmos DB keys
    if (
      typeId === "azure-cosmos-db" &&
      (outputKey === "primaryKey" || outputKey === "connectionString")
    ) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const [rg, name] = (resource.externalId ?? "").split("/");
      if (outputKey === "primaryKey") {
        const keys = await this.post<{ primaryMasterKey?: string }>(
          `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${name}/listKeys?api-version=2023-11-15`,
          {},
        );
        return keys.primaryMasterKey ?? "";
      }
      const connStrings = await this.post<{
        connectionStrings?: Array<{ connectionString: string }>;
      }>(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${name}/listConnectionStrings?api-version=2023-11-15`,
        {},
      );
      return connStrings.connectionStrings?.[0]?.connectionString ?? "";
    }

    // For Storage Account keys
    if (
      typeId === "azure-storage-account" &&
      (outputKey === "primaryKey" || outputKey === "connectionString")
    ) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const [rg, name] = (resource.externalId ?? "").split("/");
      const keys = await this.post<{ keys?: Array<{ keyName: string; value: string }> }>(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}/listKeys?api-version=2023-01-01`,
        {},
      );
      const primaryKey = keys.keys?.[0]?.value ?? "";
      if (outputKey === "primaryKey") return primaryKey;
      return `DefaultEndpointsProtocol=https;AccountName=${name};AccountKey=${primaryKey};EndpointSuffix=core.windows.net`;
    }

    // For Redis Cache keys
    if (
      typeId === "azure-redis-cache" &&
      (outputKey === "primaryKey" || outputKey === "connectionString")
    ) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const [rg, name] = (resource.externalId ?? "").split("/");
      const keys = await this.post<{ primaryKey?: string }>(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Cache/redis/${name}/listKeys?api-version=2023-08-01`,
        {},
      );
      const pk = keys.primaryKey ?? "";
      if (outputKey === "primaryKey") return pk;
      const hostName = String(resource.fields["name"] ?? "");
      return `${hostName}.redis.cache.windows.net:6380,password=${pk},ssl=True,abortConnect=False`;
    }

    // For Service Bus connection strings
    if (typeId === "azure-service-bus" && outputKey === "primaryConnectionString") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const [rg, name] = (resource.externalId ?? "").split("/");
      const keys = await this.post<{ primaryConnectionString?: string }>(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ServiceBus/namespaces/${name}/AuthorizationRules/RootManageSharedAccessKey/listKeys?api-version=2022-10-01-preview`,
        {},
      );
      return keys.primaryConnectionString ?? "";
    }

    // For Event Hub connection strings
    if (typeId === "azure-event-hub" && outputKey === "primaryConnectionString") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const [rg, name] = (resource.externalId ?? "").split("/");
      const keys = await this.post<{ primaryConnectionString?: string }>(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.EventHub/namespaces/${name}/AuthorizationRules/RootManageSharedAccessKey/listKeys?api-version=2024-01-01`,
        {},
      );
      return keys.primaryConnectionString ?? "";
    }

    // For SQL Database connection string
    if (typeId === "azure-sql-database" && outputKey === "connectionString") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const serverName = String(resource.fields["serverName"] ?? "");
      const dbName = String(resource.fields["name"] ?? "");
      return `Server=tcp:${serverName}.database.windows.net,1433;Initial Catalog=${dbName};Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;Authentication=Active Directory Default;`;
    }

    // For Log Analytics shared keys
    if (typeId === "azure-log-analytics" && outputKey === "primarySharedKey") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const [rg, name] = (resource.externalId ?? "").split("/");
      const keys = await this.post<{ primarySharedKey?: string }>(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.OperationalInsights/workspaces/${name}/sharedKeys?api-version=2020-08-01`,
        {},
      );
      return keys.primarySharedKey ?? "";
    }

    // For PostgreSQL Flexible Server connection string
    if (typeId === "azure-postgres-flexible" && outputKey === "connectionString") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fqdn = String(resource.resolvedOutputs["fqdn"] ?? "");
      const adminLogin = String(resource.resolvedOutputs["administratorLogin"] ?? "");
      return `postgresql://${adminLogin}:{your_password}@${fqdn}:5432/postgres?sslmode=require`;
    }

    // For MySQL Flexible Server connection string
    if (typeId === "azure-mysql-flexible" && outputKey === "connectionString") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fqdn = String(resource.resolvedOutputs["fqdn"] ?? "");
      const adminLogin = String(resource.resolvedOutputs["administratorLogin"] ?? "");
      return `mysql://${adminLogin}:{your_password}@${fqdn}:3306/?ssl-mode=REQUIRED`;
    }

    // Default: look up in resolved outputs
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value === undefined) {
      throw new Error(`Azure plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    }
    return String(value);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;
    const ro = resource.resolvedOutputs ?? {};

    switch (resourceTypeId) {
      case "azure-vm": {
        const state = String(f.state ?? "unknown");
        const stats: DashboardStat[] = [
          {
            label: "State",
            value: state,
            variant:
              state === "Running"
                ? "status-healthy"
                : state === "Deallocated" || state === "Stopped"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Location", value: String(f.location ?? "") },
        ];
        if (ro.publicIp) stats.push({ label: "Public IP", value: String(ro.publicIp) });
        return stats;
      }
      case "azure-aks-cluster": {
        return [
          { label: "Version", value: String(f.version ?? "") },
          { label: "Location", value: String(f.location ?? "") },
          { label: "Nodes", value: String(f.nodeCount ?? 0) },
        ];
      }
      case "azure-sql-server":
      case "azure-sql-database":
      case "azure-cosmos-account": {
        const stateVal = String(f.state ?? f.status ?? "unknown");
        return [
          {
            label: "State",
            value: stateVal,
            variant:
              stateVal === "Ready" || stateVal === "Online" || stateVal === "Running"
                ? "status-healthy"
                : "status-degraded",
          },
          { label: "Location", value: String(f.location ?? "") },
        ];
      }
      default: {
        // Generic fallback — show key fields from the resource
        const stats: DashboardStat[] = [];
        const statusVal = f.status ?? f.state ?? f.provisioningState ?? f.phase;
        if (statusVal != null) {
          const s = String(statusVal).toLowerCase();
          stats.push({
            label: "Status",
            value: String(statusVal),
            variant: [
              "running",
              "active",
              "available",
              "ready",
              "enabled",
              "healthy",
              "succeeded",
              "online",
            ].some((v) => s.includes(v))
              ? "status-healthy"
              : ["error", "failed", "terminated", "deleted", "unhealthy"].some((v) => s.includes(v))
                ? "status-error"
                : ["pending", "creating", "updating", "stopping", "degraded", "warning"].some((v) =>
                      s.includes(v),
                    )
                  ? "status-degraded"
                  : "default",
          });
        }
        const typeVal =
          f.type ??
          f.kind ??
          f.engine ??
          f.instanceType ??
          f.tier ??
          f.machineType ??
          f.size ??
          f.sku;
        if (typeVal != null) stats.push({ label: "Type", value: String(typeVal) });
        const regionVal = f.region ?? f.location ?? f.zone;
        if (regionVal != null) stats.push({ label: "Region", value: String(regionVal) });
        return stats;
      }
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(
      fields["provisioningState"] ??
        fields["state"] ??
        fields["status"] ??
        fields["powerState"] ??
        "",
    );

    const statusMap: Record<string, ResourceStatus> = {
      succeeded: "healthy",
      running: "healthy",
      active: "healthy",
      online: "healthy",
      available: "healthy",
      ready: "healthy",
      creating: "provisioning",
      updating: "provisioning",
      provisioning: "provisioning",
      starting: "provisioning",
      scaling: "provisioning",
      upgrading: "provisioning",
      resuming: "provisioning",
      "vm running": "healthy",
      "vm deallocated": "degraded",
      "vm stopped": "degraded",
      stopped: "degraded",
      stopping: "degraded",
      paused: "degraded",
      pausing: "degraded",
      deallocated: "degraded",
      deleting: "error",
      failed: "error",
      offline: "error",
      inaccessible: "error",
      suspect: "error",
    };
    const dotStatus = statusMap[state.toLowerCase()] ?? "unknown";

    const sections: DetailViewSchema["sections"] = [
      {
        kind: "section",
        title: "Details",
        children: [
          {
            kind: "key-value-list",
            items: labeledFieldItems(fields, this.resourceTypes, resource.resourceTypeId),
          },
        ],
      },
    ];

    if (Object.keys(resource.resolvedOutputs).length > 0) {
      sections.push({
        kind: "section",
        title: "Outputs",
        children: [
          {
            kind: "key-value-list",
            items: labeledOutputItems(
              resource.resolvedOutputs,
              this.resourceTypes,
              resource.resourceTypeId,
            ),
          },
        ],
      });
    }

    const detail: DetailViewSchema = {
      title: resource.displayName,
      subtitle: `${resourceTypeDisplayName(this.resourceTypes, resource.resourceTypeId)} \u00B7 ${String(fields["location"] ?? fields["resourceGroup"] ?? "")}`,
      status: state
        ? { kind: "status-dot", status: dotStatus, label: state }
        : { kind: "status-dot", status: dotStatus },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };

    // Add storage browser for storage accounts
    if (resource.resourceTypeId === "azure-storage-account") {
      detail.storageBrowser = { bucketName: String(resource.fields["name"] ?? "") };
    }

    return detail;
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const state = String(
      resource.fields["provisioningState"] ??
        resource.fields["state"] ??
        resource.fields["status"] ??
        resource.fields["powerState"] ??
        "",
    );
    const statusMap: Record<string, ResourceStatus> = {
      succeeded: "healthy",
      running: "healthy",
      active: "healthy",
      online: "healthy",
      available: "healthy",
      "vm running": "healthy",
      stopped: "degraded",
      "vm deallocated": "degraded",
      "vm stopped": "degraded",
      paused: "degraded",
      failed: "error",
      deleting: "error",
    };
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: statusMap[state.toLowerCase()] ?? "unknown" },
    };
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const tok = await this.storageToken();
    const delimiter = "/";
    const params = new URLSearchParams({
      restype: "container",
      comp: "list",
      prefix,
      delimiter,
    });
    const url = `https://${bucket}.blob.core.windows.net/?${params}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tok}`,
        "x-ms-version": "2023-11-03",
      },
    });
    if (!res.ok) throw new Error(`Azure Blob list failed: ${res.status}`);
    const xml = await res.text();
    return this.parseBlobListXml(xml, prefix);
  }

  private parseBlobListXml(xml: string, prefix: string): StorageObject[] {
    const results: StorageObject[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "text/xml");

    // Parse blob prefixes (directories)
    const blobPrefixes = doc.querySelectorAll("BlobPrefix");
    for (const bp of Array.from(blobPrefixes)) {
      const name = bp.querySelector("Name")?.textContent ?? "";
      if (name) {
        results.push({
          key: name,
          name: name.slice(prefix.length).replace(/\/$/, ""),
          size: 0,
          lastModified: "",
          isDirectory: true,
        });
      }
    }

    // Parse blobs (files)
    const blobs = doc.querySelectorAll("Blobs > Blob");
    for (const blob of Array.from(blobs)) {
      const blobName = blob.querySelector("Name")?.textContent ?? "";
      const props = blob.querySelector("Properties");
      const size = Number(props?.querySelector("Content-Length")?.textContent ?? "0");
      const lastModified = props?.querySelector("Last-Modified")?.textContent ?? "";
      const contentType = props?.querySelector("Content-Type")?.textContent ?? "";

      results.push({
        key: blobName,
        name: blobName.slice(prefix.length),
        size,
        lastModified,
        isDirectory: false,
        contentType,
      });
    }

    return results;
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    const tok = await this.storageToken();
    // Find the first container, then upload blob
    const containerName = key.split("/")[0] ?? "$root";
    const blobName = key.split("/").slice(1).join("/") || key;
    const url = `https://${bucket}.blob.core.windows.net/${containerName}/${blobName}`;
    const arrayBuffer = await file.arrayBuffer();
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tok}`,
        "x-ms-version": "2023-11-03",
        "x-ms-blob-type": "BlockBlob",
        "Content-Type": file.type || "application/octet-stream",
        "Content-Length": String(arrayBuffer.byteLength),
      },
      body: arrayBuffer,
    });
    if (!res.ok) throw new Error(`Azure Blob upload failed: ${res.status}`);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    // Azure doesn't have real folders — upload a zero-byte blob with trailing /
    const tok = await this.storageToken();
    const containerName = key.split("/")[0] ?? "$root";
    const folderKey = key.split("/").slice(1).join("/") || key;
    const url = `https://${bucket}.blob.core.windows.net/${containerName}/${folderKey}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tok}`,
        "x-ms-version": "2023-11-03",
        "x-ms-blob-type": "BlockBlob",
        "Content-Length": "0",
      },
    });
    if (!res.ok) throw new Error(`Azure Blob mkdir failed: ${res.status}`);
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const tok = await this.storageToken();
    if (key.endsWith("/")) {
      // Delete all blobs under this prefix
      const objects = await this.listStorageObjects(bucket, key);
      for (const obj of objects) {
        if (!obj.isDirectory) {
          await this.deleteStorageObject(bucket, obj.key);
        }
      }
    } else {
      const containerName = key.split("/")[0] ?? "$root";
      const blobName = key.split("/").slice(1).join("/") || key;
      const url = `https://${bucket}.blob.core.windows.net/${containerName}/${blobName}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${tok}`,
          "x-ms-version": "2023-11-03",
        },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Azure Blob delete failed: ${res.status}`);
      }
    }
  }

  async getStorageAccessToken(): Promise<string> {
    return this.storageToken();
  }

  async getCreateCostEstimate(
    typeId: string,
    fields: Record<string, string>,
  ): Promise<number | null> {
    if (typeId === "azure-vm") {
      const sizeId = fields["size"] ?? "";
      if (!sizeId) return null;
      const sizeEntry = VM_SIZE_PRICES[sizeId];
      if (!sizeEntry) return null;
      const diskGb = Number(fields["bootDiskSizeGb"] ?? "64");
      // Premium SSD: ~$0.132/GB/month
      const diskCost = diskGb * 0.132;
      return sizeEntry + diskCost;
    }
    if (typeId === "azure-aks-cluster") {
      const sizeId = fields["nodeSize"] ?? "";
      if (!sizeId) return null;
      const sizeEntry = VM_SIZE_PRICES[sizeId];
      if (!sizeEntry) return null;
      const nodeCount = Number(fields["nodeCount"] ?? "3");
      // Per-node cost + 128GB OS disk per node
      const diskCostPerNode = 128 * 0.132;
      return (sizeEntry + diskCostPerNode) * nodeCount;
    }
    if (typeId === "azure-container-instance") {
      const cpu = Number(fields["cpu"] ?? "1");
      const memoryGb = Number(fields["memoryGb"] ?? "1.5");
      // Linux pricing: ~$0.0000135/s per vCPU + ~$0.0000015/s per GB RAM
      const cpuMonthly = cpu * 0.0000135 * 2592000; // 30 days in seconds
      const memMonthly = memoryGb * 0.0000015 * 2592000;
      return cpuMonthly + memMonthly;
    }
    if (typeId === "azure-redis-cache") {
      const pricingMap: Record<string, number> = {
        C0: 16.37,
        C1: 40.15,
        C2: 67.74,
        C3: 137.23,
        P1: 171.86,
        P2: 343.72,
        P3: 674.45,
      };
      const capacity = fields["capacity"] ?? "C1";
      return pricingMap[capacity] ?? null;
    }
    if (typeId === "azure-app-service") {
      const skuPricing: Record<string, number> = {
        F1: 0,
        B1: 13.14,
        B2: 26.28,
        S1: 69.35,
        S2: 138.7,
        P1v3: 138.7,
        P2v3: 277.4,
      };
      return skuPricing[fields["sku"] ?? "B1"] ?? null;
    }
    if (typeId === "azure-function-app") {
      const skuPricing: Record<string, number> = {
        Y1: 0,
        B1: 13.14,
        S1: 69.35,
        EP1: 171.55,
      };
      return skuPricing[fields["sku"] ?? "Y1"] ?? null;
    }
    if (typeId === "azure-sql-database") {
      const skuPricing: Record<string, number> = {
        Basic: 4.99,
        S0: 15.03,
        S1: 30.05,
        S2: 75.13,
        P1: 465.0,
        GP_S_Gen5_1: 35.0,
        GP_Gen5_2: 380.0,
      };
      return skuPricing[fields["sku"] ?? "Basic"] ?? null;
    }
    if (typeId === "azure-disk") {
      const diskSizeGb = Number(fields["diskSizeGb"] ?? "128");
      const skuPricingPerGb: Record<string, number> = {
        Standard_LRS: 0.04,
        StandardSSD_LRS: 0.075,
        Premium_LRS: 0.132,
        PremiumV2_LRS: 0.1,
        UltraSSD_LRS: 0.12,
      };
      const pricePerGb = skuPricingPerGb[fields["sku"] ?? "Premium_LRS"] ?? 0.132;
      return diskSizeGb * pricePerGb;
    }
    return null;
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "azure-vm") {
      return this.getVMCreateConfig();
    }
    if (typeId === "azure-aks-cluster") {
      return this.getAKSCreateConfig();
    }
    if (typeId === "azure-storage-account") {
      return this.getStorageAccountCreateConfig();
    }
    if (typeId === "azure-cosmos-db") {
      return this.getCosmosDBCreateConfig();
    }
    if (typeId === "azure-redis-cache") {
      return this.getRedisCacheCreateConfig();
    }
    if (typeId === "azure-postgres-flexible") {
      return this.getFlexibleDBCreateConfig("PostgreSQL", ["16", "15", "14", "13"]);
    }
    if (typeId === "azure-mysql-flexible") {
      return this.getFlexibleDBCreateConfig("MySQL", ["8.0.21", "5.7"]);
    }
    if (typeId === "azure-log-analytics") {
      return this.getLogAnalyticsCreateConfig();
    }
    if (typeId === "azure-managed-identity") {
      return this.getSimpleCreateConfig(
        "Managed Identity Name",
        "Name for the user-assigned managed identity",
        "azure-managed-identity",
      );
    }
    if (typeId === "azure-dns-zone") {
      return this.getSimpleCreateConfig(
        "DNS Zone Name",
        "DNS zone name (e.g. example.com)",
        "azure-dns-zone",
      );
    }
    if (typeId === "azure-vnet") {
      return this.getVNetCreateConfig();
    }
    if (typeId === "azure-nsg") {
      return this.getSimpleCreateConfig("NSG Name", "e.g. my-nsg", "azure-nsg");
    }
    if (typeId === "azure-key-vault") {
      return this.getKeyVaultCreateConfig();
    }
    if (typeId === "azure-container-registry") {
      return this.getContainerRegistryCreateConfig();
    }
    if (typeId === "azure-resource-group") {
      return {
        fields: [
          {
            key: "name",
            label: "Resource Group Name",
            kind: "text",
            required: true,
            description: "Name for the new resource group",
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
    if (typeId === "azure-container-instance") {
      return this.getContainerInstanceCreateConfig();
    }
    if (typeId === "azure-service-bus") {
      return this.getMessagingNamespaceCreateConfig("Service Bus Namespace");
    }
    if (typeId === "azure-event-hub") {
      return this.getMessagingNamespaceCreateConfig("Event Hub Namespace");
    }
    if (typeId === "azure-public-ip") {
      return this.getPublicIPCreateConfig();
    }
    if (typeId === "azure-disk") {
      return this.getDiskCreateConfig();
    }
    if (typeId === "azure-app-service") {
      return this.getAppServiceCreateConfig();
    }
    if (typeId === "azure-function-app") {
      return this.getFunctionAppCreateConfig();
    }
    if (typeId === "azure-sql-database") {
      return this.getSQLDatabaseCreateConfig();
    }
    throw new Error(`Azure plugin: create not supported for type "${typeId}"`);
  }

  private async getVMCreateConfig(): Promise<CreateResourceConfig> {
    // Fetch resource groups for the dropdown
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));

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
              priceMonthly: 7.59,
            },
            {
              id: "Standard_B1ms",
              label: "B1ms",
              vcpus: 1,
              memoryMb: 2048,
              category: "Burstable",
              priceMonthly: 15.18,
            },
            {
              id: "Standard_B2s",
              label: "B2s",
              vcpus: 2,
              memoryMb: 4096,
              category: "Burstable",
              priceMonthly: 30.37,
            },
            {
              id: "Standard_B2ms",
              label: "B2ms",
              vcpus: 2,
              memoryMb: 8192,
              category: "Burstable",
              priceMonthly: 60.74,
            },
            {
              id: "Standard_B4ms",
              label: "B4ms",
              vcpus: 4,
              memoryMb: 16384,
              category: "Burstable",
              priceMonthly: 121.47,
            },
            {
              id: "Standard_D2s_v5",
              label: "D2s v5",
              vcpus: 2,
              memoryMb: 8192,
              category: "General purpose",
              priceMonthly: 70.08,
            },
            {
              id: "Standard_D4s_v5",
              label: "D4s v5",
              vcpus: 4,
              memoryMb: 16384,
              category: "General purpose",
              priceMonthly: 140.16,
            },
            {
              id: "Standard_D8s_v5",
              label: "D8s v5",
              vcpus: 8,
              memoryMb: 32768,
              category: "General purpose",
              priceMonthly: 280.32,
            },
            {
              id: "Standard_D16s_v5",
              label: "D16s v5",
              vcpus: 16,
              memoryMb: 65536,
              category: "General purpose",
              priceMonthly: 560.64,
            },
            {
              id: "Standard_D32s_v5",
              label: "D32s v5",
              vcpus: 32,
              memoryMb: 131072,
              category: "General purpose",
              priceMonthly: 1121.28,
            },
            {
              id: "Standard_E2s_v5",
              label: "E2s v5",
              vcpus: 2,
              memoryMb: 16384,
              category: "Memory optimized",
              priceMonthly: 91.98,
            },
            {
              id: "Standard_E4s_v5",
              label: "E4s v5",
              vcpus: 4,
              memoryMb: 32768,
              category: "Memory optimized",
              priceMonthly: 183.96,
            },
            {
              id: "Standard_E8s_v5",
              label: "E8s v5",
              vcpus: 8,
              memoryMb: 65536,
              category: "Memory optimized",
              priceMonthly: 367.92,
            },
            {
              id: "Standard_F2s_v2",
              label: "F2s v2",
              vcpus: 2,
              memoryMb: 4096,
              category: "Compute optimized",
              priceMonthly: 61.32,
            },
            {
              id: "Standard_F4s_v2",
              label: "F4s v2",
              vcpus: 4,
              memoryMb: 8192,
              category: "Compute optimized",
              priceMonthly: 122.64,
            },
            {
              id: "Standard_F8s_v2",
              label: "F8s v2",
              vcpus: 8,
              memoryMb: 16384,
              category: "Compute optimized",
              priceMonthly: 245.28,
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
      ],
    };
  }

  private async getAKSCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));

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
              priceMonthly: 30.37,
            },
            {
              id: "Standard_D2s_v5",
              label: "D2s v5",
              vcpus: 2,
              memoryMb: 8192,
              category: "General purpose",
              priceMonthly: 70.08,
            },
            {
              id: "Standard_D4s_v5",
              label: "D4s v5",
              vcpus: 4,
              memoryMb: 16384,
              category: "General purpose",
              priceMonthly: 140.16,
            },
            {
              id: "Standard_D8s_v5",
              label: "D8s v5",
              vcpus: 8,
              memoryMb: 32768,
              category: "General purpose",
              priceMonthly: 280.32,
            },
            {
              id: "Standard_E2s_v5",
              label: "E2s v5",
              vcpus: 2,
              memoryMb: 16384,
              category: "Memory optimized",
              priceMonthly: 91.98,
            },
            {
              id: "Standard_E4s_v5",
              label: "E4s v5",
              vcpus: 4,
              memoryMb: 32768,
              category: "Memory optimized",
              priceMonthly: 183.96,
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

  private async getStorageAccountCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));

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

  private async getCosmosDBCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));

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

  private async getRedisCacheCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));

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

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "azure-resource-group") {
      return this.createResourceGroup(accountId, fields);
    }
    if (typeId === "azure-vm") {
      return this.createVM(accountId, fields);
    }
    if (typeId === "azure-storage-account") {
      return this.createStorageAccount(accountId, fields);
    }
    if (typeId === "azure-cosmos-db") {
      return this.createCosmosDB(accountId, fields);
    }
    if (typeId === "azure-redis-cache") {
      return this.createRedisCache(accountId, fields);
    }
    if (typeId === "azure-aks-cluster") {
      return this.createAKSCluster(accountId, fields);
    }
    if (typeId === "azure-postgres-flexible") {
      return this.createFlexibleDB(
        accountId,
        fields,
        "azure-postgres-flexible",
        "Microsoft.DBforPostgreSQL/flexibleServers",
        "2023-06-01-preview",
      );
    }
    if (typeId === "azure-mysql-flexible") {
      return this.createFlexibleDB(
        accountId,
        fields,
        "azure-mysql-flexible",
        "Microsoft.DBforMySQL/flexibleServers",
        "2023-06-30",
      );
    }
    if (typeId === "azure-log-analytics") {
      return this.createLogAnalyticsWorkspace(accountId, fields);
    }
    if (typeId === "azure-managed-identity") {
      return this.createSimpleResource(
        accountId,
        typeId,
        fields,
        "Microsoft.ManagedIdentity/userAssignedIdentities",
        "2023-01-31",
        {},
      );
    }
    if (typeId === "azure-dns-zone") {
      return this.createSimpleResource(
        accountId,
        typeId,
        fields,
        "Microsoft.Network/dnszones",
        "2023-07-01-preview",
        { zoneType: "Public" },
      );
    }
    if (typeId === "azure-vnet") {
      return this.createVNet(accountId, fields);
    }
    if (typeId === "azure-nsg") {
      return this.createSimpleResource(
        accountId,
        typeId,
        fields,
        "Microsoft.Network/networkSecurityGroups",
        "2023-09-01",
        {},
      );
    }
    if (typeId === "azure-key-vault") {
      return this.createKeyVault(accountId, fields);
    }
    if (typeId === "azure-container-registry") {
      return this.createContainerRegistry(accountId, fields);
    }
    if (typeId === "azure-container-instance") {
      return this.createContainerInstance(accountId, fields);
    }
    if (typeId === "azure-service-bus") {
      return this.createMessagingNamespace(
        accountId,
        fields,
        "azure-service-bus",
        "Microsoft.ServiceBus/namespaces",
        "2022-10-01-preview",
      );
    }
    if (typeId === "azure-event-hub") {
      return this.createMessagingNamespace(
        accountId,
        fields,
        "azure-event-hub",
        "Microsoft.EventHub/namespaces",
        "2024-01-01",
      );
    }
    if (typeId === "azure-public-ip") {
      return this.createPublicIP(accountId, fields);
    }
    if (typeId === "azure-disk") {
      return this.createDisk(accountId, fields);
    }
    if (typeId === "azure-app-service") {
      return this.createAppService(accountId, fields);
    }
    if (typeId === "azure-function-app") {
      return this.createFunctionApp(accountId, fields);
    }
    if (typeId === "azure-sql-database") {
      return this.createSQLDatabase(accountId, fields);
    }
    throw new Error(`Azure plugin: create not supported for "${typeId}"`);
  }

  private async getFlexibleDBCreateConfig(
    dbEngine: string,
    versions: string[],
  ): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));

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
              priceMonthly: 12.41,
            },
            {
              id: "Standard_B2s",
              label: "B2s",
              vcpus: 2,
              memoryMb: 4096,
              category: "Burstable",
              priceMonthly: 24.82,
            },
            {
              id: "Standard_B2ms",
              label: "B2ms",
              vcpus: 2,
              memoryMb: 8192,
              category: "Burstable",
              priceMonthly: 49.64,
            },
            {
              id: "Standard_D2ds_v4",
              label: "D2ds v4",
              vcpus: 2,
              memoryMb: 8192,
              category: "General Purpose",
              priceMonthly: 98.55,
            },
            {
              id: "Standard_D4ds_v4",
              label: "D4ds v4",
              vcpus: 4,
              memoryMb: 16384,
              category: "General Purpose",
              priceMonthly: 197.1,
            },
            {
              id: "Standard_D8ds_v4",
              label: "D8ds v4",
              vcpus: 8,
              memoryMb: 32768,
              category: "General Purpose",
              priceMonthly: 394.2,
            },
            {
              id: "Standard_E2ds_v4",
              label: "E2ds v4",
              vcpus: 2,
              memoryMb: 16384,
              category: "Memory Optimized",
              priceMonthly: 131.4,
            },
            {
              id: "Standard_E4ds_v4",
              label: "E4ds v4",
              vcpus: 4,
              memoryMb: 32768,
              category: "Memory Optimized",
              priceMonthly: 262.8,
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

  private async createFlexibleDB(
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

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/${resourceProvider}/${name}?api-version=${apiVersion}`,
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
      id: this.makeId(accountId, typeId, `${rg}/${name}`),
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

  private async getSQLDatabaseCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));

    // List existing SQL servers
    const servers = await this.get<{ value: Array<{ name: string; id: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/providers/Microsoft.Sql/servers?api-version=2023-05-01-preview`,
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

  private async createSQLDatabase(
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
      await this.put(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${serverRg}/providers/Microsoft.Sql/servers/${serverName}?api-version=2023-05-01-preview`,
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

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${serverRg}/providers/Microsoft.Sql/servers/${serverName}/databases/${dbName}?api-version=2023-05-01-preview`,
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
      id: this.makeId(accountId, "azure-sql-database", `${serverRg}/${serverName}/${dbName}`),
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

  private async getDiskCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
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

  private async createDisk(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const rg = fields["resourceGroup"]!;
    const location = fields["region"]!;
    const sku = fields["sku"] ?? "Premium_LRS";
    const diskSizeGb = Number(fields["diskSizeGb"] ?? "128");

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Compute/disks/${name}?api-version=2023-10-02`,
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
      id: this.makeId(accountId, "azure-disk", `${rg}/${name}`),
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

  private async getAppServiceCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
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

  private async createAppService(
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
    await this.put(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}?api-version=2023-01-01`,
      {
        location,
        kind: "linux",
        properties: { reserved: true },
        sku: { name: sku },
      },
    );

    // Create the Web App
    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${name}?api-version=2023-01-01`,
      {
        location,
        kind: "app,linux",
        properties: {
          serverFarmId: `/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}`,
          siteConfig: {
            linuxFxVersion: runtime,
          },
          httpsOnly: true,
        },
      },
    );
    const props = result["properties"] as Record<string, unknown> | undefined;
    return {
      id: this.makeId(accountId, "azure-app-service", `${rg}/${name}`),
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

  private async getFunctionAppCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));

    // List storage accounts for the required storage binding
    const storageAccounts = await this.get<{ value: Array<{ id: string; name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`,
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

  private async createFunctionApp(
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
    await this.put(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}?api-version=2023-01-01`,
      {
        location,
        kind: "functionapp",
        properties: { reserved: true },
        sku: { name: sku, tier: isConsumption ? "Dynamic" : undefined },
      },
    );

    // Get storage account key
    const storageKeys = await this.post<{ keys?: Array<{ value: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${storageRg}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}/listKeys?api-version=2023-01-01`,
      {},
    );
    const storageKey = storageKeys.keys?.[0]?.value ?? "";
    const storageConnStr = `DefaultEndpointsProtocol=https;AccountName=${storageAccountName};AccountKey=${storageKey};EndpointSuffix=core.windows.net`;

    // Create function app
    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${name}?api-version=2023-01-01`,
      {
        location,
        kind: "functionapp,linux",
        properties: {
          serverFarmId: `/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}`,
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
      id: this.makeId(accountId, "azure-function-app", `${rg}/${name}`),
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

  private async getContainerInstanceCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
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

  private async createContainerInstance(
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

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerInstance/containerGroups/${name}?api-version=2023-05-01`,
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
      id: this.makeId(accountId, "azure-container-instance", `${rg}/${name}`),
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

  private async getMessagingNamespaceCreateConfig(label: string): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
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

  private async createMessagingNamespace(
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

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/${provider}/${name}?api-version=${apiVersion}`,
      {
        location,
        sku: { name: sku, tier: sku },
        properties: {},
      },
    );
    const props = result["properties"] as Record<string, unknown> | undefined;
    return {
      id: this.makeId(accountId, typeId, `${rg}/${name}`),
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

  private async getPublicIPCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
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

  private async createPublicIP(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const rg = fields["resourceGroup"]!;
    const location = fields["region"]!;
    const sku = fields["sku"] ?? "Standard";
    const allocationMethod = fields["allocationMethod"] ?? "Static";
    const ipVersion = fields["ipVersion"] ?? "IPv4";

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/publicIPAddresses/${name}?api-version=2023-09-01`,
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
      id: this.makeId(accountId, "azure-public-ip", `${rg}/${name}`),
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
        fqdn: String(
          (props?.["dnsSettings"] as Record<string, unknown> | undefined)?.["fqdn"] ?? "",
        ),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async getLogAnalyticsCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
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

  private async createLogAnalyticsWorkspace(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const rg = fields["resourceGroup"]!;
    const location = fields["region"]!;
    const sku = fields["sku"] ?? "PerGB2018";
    const retentionInDays = Number(fields["retentionInDays"] ?? "30");

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.OperationalInsights/workspaces/${name}?api-version=2022-10-01`,
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
      id: this.makeId(accountId, "azure-log-analytics", `${rg}/${name}`),
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

  private async getSimpleCreateConfig(
    nameLabel: string,
    description: string,
    _typeId: string,
  ): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
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

  private async createSimpleResource(
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
    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/${provider}/${name}?api-version=${apiVersion}`,
      { location, properties: extraProperties },
    );
    const props = result["properties"] as Record<string, unknown> | undefined;
    return {
      id: this.makeId(accountId, typeId, `${rg}/${name}`),
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

  private async getVNetCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
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

  private async createVNet(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const rg = fields["resourceGroup"]!;
    const location = fields["region"]!;
    const addressSpace = fields["addressSpace"] ?? "10.0.0.0/16";
    const subnetName = fields["subnetName"] ?? "default";
    const subnetPrefix = fields["subnetPrefix"] ?? "10.0.0.0/24";

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${name}?api-version=2023-09-01`,
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
      id: this.makeId(accountId, "azure-vnet", `${rg}/${name}`),
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

  private async getKeyVaultCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
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

  private async createKeyVault(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const rg = fields["resourceGroup"]!;
    const location = fields["region"]!;
    const sku = fields["sku"] ?? "standard";
    const enableSoftDelete = fields["enableSoftDelete"] !== "false";

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.KeyVault/vaults/${name}?api-version=2023-07-01`,
      {
        location,
        properties: {
          tenantId: this.creds.tenantId,
          sku: { family: "A", name: sku },
          enableSoftDelete,
          enableRbacAuthorization: true,
          accessPolicies: [],
        },
      },
    );
    const props = result["properties"] as Record<string, unknown> | undefined;
    return {
      id: this.makeId(accountId, "azure-key-vault", `${rg}/${name}`),
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

  private async getContainerRegistryCreateConfig(): Promise<CreateResourceConfig> {
    const rgs = await this.get<{ value: Array<{ name: string }> }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups?api-version=2022-09-01`,
    );
    const rgOptions = (rgs.value ?? []).map((rg) => ({ id: rg.name, label: rg.name }));
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

  private async createContainerRegistry(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const rg = fields["resourceGroup"]!;
    const location = fields["region"]!;
    const sku = fields["sku"] ?? "Basic";
    const adminEnabled = fields["adminEnabled"] === "true";

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerRegistry/registries/${name}?api-version=2023-07-01`,
      {
        location,
        sku: { name: sku },
        properties: { adminUserEnabled: adminEnabled },
      },
    );
    const props = result["properties"] as Record<string, unknown> | undefined;
    return {
      id: this.makeId(accountId, "azure-container-registry", `${rg}/${name}`),
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

  private async createResourceGroup(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const location = fields["region"]!;
    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups/${name}?api-version=2022-09-01`,
      { location },
    );
    const props = result["properties"] as Record<string, unknown> | undefined;
    return {
      id: this.makeId(accountId, "azure-resource-group", name),
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

  private async createVM(
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
    await this.put(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${vnetName}?api-version=2023-09-01`,
      {
        location,
        properties: {
          addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
          subnets: [{ name: subnetName, properties: { addressPrefix: "10.0.0.0/24" } }],
        },
      },
    );
    const subnetId = `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${vnetName}/subnets/${subnetName}`;

    // Step 2: Create a public IP
    const pipName = `${name}-pip`;
    const pipResult = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/publicIPAddresses/${pipName}?api-version=2023-09-01`,
      {
        location,
        sku: { name: "Standard" },
        properties: { publicIPAllocationMethod: "Static" },
      },
    );
    const pipId = String(pipResult["id"] ?? "");

    // Step 3: Create NSG with SSH rule for Linux VMs
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
    const nsgResult = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/networkSecurityGroups/${nsgName}?api-version=2023-09-01`,
      { location, properties: { securityRules: nsgRules } },
    );
    const nsgId = String(nsgResult["id"] ?? "");

    // Step 4: Create a NIC
    const nicName = `${name}-nic`;
    const nicResult = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/networkInterfaces/${nicName}?api-version=2023-09-01`,
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

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${name}?api-version=2024-03-01`,
      vmBody,
    );

    const props = result["properties"] as Record<string, unknown> | undefined;
    return {
      id: this.makeId(accountId, "azure-vm", `${rg}/${name}`),
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
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async createAKSCluster(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const rg = fields["resourceGroup"]!;
    const location = fields["region"]!;
    const k8sVersion = fields["kubernetesVersion"]!;
    const nodeSize = fields["nodeSize"]!;
    const nodeCount = Number(fields["nodeCount"] ?? "3");

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerService/managedClusters/${name}?api-version=2024-01-01`,
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
            clientId: this.creds.clientId,
            secret: this.creds.clientSecret,
          },
        },
        identity: { type: "SystemAssigned" },
      },
    );

    const props = result["properties"] as Record<string, unknown> | undefined;
    return {
      id: this.makeId(accountId, "azure-aks-cluster", `${rg}/${name}`),
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

  private async createStorageAccount(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const rg = fields["resourceGroup"]!;
    const location = fields["region"]!;
    const sku = fields["sku"] ?? "Standard_LRS";
    const kind = fields["kind"] ?? "StorageV2";

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}?api-version=2023-01-01`,
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
      id: this.makeId(accountId, "azure-storage-account", `${rg}/${name}`),
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

  private async createCosmosDB(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const rg = fields["resourceGroup"]!;
    const location = fields["region"]!;
    const kind = fields["kind"] ?? "GlobalDocumentDB";
    const consistencyLevel = fields["consistencyLevel"] ?? "Session";

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${name}?api-version=2023-11-15`,
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
      id: this.makeId(accountId, "azure-cosmos-db", `${rg}/${name}`),
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

  private async createRedisCache(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]!;
    const rg = fields["resourceGroup"]!;
    const location = fields["region"]!;
    const skuName = fields["sku"] ?? "Basic";
    const capacity = Number(fields["capacity"] ?? "0");
    const skuFamily = skuName === "Premium" ? "P" : "C";

    const result = await this.put<Record<string, unknown>>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Cache/redis/${name}?api-version=2023-08-01`,
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
      id: this.makeId(accountId, "azure-redis-cache", `${rg}/${name}`),
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

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const externalId = resource.externalId ?? "";

    const deleteMap: Record<string, { provider: string; apiVersion: string }> = {
      "azure-resource-group": { provider: "", apiVersion: "2022-09-01" },
      "azure-vm": { provider: "Microsoft.Compute/virtualMachines", apiVersion: "2024-03-01" },
      "azure-disk": { provider: "Microsoft.Compute/disks", apiVersion: "2023-10-02" },
      "azure-vnet": { provider: "Microsoft.Network/virtualNetworks", apiVersion: "2023-09-01" },
      "azure-aks-cluster": {
        provider: "Microsoft.ContainerService/managedClusters",
        apiVersion: "2024-01-01",
      },
      "azure-sql-database": { provider: "", apiVersion: "" }, // Special handling
      "azure-cosmos-db": {
        provider: "Microsoft.DocumentDB/databaseAccounts",
        apiVersion: "2023-11-15",
      },
      "azure-storage-account": {
        provider: "Microsoft.Storage/storageAccounts",
        apiVersion: "2023-01-01",
      },
      "azure-function-app": { provider: "Microsoft.Web/sites", apiVersion: "2023-01-01" },
      "azure-app-service": { provider: "Microsoft.Web/sites", apiVersion: "2023-01-01" },
      "azure-container-instance": {
        provider: "Microsoft.ContainerInstance/containerGroups",
        apiVersion: "2023-05-01",
      },
      "azure-key-vault": { provider: "Microsoft.KeyVault/vaults", apiVersion: "2023-07-01" },
      "azure-redis-cache": { provider: "Microsoft.Cache/redis", apiVersion: "2023-08-01" },
      "azure-service-bus": {
        provider: "Microsoft.ServiceBus/namespaces",
        apiVersion: "2022-10-01-preview",
      },
      "azure-container-registry": {
        provider: "Microsoft.ContainerRegistry/registries",
        apiVersion: "2023-07-01",
      },
      "azure-load-balancer": {
        provider: "Microsoft.Network/loadBalancers",
        apiVersion: "2023-09-01",
      },
      "azure-dns-zone": {
        provider: "Microsoft.Network/dnszones",
        apiVersion: "2023-07-01-preview",
      },
      "azure-nsg": {
        provider: "Microsoft.Network/networkSecurityGroups",
        apiVersion: "2023-09-01",
      },
      "azure-public-ip": {
        provider: "Microsoft.Network/publicIPAddresses",
        apiVersion: "2023-09-01",
      },
      "azure-postgres-flexible": {
        provider: "Microsoft.DBforPostgreSQL/flexibleServers",
        apiVersion: "2023-06-01-preview",
      },
      "azure-mysql-flexible": {
        provider: "Microsoft.DBforMySQL/flexibleServers",
        apiVersion: "2023-06-30",
      },
      "azure-event-hub": {
        provider: "Microsoft.EventHub/namespaces",
        apiVersion: "2022-10-01-preview",
      },
      "azure-app-gateway": {
        provider: "Microsoft.Network/applicationGateways",
        apiVersion: "2023-09-01",
      },
      "azure-log-analytics": {
        provider: "Microsoft.OperationalInsights/workspaces",
        apiVersion: "2022-10-01",
      },
      "azure-managed-identity": {
        provider: "Microsoft.ManagedIdentity/userAssignedIdentities",
        apiVersion: "2023-01-31",
      },
      "azure-firewall": { provider: "Microsoft.Network/azureFirewalls", apiVersion: "2023-09-01" },
    };

    const spec = deleteMap[typeId];
    if (!spec) throw new Error(`Azure plugin: delete not supported for "${typeId}"`);

    if (typeId === "azure-resource-group") {
      const rgName = externalId;
      await this.del(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups/${rgName}?api-version=${spec.apiVersion}`,
      );
      return;
    }

    if (typeId === "azure-sql-database") {
      // externalId is rg/server/database
      const parts = externalId.split("/");
      const [rg, server, db] = parts;
      await this.del(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Sql/servers/${server}/databases/${db}?api-version=2023-05-01-preview`,
      );
      return;
    }

    // Standard two-part externalId: rg/name
    const [rg, name] = externalId.split("/");
    await this.del(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/${spec.provider}/${name}?api-version=${spec.apiVersion}`,
    );
  }

  private buildArmUrl(typeId: string, externalId: string): string {
    const armSpecs: Record<string, { provider: string; apiVersion: string }> = {
      "azure-resource-group": { provider: "", apiVersion: "2022-09-01" },
      "azure-vm": { provider: "Microsoft.Compute/virtualMachines", apiVersion: "2024-03-01" },
      "azure-disk": { provider: "Microsoft.Compute/disks", apiVersion: "2023-10-02" },
      "azure-vnet": { provider: "Microsoft.Network/virtualNetworks", apiVersion: "2023-09-01" },
      "azure-aks-cluster": {
        provider: "Microsoft.ContainerService/managedClusters",
        apiVersion: "2024-01-01",
      },
      "azure-sql-database": { provider: "Microsoft.Sql/servers", apiVersion: "2023-05-01-preview" },
      "azure-cosmos-db": {
        provider: "Microsoft.DocumentDB/databaseAccounts",
        apiVersion: "2023-11-15",
      },
      "azure-storage-account": {
        provider: "Microsoft.Storage/storageAccounts",
        apiVersion: "2023-01-01",
      },
      "azure-function-app": { provider: "Microsoft.Web/sites", apiVersion: "2023-01-01" },
      "azure-app-service": { provider: "Microsoft.Web/sites", apiVersion: "2023-01-01" },
      "azure-container-instance": {
        provider: "Microsoft.ContainerInstance/containerGroups",
        apiVersion: "2023-05-01",
      },
      "azure-key-vault": { provider: "Microsoft.KeyVault/vaults", apiVersion: "2023-07-01" },
      "azure-redis-cache": { provider: "Microsoft.Cache/redis", apiVersion: "2023-08-01" },
      "azure-service-bus": {
        provider: "Microsoft.ServiceBus/namespaces",
        apiVersion: "2022-10-01-preview",
      },
      "azure-container-registry": {
        provider: "Microsoft.ContainerRegistry/registries",
        apiVersion: "2023-07-01",
      },
      "azure-load-balancer": {
        provider: "Microsoft.Network/loadBalancers",
        apiVersion: "2023-09-01",
      },
      "azure-dns-zone": {
        provider: "Microsoft.Network/dnszones",
        apiVersion: "2023-07-01-preview",
      },
      "azure-nsg": {
        provider: "Microsoft.Network/networkSecurityGroups",
        apiVersion: "2023-09-01",
      },
      "azure-public-ip": {
        provider: "Microsoft.Network/publicIPAddresses",
        apiVersion: "2023-09-01",
      },
      "azure-postgres-flexible": {
        provider: "Microsoft.DBforPostgreSQL/flexibleServers",
        apiVersion: "2023-06-01-preview",
      },
      "azure-mysql-flexible": {
        provider: "Microsoft.DBforMySQL/flexibleServers",
        apiVersion: "2023-06-30",
      },
      "azure-event-hub": {
        provider: "Microsoft.EventHub/namespaces",
        apiVersion: "2022-10-01-preview",
      },
      "azure-app-gateway": {
        provider: "Microsoft.Network/applicationGateways",
        apiVersion: "2023-09-01",
      },
      "azure-log-analytics": {
        provider: "Microsoft.OperationalInsights/workspaces",
        apiVersion: "2022-10-01",
      },
      "azure-managed-identity": {
        provider: "Microsoft.ManagedIdentity/userAssignedIdentities",
        apiVersion: "2023-01-31",
      },
      "azure-firewall": { provider: "Microsoft.Network/azureFirewalls", apiVersion: "2023-09-01" },
    };

    const spec = armSpecs[typeId];
    if (!spec) throw new Error(`Azure plugin: manifest not supported for "${typeId}"`);

    if (typeId === "azure-resource-group") {
      return `${ARM}/subscriptions/${this.creds.subscriptionId}/resourcegroups/${externalId}?api-version=${spec.apiVersion}`;
    }
    if (typeId === "azure-sql-database") {
      const [rg, server, db] = externalId.split("/");
      return `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/${spec.provider}/${server}/databases/${db}?api-version=${spec.apiVersion}`;
    }
    const [rg, name] = externalId.split("/");
    return `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/${spec.provider}/${name}?api-version=${spec.apiVersion}`;
  }

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    // Resource ID format: accountId:typeId:externalId
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";
    const externalId = parts.slice(2).join(":");
    const url = this.buildArmUrl(typeId, externalId);
    const raw = await this.get<Record<string, unknown>>(url);
    return JSON.stringify(raw, null, 2);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";
    const externalId = parts.slice(2).join(":");
    const url = this.buildArmUrl(typeId, externalId);
    const body = JSON.parse(manifest);
    await this.put(url, body);
  }
}
