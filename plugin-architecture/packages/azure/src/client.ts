import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceStatus,
  ResourceTypeDefinition,
  StorageObject,
  ArtifactEntry,
  CreateResourceConfig,
  CreateSizePricingRequest,
  DashboardStat,
  CredentialExport,
} from "@infrawrench/plugin-base";
import {
  formatBytes,
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";
import {
  fetchAccessToken,
  fetchAcrAccessToken,
  fetchGraphAccessToken,
  fetchStorageAccessToken,
  type AzureCredentials,
} from "./auth.js";
import type { ListerContext } from "./resource-listers.js";
import * as listers from "./resource-listers.js";
import { AZURE_REGIONS } from "./regions.js";
import {
  fetchAzurePricingRates,
  estimateVmMonthlyPrices,
  HOURS_PER_MONTH,
  type AzurePricingRates,
  type AzurePricingCacheEntry,
} from "./pricing.js";
import {
  type AzureCreateContext,
  getVMCreateConfig,
  getAKSCreateConfig,
  getStorageAccountCreateConfig,
  getCosmosDBCreateConfig,
  getRedisCacheCreateConfig,
  getFlexibleDBCreateConfig,
  getSQLDatabaseCreateConfig,
  getDiskCreateConfig,
  getAppServiceCreateConfig,
  getFunctionAppCreateConfig,
  getContainerInstanceCreateConfig,
  getMessagingNamespaceCreateConfig,
  getPublicIPCreateConfig,
  getLogAnalyticsCreateConfig,
  getLoadBalancerCreateConfig,
  getSimpleCreateConfig,
  getVNetCreateConfig,
  getKeyVaultCreateConfig,
  getContainerRegistryCreateConfig,
  createFlexibleDB,
  createSQLDatabase,
  createDisk,
  createAppService,
  createFunctionApp,
  createContainerInstance,
  createMessagingNamespace,
  createPublicIP,
  createLogAnalyticsWorkspace,
  createSimpleResource,
  createVNet,
  createKeyVault,
  createContainerRegistry,
  createAppRegistration,
  createResourceGroup,
  createVM,
  createAKSCluster,
  createStorageAccount,
  createCosmosDB,
  createRedisCache,
} from "./create-handlers.js";

const ARM = "https://management.azure.com";

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class AzureClient implements PluginClient {
  private readonly creds: AzureCredentials;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private tokenCache: TokenCache | null = null;
  private storageTokenCache: TokenCache | null = null;
  private graphTokenCache: TokenCache | null = null;
  private pricingRateCache = new Map<string, AzurePricingCacheEntry>();
  private pricingRateInFlight = new Map<string, Promise<AzurePricingRates>>();

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

  private async getPricingRatesForRegion(region: string): Promise<AzurePricingRates> {
    const cached = this.pricingRateCache.get(region);
    if (cached && cached.expiresAt > Date.now()) {
      const { expiresAt: _expiresAt, ...rates } = cached;
      return rates;
    }
    const inFlight = this.pricingRateInFlight.get(region);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const rates = await fetchAzurePricingRates(region);
      this.pricingRateCache.set(region, {
        ...rates,
        expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      });
      return rates;
    })();
    this.pricingRateInFlight.set(region, promise);
    try {
      return await promise;
    } finally {
      this.pricingRateInFlight.delete(region);
    }
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

  /** Microsoft Graph access token — separate audience from ARM. */
  private async graphToken(): Promise<string> {
    const now = Date.now();
    if (this.graphTokenCache && this.graphTokenCache.expiresAt > now + 60_000) {
      return this.graphTokenCache.token;
    }
    const t = await fetchGraphAccessToken(this.creds);
    this.graphTokenCache = { token: t, expiresAt: now + 3_600_000 };
    return t;
  }

  /** Low-level Graph request helper — handles auth + parses the error envelope. */
  private async graphRequest<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const tok = await this.graphToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tok}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(extraHeaders ?? {}),
    };
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return undefined as unknown as T;
    const raw = await res.text();
    if (!res.ok) {
      // Graph error envelope: { error: { code, message, innerError } }
      try {
        const parsed = JSON.parse(raw) as {
          error?: { code?: string; message?: string };
        };
        const code = parsed.error?.code ?? "UnknownError";
        const msg = parsed.error?.message ?? raw;
        throw new Error(`Graph ${method} ${path} (${res.status}) ${code}: ${msg}`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Graph ")) throw e;
        throw new Error(`Graph ${method} ${path} (${res.status}): ${raw}`);
      }
    }
    return raw ? (JSON.parse(raw) as T) : (undefined as unknown as T);
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

  private async patch<T>(url: string, body: unknown): Promise<T> {
    const tok = await this.token();
    const res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Azure API PATCH ${res.status}: ${await res.text()}`);
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

  private get createCtx(): AzureCreateContext {
    return {
      get: <T>(url: string) => this.get<T>(url),
      post: <T>(url: string, body: unknown) => this.post<T>(url, body),
      put: <T>(url: string, body: unknown) => this.put<T>(url, body),
      patch: <T>(url: string, body: unknown) => this.patch<T>(url, body),
      del: (url: string) => this.del(url),
      makeId: (accountId, typeId, externalId) => this.makeId(accountId, typeId, externalId),
      graphRequest: <T>(
        method: "GET" | "POST" | "DELETE" | "PATCH",
        path: string,
        body?: unknown,
        extraHeaders?: Record<string, string>,
      ) => this.graphRequest<T>(method, path, body, extraHeaders),
      subscriptionId: this.creds.subscriptionId,
      tenantId: this.creds.tenantId,
      clientId: this.creds.clientId,
      clientSecret: this.creds.clientSecret,
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
    if (typeId === "azure-app-registration") {
      return this.listAppRegistrations(accountId);
    }
    const lister = AzureClient.LISTERS[typeId];
    if (!lister) throw new Error(`Azure plugin: unknown resource type "${typeId}"`);
    return lister(this.ctx, accountId);
  }

  /**
   * List app registrations owned by the caller's service principal.
   * Scopes to `Application.ReadWrite.OwnedBy` ownership via the `/me/ownedObjects` pattern —
   * but the client-credentials flow has no /me; Graph requires explicit filter by owners.
   * Simpler: list all apps the caller has permission to see and let the SP's scope gate results.
   */
  private async listAppRegistrations(accountId: string): Promise<ResourceInstance[]> {
    const apps: Array<Record<string, unknown>> = [];
    let nextLink: string | undefined;
    const servicePrincipals = new Map<string, string>(); // appId -> sp.id

    // First page: apps
    let data = await this.graphRequest<{
      value: Array<Record<string, unknown>>;
      "@odata.nextLink"?: string;
    }>("GET", "/applications?$top=100&$select=id,appId,displayName,signInAudience,createdDateTime");
    apps.push(...data.value);
    nextLink = data["@odata.nextLink"];
    while (nextLink) {
      const tok = await this.graphToken();
      const res = await fetch(nextLink, { headers: { Authorization: `Bearer ${tok}` } });
      if (!res.ok) break;
      data = (await res.json()) as typeof data;
      apps.push(...data.value);
      nextLink = data["@odata.nextLink"];
    }

    // Look up service principals in one call, filter by appId IN (list) — but Graph doesn't
    // support IN filters on appId. Do individual lookups only for the ones we show;
    // batch endpoint would be ideal but adds complexity. For a typical owned-by scope
    // the list is small.
    for (const app of apps) {
      const appId = String(app["appId"] ?? "");
      if (!appId) continue;
      try {
        const spList = await this.graphRequest<{ value: Array<Record<string, unknown>> }>(
          "GET",
          `/servicePrincipals?$filter=appId eq '${appId}'&$select=id`,
        );
        const spId = spList.value[0]?.["id"];
        if (typeof spId === "string") servicePrincipals.set(appId, spId);
      } catch {
        // skip — SP lookup failure shouldn't block listing
      }
    }

    const now = this.ctx.now();
    return apps.map((a) => {
      const appId = String(a["appId"] ?? "");
      const objectId = String(a["id"] ?? "");
      const displayName = String(a["displayName"] ?? objectId);
      return {
        id: this.makeId(accountId, "azure-app-registration", objectId),
        pluginId: "azure",
        resourceTypeId: "azure-app-registration",
        accountId,
        displayName,
        fields: {
          displayName,
          appId,
          objectId,
          servicePrincipalId: servicePrincipals.get(appId) ?? "",
          signInAudience: String(a["signInAudience"] ?? ""),
          createdDateTime: String(a["createdDateTime"] ?? ""),
        },
        resolvedOutputs: { appId, tenantId: this.creds.tenantId },
        secretStates: [],
        externalId: objectId,
        createdAt: String(a["createdDateTime"] ?? now),
        updatedAt: now,
      };
    });
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
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ServiceBus/namespaces/${name}/AuthorizationRules/RootManageSharedAccessKey/listKeys?api-version=2024-01-01`,
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

    if (typeId === "azure-app-registration" && outputKey === "clientSecret") {
      const exp = await this.exportCredential(typeId, resourceId, accountId, "client-secret");
      return exp.content;
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
    const dotStatus = statusMap[state.toLowerCase()] ?? "info";

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

    if (resource.resourceTypeId === "azure-container-registry") {
      detail.artifactRegistry = { format: "docker", supportsTags: true };
      detail.status = {
        kind: "status-dot",
        status: dotStatus === "info" ? "healthy" : dotStatus,
        ...(state ? { label: state } : {}),
      };
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
      status: { kind: "status-dot", status: statusMap[state.toLowerCase()] ?? "info" },
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

  private async getAcrBearerToken(loginServer: string): Promise<string> {
    // Step 1: AAD token scoped to containerregistry.azure.net
    const aadToken = await fetchAcrAccessToken(this.creds);

    // Step 2: Exchange AAD token for an ACR refresh token
    const exchangeBody = new URLSearchParams({
      grant_type: "access_token",
      service: loginServer,
      tenant: this.creds.tenantId,
      access_token: aadToken,
    });
    const exchangeRes = await fetch(`https://${loginServer}/oauth2/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: exchangeBody.toString(),
    });
    if (!exchangeRes.ok) {
      throw new Error(
        `ACR token exchange failed: ${exchangeRes.status} ${await exchangeRes.text()}`,
      );
    }
    const exchangeData = (await exchangeRes.json()) as { refresh_token: string };

    // Step 3: Exchange refresh token for an ACR access token
    const tokenBody = new URLSearchParams({
      grant_type: "refresh_token",
      service: loginServer,
      scope: "registry:catalog:* repository:*:pull repository:*:metadata_read",
      refresh_token: exchangeData.refresh_token,
    });
    const tokenRes = await fetch(`https://${loginServer}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    if (!tokenRes.ok) {
      throw new Error(`ACR token grant failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const tokenData = (await tokenRes.json()) as { access_token: string };
    return tokenData.access_token;
  }

  async listArtifacts(
    typeId: string,
    resourceId: string,
    accountId: string,
    params?: { pageToken?: string; prefix?: string },
  ): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> {
    if (typeId !== "azure-container-registry") {
      throw new Error(`listArtifacts not supported for type ${typeId}`);
    }
    const marker = `${accountId}:${typeId}:`;
    const externalId = resourceId.startsWith(marker) ? resourceId.slice(marker.length) : resourceId;
    const [rg, name] = externalId.split("/");
    if (!rg || !name) {
      throw new Error(`Invalid azure-container-registry resource id: ${resourceId}`);
    }
    const registry = await this.get<{ properties?: { loginServer?: string } }>(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerRegistry/registries/${name}?api-version=2023-07-01`,
    );
    const loginServer = registry.properties?.loginServer ?? `${name}.azurecr.io`;

    const bearer = await this.getAcrBearerToken(loginServer);
    const authHeaders = { Authorization: `Bearer ${bearer}` };

    // Page through the catalog
    const catalogUrl = new URL(`https://${loginServer}/v2/_catalog`);
    catalogUrl.searchParams.set("n", "50");
    if (params?.pageToken) catalogUrl.searchParams.set("last", params.pageToken);
    const catalogRes = await fetch(catalogUrl.toString(), { headers: authHeaders });
    if (!catalogRes.ok) {
      throw new Error(`ACR catalog failed: ${catalogRes.status} ${await catalogRes.text()}`);
    }
    const catalog = (await catalogRes.json()) as { repositories?: string[] };
    const repos = catalog.repositories ?? [];

    const prefix = params?.prefix?.trim();
    const filteredRepos = prefix ? repos.filter((r) => r.includes(prefix)) : repos;

    // For each repo, fetch tags (ACR extension: _tags returns rich metadata)
    const items: ArtifactEntry[] = [];
    await Promise.all(
      filteredRepos.map(async (repo) => {
        const tagsUrl = `https://${loginServer}/acr/v1/${encodeURIComponent(repo)}/_tags?n=50&orderby=timedesc`;
        const tagsRes = await fetch(tagsUrl, { headers: authHeaders });
        if (!tagsRes.ok) {
          items.push({ name: repo });
          return;
        }
        const data = (await tagsRes.json()) as {
          tags?: Array<{
            name: string;
            digest?: string;
            createdTime?: string;
            lastUpdateTime?: string;
            signed?: boolean;
          }>;
        };
        const tags = data.tags ?? [];
        if (tags.length === 0) {
          items.push({ name: repo });
          return;
        }
        // Group tags by digest so we can present all tags on the same image together
        const byDigest = new Map<string, ArtifactEntry>();
        for (const t of tags) {
          const key = t.digest ?? `__${t.name}`;
          const existing = byDigest.get(key);
          if (existing) {
            existing.tags = [...(existing.tags ?? []), t.name];
          } else {
            const entry: ArtifactEntry = { name: repo, tags: [t.name] };
            if (t.digest) entry.digest = t.digest;
            if (t.lastUpdateTime) entry.updatedAt = t.lastUpdateTime;
            else if (t.createdTime) entry.updatedAt = t.createdTime;
            byDigest.set(key, entry);
          }
        }
        for (const entry of byDigest.values()) {
          const firstTag = entry.tags?.[0];
          if (firstTag) entry.version = firstTag;
          items.push(entry);
        }
      }),
    );

    // The Docker Registry catalog uses `last=<name>` for pagination —
    // the next page token is the last repo in the current page when it's full.
    const result: { items: ArtifactEntry[]; nextPageToken?: string } = { items };
    const lastRepo = repos[repos.length - 1];
    if (repos.length >= 50 && lastRepo) result.nextPageToken = lastRepo;
    return result;
  }

  async getCreateSizePricing(
    typeId: string,
    request: CreateSizePricingRequest,
  ): Promise<Record<string, number>> {
    const supportsSizePricing =
      typeId === "azure-vm" ||
      typeId === "azure-aks-cluster" ||
      typeId === "azure-postgres-flexible" ||
      typeId === "azure-mysql-flexible";
    if (!supportsSizePricing) return {};
    const region = request.regionId ?? "eastus";
    const rates = await this.getPricingRatesForRegion(region);
    return estimateVmMonthlyPrices(request.sizes, rates);
  }

  async getCreateCostEstimate(
    typeId: string,
    fields: Record<string, string>,
  ): Promise<number | null> {
    const region = fields["region"] ?? "eastus";
    const rates = await this.getPricingRatesForRegion(region);

    if (typeId === "azure-vm") {
      const sizeId = fields["size"] ?? "";
      const hourly = rates.vmHourlyUsd[sizeId];
      if (hourly == null) return null;
      const diskGb = Number(fields["bootDiskSizeGb"] ?? "64");
      const diskRate = rates.diskGbMonthUsd["Premium_LRS"] ?? 0;
      const diskCost = Number.isFinite(diskGb) ? diskGb * diskRate : 0;
      return Number((hourly * HOURS_PER_MONTH + diskCost).toFixed(2));
    }
    if (typeId === "azure-aks-cluster") {
      const sizeId = fields["nodeSize"] ?? "";
      const hourly = rates.vmHourlyUsd[sizeId];
      if (hourly == null) return null;
      const nodeCount = Math.max(1, Number(fields["nodeCount"] ?? "3"));
      const diskRate = rates.diskGbMonthUsd["Premium_LRS"] ?? 0;
      const perNodeDisk = 128 * diskRate;
      return Number(((hourly * HOURS_PER_MONTH + perNodeDisk) * nodeCount).toFixed(2));
    }
    if (typeId === "azure-container-instance") {
      if (!rates.containerInstance) return null;
      const cpu = Number(fields["cpu"] ?? "1");
      const memoryGb = Number(fields["memoryGb"] ?? "1.5");
      const secondsPerMonth = HOURS_PER_MONTH * 3600;
      const monthly =
        cpu * rates.containerInstance.vcpuPerSecondUsd * secondsPerMonth +
        memoryGb * rates.containerInstance.memoryGbPerSecondUsd * secondsPerMonth;
      if (!Number.isFinite(monthly) || monthly <= 0) return null;
      return Number(monthly.toFixed(2));
    }
    if (typeId === "azure-redis-cache") {
      const capacity = fields["capacity"] ?? "C1";
      return rates.redisMonthlyUsd[capacity] ?? null;
    }
    if (typeId === "azure-app-service") {
      const sku = fields["sku"] ?? "B1";
      return rates.appServiceMonthlyUsd[sku] ?? null;
    }
    if (typeId === "azure-function-app") {
      const sku = fields["sku"] ?? "Y1";
      return rates.functionAppMonthlyUsd[sku] ?? null;
    }
    if (typeId === "azure-sql-database") {
      const sku = fields["sku"] ?? "Basic";
      return rates.sqlDbMonthlyUsd[sku] ?? null;
    }
    if (typeId === "azure-disk") {
      const diskSizeGb = Number(fields["diskSizeGb"] ?? "128");
      const sku = fields["sku"] ?? "Premium_LRS";
      const perGb = rates.diskGbMonthUsd[sku];
      if (perGb == null || !Number.isFinite(diskSizeGb) || diskSizeGb <= 0) return null;
      return Number((diskSizeGb * perGb).toFixed(2));
    }
    return null;
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "azure-app-registration") {
      return {
        fields: [
          {
            key: "displayName",
            label: "Display Name",
            kind: "text",
            required: true,
            description: "Shown in the Entra ID portal. 1–120 chars.",
          },
        ],
      };
    }
    if (typeId === "azure-vm") {
      return getVMCreateConfig(this.createCtx);
    }
    if (typeId === "azure-aks-cluster") {
      return getAKSCreateConfig(this.createCtx);
    }
    if (typeId === "azure-storage-account") {
      return getStorageAccountCreateConfig(this.createCtx);
    }
    if (typeId === "azure-cosmos-db") {
      return getCosmosDBCreateConfig(this.createCtx);
    }
    if (typeId === "azure-redis-cache") {
      return getRedisCacheCreateConfig(this.createCtx);
    }
    if (typeId === "azure-postgres-flexible") {
      return getFlexibleDBCreateConfig(this.createCtx, "PostgreSQL", ["16", "15", "14", "13"]);
    }
    if (typeId === "azure-mysql-flexible") {
      return getFlexibleDBCreateConfig(this.createCtx, "MySQL", ["8.0.21", "5.7"]);
    }
    if (typeId === "azure-log-analytics") {
      return getLogAnalyticsCreateConfig(this.createCtx);
    }
    if (typeId === "azure-managed-identity") {
      return getSimpleCreateConfig(
        this.createCtx,
        "Managed Identity Name",
        "Name for the user-assigned managed identity",
        "azure-managed-identity",
      );
    }
    if (typeId === "azure-dns-zone") {
      return getSimpleCreateConfig(
        this.createCtx,
        "DNS Zone Name",
        "DNS zone name (e.g. example.com)",
        "azure-dns-zone",
      );
    }
    if (typeId === "azure-vnet") {
      return getVNetCreateConfig(this.createCtx);
    }
    if (typeId === "azure-nsg") {
      return getSimpleCreateConfig(this.createCtx, "NSG Name", "e.g. my-nsg", "azure-nsg");
    }
    if (typeId === "azure-key-vault") {
      return getKeyVaultCreateConfig(this.createCtx);
    }
    if (typeId === "azure-container-registry") {
      return getContainerRegistryCreateConfig(this.createCtx);
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
      return getContainerInstanceCreateConfig(this.createCtx);
    }
    if (typeId === "azure-service-bus") {
      return getMessagingNamespaceCreateConfig(this.createCtx, "Service Bus Namespace");
    }
    if (typeId === "azure-event-hub") {
      return getMessagingNamespaceCreateConfig(this.createCtx, "Event Hub Namespace");
    }
    if (typeId === "azure-public-ip") {
      return getPublicIPCreateConfig(this.createCtx);
    }
    if (typeId === "azure-disk") {
      return getDiskCreateConfig(this.createCtx);
    }
    if (typeId === "azure-app-service") {
      return getAppServiceCreateConfig(this.createCtx);
    }
    if (typeId === "azure-function-app") {
      return getFunctionAppCreateConfig(this.createCtx);
    }
    if (typeId === "azure-sql-database") {
      return getSQLDatabaseCreateConfig(this.createCtx);
    }
    if (typeId === "azure-load-balancer") {
      return getLoadBalancerCreateConfig(this.createCtx);
    }
    throw new Error(`Azure plugin: create not supported for type "${typeId}"`);
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "azure-disk" && targetTypeId === "azure-vm") {
      const [disk, vm] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const diskLocation = String(disk.fields["location"] ?? "");
      const vmLocation = String(vm.fields["location"] ?? "");
      if (diskLocation && vmLocation && diskLocation !== vmLocation) {
        throw new Error(
          `Disk location ${diskLocation} does not match VM location ${vmLocation} — Azure managed disks must be in the same region as the VM.`,
        );
      }
      const vmRg = String(vm.fields["resourceGroup"] ?? "");
      const vmName = String(vm.fields["name"] ?? "");
      const diskRg = String(disk.fields["resourceGroup"] ?? "");
      const diskName = String(disk.fields["name"] ?? "");
      if (!vmRg || !vmName || !diskRg || !diskName) {
        throw new Error("Cannot determine VM or disk identity for attachment");
      }
      const diskResourceId = `/subscriptions/${this.creds.subscriptionId}/resourceGroups/${diskRg}/providers/Microsoft.Compute/disks/${diskName}`;
      // Fetch VM to read existing data disks, then PATCH to append the new one
      const vmUrl = `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${vmRg}/providers/Microsoft.Compute/virtualMachines/${vmName}?api-version=2024-03-01`;
      const current = await this.get<Record<string, unknown>>(vmUrl);
      const props = (current["properties"] ?? {}) as Record<string, unknown>;
      const storage = (props["storageProfile"] ?? {}) as Record<string, unknown>;
      const existing = Array.isArray(storage["dataDisks"])
        ? (storage["dataDisks"] as Array<Record<string, unknown>>)
        : [];
      const usedLuns = new Set(existing.map((d) => Number(d["lun"] ?? 0)));
      let lun = 0;
      while (usedLuns.has(lun)) lun++;
      const updated = [
        ...existing,
        {
          lun,
          name: diskName,
          createOption: "Attach",
          managedDisk: { id: diskResourceId },
        },
      ];
      await this.patch(vmUrl, { properties: { storageProfile: { dataDisks: updated } } });
      return;
    }
    if (sourceTypeId === "azure-nsg" && targetTypeId === "azure-vm") {
      const [nsg, vm] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const nsgRg = String(nsg.fields["resourceGroup"] ?? "");
      const nsgName = String(nsg.fields["name"] ?? "");
      const nsgLocation = String(nsg.fields["location"] ?? "");
      const vmRg = String(vm.fields["resourceGroup"] ?? "");
      const vmName = String(vm.fields["name"] ?? "");
      const vmLocation = String(vm.fields["location"] ?? "");
      if (!nsgRg || !nsgName || !vmRg || !vmName) {
        throw new Error("Cannot determine NSG or VM identity for attachment");
      }
      if (nsgLocation && vmLocation && nsgLocation !== vmLocation) {
        throw new Error(
          `NSG region ${nsgLocation} does not match VM region ${vmLocation} — Azure NSGs must be in the same region as the NIC.`,
        );
      }
      const nsgId = `/subscriptions/${this.creds.subscriptionId}/resourceGroups/${nsgRg}/providers/Microsoft.Network/networkSecurityGroups/${nsgName}`;
      // Fetch the VM to find its primary NIC reference.
      const vmUrl = `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${vmRg}/providers/Microsoft.Compute/virtualMachines/${vmName}?api-version=2024-03-01`;
      const vmData = await this.get<Record<string, unknown>>(vmUrl);
      const props = (vmData["properties"] ?? {}) as Record<string, unknown>;
      const netProfile = (props["networkProfile"] ?? {}) as Record<string, unknown>;
      const nics = Array.isArray(netProfile["networkInterfaces"])
        ? (netProfile["networkInterfaces"] as Array<Record<string, unknown>>)
        : [];
      if (nics.length === 0) throw new Error("VM has no network interfaces");
      const primaryNic =
        nics.find((n) => (n["properties"] as Record<string, unknown> | undefined)?.["primary"]) ??
        nics[0];
      const nicArmId = String(primaryNic?.["id"] ?? "");
      if (!nicArmId) throw new Error("Cannot determine primary NIC of VM");
      // Fetch the NIC and PATCH with the NSG reference.
      const nicUrl = `${ARM}${nicArmId}?api-version=2023-09-01`;
      const nicData = await this.get<Record<string, unknown>>(nicUrl);
      const nicProps = (nicData["properties"] ?? {}) as Record<string, unknown>;
      await this.patch(nicUrl, {
        properties: { ...nicProps, networkSecurityGroup: { id: nsgId } },
      });
      return;
    }
    throw new Error(
      `Azure plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    if (typeId === "azure-app-registration") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const objectId = String(resource.externalId ?? resource.fields["objectId"] ?? "");
      if (!objectId) throw new Error("Cannot determine app registration object id");
      await this.graphRequest("DELETE", `/applications/${objectId}`);
      return;
    }
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

  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId === "azure-storage-account") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const [rg, name] = (resource.externalId ?? "").split("/");
      if (!rg || !name) throw new Error("Cannot determine storage account name / resource group");
      const keysResp = await this.post<{
        keys?: Array<{ keyName: string; value: string; permissions?: string }>;
      }>(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}/listKeys?api-version=2023-01-01`,
        {},
      );
      const keys = keysResp.keys ?? [];
      const key1 = keys.find((k) => k.keyName === "key1")?.value ?? keys[0]?.value ?? "";
      const key2 = keys.find((k) => k.keyName === "key2")?.value ?? keys[1]?.value ?? "";
      if (!key1) throw new Error("Azure returned no storage account keys");
      const connStr = `DefaultEndpointsProtocol=https;AccountName=${name};AccountKey=${key1};EndpointSuffix=core.windows.net`;
      if (formatId === "connection-string") {
        return {
          content: connStr,
          filename: `${name}.connection-string`,
          mimeType: "text/plain",
          fields: [
            { label: "Account Name", value: name },
            { label: "Connection String", value: connStr, sensitive: true },
          ],
          warning:
            "Contains the primary account key. Anyone with this string has full access to the storage account. Rotate by regenerating the key.",
        };
      }
      if (formatId === "access-keys") {
        const ini = `[${name}]\nprimary_key=${key1}\n${key2 ? `secondary_key=${key2}\n` : ""}`;
        return {
          content: ini,
          filename: `${name}.keys`,
          mimeType: "text/plain",
          fields: [
            { label: "Account Name", value: name },
            {
              label: "Primary Key (key1)",
              value: key1,
              sensitive: true,
              hint: "Full account access",
            },
            ...(key2
              ? [{ label: "Secondary Key (key2)", value: key2, sensitive: true as const }]
              : []),
          ],
          warning:
            "Both keys are full-access. Rotate one at a time: regenerate key1 while apps use key2, then swap.",
        };
      }
    }
    if (typeId === "azure-app-registration" && formatId === "client-secret") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const objectId = String(resource.externalId ?? resource.fields["objectId"] ?? "");
      const appId = String(resource.fields["appId"] ?? "");
      const displayName = String(resource.displayName ?? resource.fields["displayName"] ?? "");
      if (!objectId || !appId) {
        throw new Error("Cannot determine app registration object id / appId");
      }
      // Default two-year expiry, Graph-side default.
      const secretDisplayName = `infrawrench-${new Date().toISOString().slice(0, 10)}`;
      const pw = await this.graphRequest<{
        secretText?: string;
        keyId?: string;
        displayName?: string;
        endDateTime?: string;
      }>("POST", `/applications/${objectId}/addPassword`, {
        passwordCredential: { displayName: secretDisplayName },
      });
      const secretText = pw.secretText ?? "";
      const keyId = pw.keyId ?? "";
      if (!secretText) throw new Error("Graph returned an empty secretText");
      const envFile =
        `# Azure service principal: ${displayName}\n` +
        `AZURE_TENANT_ID=${this.creds.tenantId}\n` +
        `AZURE_CLIENT_ID=${appId}\n` +
        `AZURE_CLIENT_SECRET=${secretText}\n`;
      return {
        content: envFile,
        filename: `${displayName || appId}.env`,
        mimeType: "text/plain",
        fields: [
          { label: "Tenant ID", value: this.creds.tenantId },
          { label: "Client ID (appId)", value: appId },
          {
            label: "Client Secret",
            value: secretText,
            sensitive: true,
            hint: "Only shown once",
          },
          ...(keyId ? [{ label: "Key ID", value: keyId }] : []),
          ...(pw.endDateTime ? [{ label: "Expires", value: pw.endDateTime }] : []),
        ],
        warning:
          "Save now. Microsoft Graph does not return this secret again — if lost, delete the credential (removePassword) and create a new one. Default expiry is 2 years.",
      };
    }

    throw new Error(
      `Azure plugin: exportCredential not supported for type "${typeId}" / format "${formatId}"`,
    );
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
