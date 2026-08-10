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
 *   - create-dispatch.ts           createResource dispatch
 *   - pricing-estimates.ts         per-type cost estimation
 *   - resource-listers.ts          listResources per type
 *   - create-handlers.ts           per-type create flows
 *   - shared.ts                    common types/constants
 */
import type {
  CommitmentRecord,
  CostEstimate,
  CostFetchRange,
  CostFetchResult,
  HostServices,
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
  MetricSeries,
  PublishMessagePayload,
  PublishMessageResult,
} from "@infrawrench/plugin-base";
import {
  fetchAccessToken,
  fetchGraphAccessToken,
  fetchServiceBusAccessToken,
  fetchStorageAccessToken,
  type AzureCredentials,
} from "./auth.js";
import { publishServiceBus, publishEventHub } from "./publish-handlers.js";
import type { ListerContext } from "./resource-listers.js";
import * as listers from "./resource-listers.js";
import {
  fetchAzurePricingRates,
  type AzurePricingRates,
  type AzurePricingCacheEntry,
} from "./pricing.js";
import { type AzureCreateContext } from "./create-handlers.js";
import { ARM, type AzureHttpContext } from "./shared.js";
import { azureRequest } from "./http.js";
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
import { fetchAzureMetricSeries } from "./metrics.js";
import { renderAzureDetail, renderAzureSidebarItem } from "./renderers.js";
import { fetchAzureCostData } from "./cost-data.js";
import { fetchAzureCommitments } from "./commitments.js";
import { deleteAzureResource } from "./delete-handlers.js";
import { attachAzureResource } from "./attach-handlers.js";
import { applyAzureManifest, getAzureManifest } from "./manifest.js";
import { exportAzureCredential } from "./export-credential.js";
import { getAzureCreateConfig } from "./create-config-dispatch.js";
import { createAzureResource } from "./create-dispatch.js";
import {
  azureSupportsSizePricing,
  estimateAzureCost,
  getAzureCreateSizePricing,
} from "./pricing-estimates.js";

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class AzureClient implements PluginClient {
  private readonly creds: AzureCredentials;
  private readonly resourceTypes: ResourceTypeDefinition[];
  /**
   * Host services, when the host provides them. Every Azure request this
   * client makes — ARM, the AAD token endpoint, Blob Storage, ACR, the
   * Service Bus / Event Hubs data plane, Retail Prices — goes through
   * `services.http` when it is present, which is what makes per-account
   * bastion routing and custom CA trust reach Azure. See `http.ts`. The one
   * exception is Microsoft Graph, which the vendor SDK transports itself.
   */
  private readonly services: HostServices | undefined;
  private tokenCache: TokenCache | null = null;
  private storageTokenCache: TokenCache | null = null;
  private graphTokenCache: TokenCache | null = null;
  private serviceBusTokenCache: TokenCache | null = null;
  private pricingRateCache = new Map<string, AzurePricingCacheEntry>();
  private pricingRateInFlight = new Map<string, Promise<AzurePricingRates>>();

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[] = [],
    services?: HostServices,
  ) {
    this.resourceTypes = resourceTypes;
    this.services = services;
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
    const t = await fetchAccessToken(this.creds, this.http);
    this.tokenCache = { token: t, expiresAt: now + 3_600_000 };
    return t;
  }

  private async storageToken(): Promise<string> {
    const now = Date.now();
    if (this.storageTokenCache && this.storageTokenCache.expiresAt > now + 60_000) {
      return this.storageTokenCache.token;
    }
    const t = await fetchStorageAccessToken(this.creds, this.http);
    this.storageTokenCache = { token: t, expiresAt: now + 3_600_000 };
    return t;
  }

  /** Service Bus / Event Hubs data-plane token — separate audience from ARM. */
  private async serviceBusToken(): Promise<string> {
    const now = Date.now();
    if (this.serviceBusTokenCache && this.serviceBusTokenCache.expiresAt > now + 60_000) {
      return this.serviceBusTokenCache.token;
    }
    const t = await fetchServiceBusAccessToken(this.creds, this.http);
    this.serviceBusTokenCache = { token: t, expiresAt: now + 3_600_000 };
    return t;
  }

  /** Microsoft Graph access token — separate audience from ARM. */
  private async graphToken(): Promise<string> {
    const now = Date.now();
    if (this.graphTokenCache && this.graphTokenCache.expiresAt > now + 60_000) {
      return this.graphTokenCache.token;
    }
    const t = await fetchGraphAccessToken(this.creds, this.http);
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
      const rates = await fetchAzurePricingRates(region, this.http);
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

  /** Host HTTP service when the host supplied one; `undefined` → direct fetch. */
  private get http() {
    return this.services?.http;
  }

  private async get<T>(url: string): Promise<T> {
    const tok = await this.token();
    const res = await azureRequest(this.http, url, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`Azure API ${res.status}: ${await res.text()}`);
    return res.json<T>();
  }

  /** POST/PUT/PATCH differ only in the verb and the word in the error text. */
  private async write<T>(method: "POST" | "PUT" | "PATCH", url: string, body: unknown): Promise<T> {
    const tok = await this.token();
    const res = await azureRequest(this.http, url, {
      method,
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Azure API ${method} ${res.status}: ${await res.text()}`);
    // ARM answers a good few writes with an empty body (204, or 200 with no
    // content) — those are successes with nothing to parse.
    if (res.status === 204 || res.headers.get("content-length") === "0") return {} as T;
    return res.json<T>();
  }

  private post<T>(url: string, body: unknown): Promise<T> {
    return this.write<T>("POST", url, body);
  }

  private put<T>(url: string, body: unknown): Promise<T> {
    return this.write<T>("PUT", url, body);
  }

  private patch<T>(url: string, body: unknown): Promise<T> {
    return this.write<T>("PATCH", url, body);
  }

  private async del(url: string): Promise<void> {
    const tok = await this.token();
    const res = await azureRequest(this.http, url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    // 202 is ARM's "accepted, deleting asynchronously" and 204 its "already
    // gone" — both are the outcome the caller asked for.
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
      http: this.http,
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
      http: this.http,
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
    "azure-subnet": listers.listSubnets,
    "azure-route-table": listers.listRouteTables,
    "azure-nat-gateway": listers.listNatGateways,
    "azure-aks-cluster": listers.listAKSClusters,
    "azure-sql-database": listers.listSQLDatabases,
    "azure-cosmos-db": listers.listCosmosDBAccounts,
    "azure-storage-account": listers.listStorageAccounts,
    "azure-function-app": listers.listFunctionApps,
    "azure-app-service": listers.listAppServices,
    "azure-app-service-plan": listers.listAppServicePlans,
    "azure-container-instance": listers.listContainerInstances,
    "azure-key-vault": listers.listKeyVaults,
    "azure-redis-cache": listers.listRedisCaches,
    "azure-service-bus": listers.listServiceBusNamespaces,
    "azure-container-registry": listers.listContainerRegistries,
    "azure-load-balancer": listers.listLoadBalancers,
    "azure-dns-zone": listers.listDNSZones,
    "azure-private-dns-zone": listers.listPrivateDNSZones,
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

  /**
   * Pay-as-you-go hourly price of an AKS cluster's node VM size, handed to the
   * Kubernetes peer so it can derive per-namespace and per-workload cost.
   *
   * Retail list price, not a billed amount — reservations and Spot move the
   * real number — so the payload is marked `list-price`. Never throws: the
   * host resolves every credentialMapping before building the peer client.
   *
   * Shape is the JSON that `kubernetes/src/node-rates.ts` parses.
   */
  private async aksNodeHourlyRates(resourceId: string, accountId: string): Promise<string> {
    const cluster = await this.getResource("azure-aks-cluster", resourceId, accountId);
    const vmSize = String(cluster.fields["vmSize"] ?? "").trim();
    const location = String(cluster.fields["location"] ?? "").trim();
    if (!vmSize || !location) return "";

    const rates = await this.getPricingRatesForRegion(location);
    const hourly = rates.vmHourlyUsd[vmSize];
    if (hourly == null || !(hourly > 0)) return "";

    return JSON.stringify({
      currency: "USD",
      source: "list-price",
      byInstanceType: { [vmSize]: hourly },
      byNodeName: {},
    });
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (outputKey === "nodeHourlyRates") {
      if (typeId !== "azure-aks-cluster") return "";
      return this.aksNodeHourlyRates(resourceId, accountId).catch(() => "");
    }
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

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    return fetchAzureMetricSeries(this.httpCtx, resourceTypeId, resource, timeRange);
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostFetchResult> {
    return fetchAzureCostData(this.httpCtx, range);
  }

  async fetchCommitments(_accountId: string): Promise<CommitmentRecord[]> {
    // `get` is itself host-routed now, so commitments no longer need their own
    // copy of the host-HTTP shim.
    return fetchAzureCommitments({ getJson: <T>(url: string) => this.get<T>(url) });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderAzureDetail(resource, this.resourceTypes);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderAzureSidebarItem(resource);
  }

  // ─── Storage ──────────────────────────────────────────────────────────

  private get storageCtx() {
    return { storageToken: () => this.storageToken(), http: this.http };
  }

  listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    return listStorageObjects(this.storageCtx, bucket, prefix);
  }

  uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    return uploadStorageObject(this.storageCtx, bucket, key, file);
  }

  makeStorageFolder(bucket: string, key: string): Promise<void> {
    return makeStorageFolder(this.storageCtx, bucket, key);
  }

  deleteStorageObject(bucket: string, key: string): Promise<void> {
    return deleteStorageObject(this.storageCtx, bucket, key);
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

  /**
   * Monthly estimate with line items, priced from the region's Retail Prices
   * rates. `location` is the lister's spelling of the form's `region`, so the
   * same call prices an existing resource from its stored fields.
   */
  async estimateCost(typeId: string, fields: Record<string, string>): Promise<CostEstimate | null> {
    const region = fields["region"] || fields["location"] || "eastus";
    const rates = await this.getPricingRatesForRegion(region);
    return estimateAzureCost(typeId, fields, rates);
  }

  // ─── Create / attach / delete / manifest / export ─────────────────────

  getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    return getAzureCreateConfig(this.createCtx, typeId);
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    return createAzureResource(this.createCtx, typeId, accountId, fields);
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

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "azure-vm" && (actionId === "start" || actionId === "deallocate")) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      // externalId is rg/name — the same two-part form deleteResource splits.
      const [rg, name] = String(resource.externalId ?? "").split("/");
      if (!rg || !name) throw new Error("Cannot determine resource group/name for VM");
      await this.post(
        `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${name}/${actionId}?api-version=2024-03-01`,
        {},
      );
      return;
    }
    throw new Error(`Azure plugin: invokeAction "${actionId}" not supported for type "${typeId}"`);
  }

  /**
   * Edit a VM: change its size (`vmSize`) — the right-sizing apply path.
   * ARM PATCH on `hardwareProfile.vmSize`; Azure accepts it on a running VM
   * but restarts it during the change, and rejects sizes unavailable on the
   * current hardware cluster (deallocate first to widen the choice). VM
   * names are immutable in Azure, so nothing else is editable.
   */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "azure-vm") {
      throw new Error(`Azure plugin: updateResource not supported for type "${typeId}"`);
    }
    const vmSize = fields["vmSize"];
    if (!vmSize) throw new Error("Azure plugin: vmSize is the only editable VM field");
    const resource = await this.getResource(typeId, resourceId, accountId);
    // externalId is rg/name — the same two-part form deleteResource splits.
    const [rg, name] = String(resource.externalId ?? "").split("/");
    if (!rg || !name) throw new Error("Cannot determine resource group/name for VM");
    await this.patch(
      `${ARM}/subscriptions/${this.creds.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${name}?api-version=2024-03-01`,
      { properties: { hardwareProfile: { vmSize } } },
    );
    return this.getResource(typeId, resourceId, accountId);
  }

  async publishMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    payload: PublishMessagePayload,
  ): Promise<PublishMessageResult> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const ctx = { serviceBusToken: () => this.serviceBusToken(), http: this.http };
    if (typeId === "azure-service-bus") return publishServiceBus(ctx, resource, payload);
    if (typeId === "azure-event-hub") return publishEventHub(ctx, resource, payload);
    throw new Error(`Azure plugin: publishMessage not supported for type "${typeId}"`);
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
