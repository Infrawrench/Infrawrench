/**
 * Azure plugin client facade.
 *
 * This class is intentionally thin — it owns the long-lived per-account state
 * (credentials, token caches, pricing rate cache) and the low-level
 * AAD-authenticated HTTP helpers, and delegates everything else to the
 * co-located per-service modules:
 *
 *   - storage-client.ts            blob storage operations
 *   - container-registry-client.ts ACR artifact listing
 *   - app-registration.ts          Graph-based app registration listing
 *   - output-resolver.ts           resolveOutput per type
 *   - dashboard-stats.ts           fetchDashboardStats per type
 *   - renderers.ts                 renderDetail / renderSidebarItem
 *   - delete-handlers.ts           deleteResource
 *   - attach-handlers.ts           attachResource (disk/nsg → vm)
 *   - manifest.ts                  get/applyManifest
 *   - export-credential.ts         exportCredential
 *   - create-config-dispatch.ts    getCreateConfig dispatch
 *   - pricing-estimates.ts         per-type cost estimation
 *   - resource-listers.ts          listResources per type
 *   - create-handlers.ts           per-type create flows
 *   - shared.ts                    common types/constants
 */
import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceTypeDefinition,
  StorageObject,
  ArtifactEntry,
  CreateResourceConfig,
  CreateSizePricingRequest,
  DashboardStat,
  CredentialExport,
} from "@infrawrench/plugin-base";
import {
  fetchAccessToken,
  fetchGraphAccessToken,
  fetchStorageAccessToken,
  type AzureCredentials,
} from "./auth.js";
import type { ListerContext } from "./resource-listers.js";
import * as listers from "./resource-listers.js";
import {
  fetchAzurePricingRates,
  type AzurePricingRates,
  type AzurePricingCacheEntry,
} from "./pricing.js";
import { type AzureCreateContext } from "./create-handlers.js";
import { type AzureHttpContext } from "./shared.js";
import {
  deleteStorageObject,
  listStorageObjects,
  makeStorageFolder,
  uploadStorageObject,
} from "./storage-client.js";
import { listAcrArtifacts } from "./container-registry-client.js";
import { listAppRegistrations } from "./app-registration.js";
import { makeGraphClient } from "./graph-client.js";
import { resolveAzureOutput } from "./output-resolver.js";
import { buildAzureDashboardStats } from "./dashboard-stats.js";
import { renderAzureDetail, renderAzureSidebarItem } from "./renderers.js";
import { deleteAzureResource } from "./delete-handlers.js";
import { attachAzureResource } from "./attach-handlers.js";
import { applyAzureManifest, getAzureManifest } from "./manifest.js";
import { exportAzureCredential } from "./export-credential.js";
import { getAzureCreateConfig } from "./create-config-dispatch.js";
import {
  azureSupportsSizePricing,
  getAzureCreateCostEstimate,
  getAzureCreateSizePricing,
} from "./pricing-estimates.js";

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

  // ─── Token caches ──────────────────────────────────────────────────────

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

  // ─── Pricing rate cache (shared across estimate calls) ─────────────────

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

  // ─── Low-level HTTP helpers ────────────────────────────────────────────

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

  /**
   * Microsoft Graph SDK client — defers token acquisition to `graphToken()`,
   * which already caches/refreshes via `fetchGraphAccessToken`. We mint a
   * fresh `Client` each access (the SDK is stateless aside from the auth
   * provider, so this matches the lifecycle of the previous helper).
   */
  private get graphClient() {
    return makeGraphClient({ graphToken: () => this.graphToken() });
  }

  // ─── Context builders ──────────────────────────────────────────────────

  private makeId(accountId: string, typeId: string, externalId: string): string {
    return `${accountId}:${typeId}:${externalId}`;
  }

  private get httpCtx(): AzureHttpContext {
    return {
      get: <T>(url: string) => this.get<T>(url),
      post: <T>(url: string, body: unknown) => this.post<T>(url, body),
      put: <T>(url: string, body: unknown) => this.put<T>(url, body),
      patch: <T>(url: string, body: unknown) => this.patch<T>(url, body),
      del: (url: string) => this.del(url),
      subscriptionId: this.creds.subscriptionId,
      tenantId: this.creds.tenantId,
    };
  }

  private get listerCtx(): ListerContext {
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
      graphClient: this.graphClient,
      subscriptionId: this.creds.subscriptionId,
      tenantId: this.creds.tenantId,
      clientId: this.creds.clientId,
      clientSecret: this.creds.clientSecret,
    };
  }

  // ─── Lister dispatch ───────────────────────────────────────────────────

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
      return listAppRegistrations(
        {
          graphClient: this.graphClient,
          makeId: (a, t, e) => this.makeId(a, t, e),
          now: () => new Date().toISOString(),
          tenantId: this.creds.tenantId,
        },
        accountId,
      );
    }
    const lister = AzureClient.LISTERS[typeId];
    if (!lister) throw new Error(`Azure plugin: unknown resource type "${typeId}"`);
    return lister(this.listerCtx, accountId);
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

  // ─── Delegations ───────────────────────────────────────────────────────

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    return resolveAzureOutput(
      {
        ctx: this.httpCtx,
        getResource: (t, r, a) => this.getResource(t, r, a),
        exportAppRegistrationSecret: async (t, r, a) => {
          const exp = await this.exportCredential(t, r, a, "client-secret");
          return exp.content;
        },
      },
      typeId,
      resourceId,
      outputKey,
      accountId,
    );
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    return buildAzureDashboardStats(resource);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderAzureDetail(resource, this.resourceTypes);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderAzureSidebarItem(resource);
  }

  // ─── Storage ──────────────────────────────────────────────────────────

  listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    return listStorageObjects({ storageToken: () => this.storageToken() }, bucket, prefix);
  }

  uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    return uploadStorageObject({ storageToken: () => this.storageToken() }, bucket, key, file);
  }

  makeStorageFolder(bucket: string, key: string): Promise<void> {
    return makeStorageFolder({ storageToken: () => this.storageToken() }, bucket, key);
  }

  deleteStorageObject(bucket: string, key: string): Promise<void> {
    return deleteStorageObject({ storageToken: () => this.storageToken() }, bucket, key);
  }

  getStorageAccessToken(): Promise<string> {
    return this.storageToken();
  }

  // ─── Container Registry / artifacts ───────────────────────────────────

  listArtifacts(
    typeId: string,
    resourceId: string,
    accountId: string,
    params?: { pageToken?: string; prefix?: string },
  ): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> {
    return listAcrArtifacts(this.httpCtx, this.creds, typeId, resourceId, accountId, params);
  }

  // ─── Pricing ──────────────────────────────────────────────────────────

  async getCreateSizePricing(
    typeId: string,
    request: CreateSizePricingRequest,
  ): Promise<Record<string, number>> {
    if (!azureSupportsSizePricing(typeId)) return {};
    const region = request.regionId ?? "eastus";
    const rates = await this.getPricingRatesForRegion(region);
    return getAzureCreateSizePricing(rates, request);
  }

  async getCreateCostEstimate(
    typeId: string,
    fields: Record<string, string>,
  ): Promise<number | null> {
    const region = fields["region"] ?? "eastus";
    const rates = await this.getPricingRatesForRegion(region);
    return getAzureCreateCostEstimate(typeId, fields, rates);
  }

  // ─── Create / attach / delete / manifest / export ─────────────────────

  getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    return getAzureCreateConfig(this.createCtx, typeId);
  }

  attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    return attachAzureResource(
      { ...this.httpCtx, getResource: (t, r, a) => this.getResource(t, r, a) },
      sourceTypeId,
      sourceResourceId,
      targetTypeId,
      targetResourceId,
      accountId,
    );
  }

  deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    return deleteAzureResource(
      {
        ...this.httpCtx,
        getResource: (t, r, a) => this.getResource(t, r, a),
        graphClient: this.graphClient,
      },
      typeId,
      resourceId,
      accountId,
    );
  }

  exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    return exportAzureCredential(
      {
        ...this.httpCtx,
        getResource: (t, r, a) => this.getResource(t, r, a),
        graphClient: this.graphClient,
        creds: this.creds,
      },
      typeId,
      resourceId,
      accountId,
      formatId,
    );
  }

  getManifest(resourceId: string, _accountId: string): Promise<string> {
    return getAzureManifest(this.httpCtx, resourceId);
  }

  applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    return applyAzureManifest(this.httpCtx, resourceId, manifest);
  }
}
