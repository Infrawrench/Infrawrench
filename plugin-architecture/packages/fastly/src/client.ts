import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  KvListResult,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { FastlyContext } from "./api.js";
import {
  fastlyCursorPaged,
  fastlyFetch,
  fastlyJsonApiPaged,
  fastlyPaged,
  fastlyRaw,
  mapLimit,
  statusOf,
} from "./api.js";
import { fetchFastlyBillingSummary, fetchFastlyCostData } from "./cost-data.js";
import type { FastlyLoggingEndpoint } from "./logging.js";
import { LOGGING_TYPES } from "./logging.js";
import type {
  FastlyDictionary,
  FastlyServiceDetail,
  FastlyServiceSummary,
  FastlyStore,
  FastlyToken,
  JsonApiResource,
  TlsCertificateAttrs,
  TlsSubscriptionAttrs,
} from "./mappers.js";
import {
  liveVersionOf,
  mapBackend,
  mapDictionary,
  mapDomain,
  mapLoggingEndpoint,
  mapService,
  mapStore,
  mapTlsCertificate,
  mapTlsSubscription,
  mapToken,
  mapVersion,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  aggregateStats,
  rangeOrDefault,
  realtimeSnapshot,
  serviceSeriesFrom,
  serviceStats,
  totalsOf,
} from "./metrics.js";
import { verifyFastlyCredentials } from "./preflight.js";
import { enabledProductsByService, setProductEnabled } from "./products.js";
import {
  BILLING_KEY,
  REALTIME_KEY,
  STORE_SERVICES_KEY,
  TOTALS_KEY,
  VERSIONS_KEY,
  renderFastlyDetail,
  renderFastlySidebar,
} from "./render.js";

const SERVICE_PAGE = 100;
/** Concurrent requests per fan-out; Fastly allows 6,000 reads a minute. */
const FAN_OUT = 6;
/** One sync pass lists several child types from the same service details. */
const CACHE_TTL_MS = 60_000;

const SERVICE_ACTIONS = new Set(["purge-all", "clone-active", "deactivate"]);
const VERSION_ACTIONS = new Set(["activate", "deactivate", "clone", "lock", "validate"]);

interface CurrentCustomer {
  id?: string;
  name?: string;
  pricing_plan?: string;
}
interface CurrentUser {
  login?: string;
  role?: string;
  customer_id?: string;
}

/** `{serviceId}/{rest}` external ids of service children. */
function splitChild(externalId: string): [string, string] {
  const i = externalId.indexOf("/");
  return i < 0 ? [externalId, ""] : [externalId.slice(0, i), externalId.slice(i + 1)];
}

/**
 * `https://www.example.com/a?b` → `www.example.com/a?b`: the purge endpoint
 * takes the cached URL without its scheme as the path.
 */
export function purgePathFor(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter the URL to purge.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${trimmed}" is not a URL.`);
  }
  return `${url.host}${url.pathname}${url.search}`;
}

export function parseKeys(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
}

export class FastlyClient implements PluginClient {
  private readonly ctx: FastlyContext;
  private servicesCache: { at: number; value: Promise<FastlyServiceDetail[]> } | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("Fastly plugin: missing apiToken credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  /** Exposed for tests. */
  get context(): FastlyContext {
    return this.ctx;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * A 403 on one list means the token (or its owner's role, or a token limited
   * to some services) cannot read that kind of object; the rest of the account
   * still works, so that type lists empty rather than failing the sync.
   */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  /** Every service with its details (versions, active version's domains and backends). */
  private services(): Promise<FastlyServiceDetail[]> {
    const now = Date.now();
    if (this.servicesCache && now - this.servicesCache.at < CACHE_TTL_MS) {
      return this.servicesCache.value;
    }
    const value = (async () => {
      const list = await fastlyPaged<FastlyServiceSummary>(
        this.ctx,
        "/service",
        { sort: "name", direction: "ascend" },
        SERVICE_PAGE,
      );
      return mapLimit(list, FAN_OUT, async (svc) => {
        if (!svc.id) return svc as FastlyServiceDetail;
        try {
          return await this.serviceDetail(svc.id);
        } catch (err) {
          // A token limited to other services sees the summary but not details.
          if (statusOf(err) === 403 || statusOf(err) === 404) return svc as FastlyServiceDetail;
          throw err;
        }
      });
    })();
    this.servicesCache = { at: now, value };
    value.catch(() => {
      if (this.servicesCache?.value === value) this.servicesCache = undefined;
    });
    return value;
  }

  private async serviceDetail(serviceId: string): Promise<FastlyServiceDetail> {
    return fastlyFetch<FastlyServiceDetail>(
      this.ctx,
      `/service/${encodeURIComponent(serviceId)}/details`,
    );
  }

  private invalidate(): void {
    this.servicesCache = undefined;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "account":
        return [await this.loadAccount(accountId)];
      case "service":
        return this.scoped(async () => {
          const [services, products] = await Promise.all([
            this.services(),
            enabledProductsByService(this.ctx).catch(() => new Map<string, string[]>()),
          ]);
          return services.map((s) => mapService(accountId, s, products.get(s.id ?? "") ?? []));
        });
      case "service-version":
        return this.scoped(async () =>
          (await this.services()).flatMap((s) =>
            (s.versions ?? []).map((v) => mapVersion(accountId, s, v)),
          ),
        );
      case "domain":
        return this.scoped(async () =>
          (await this.services()).flatMap((s) =>
            (this.liveDetail(s)?.domains ?? []).map((d) => mapDomain(accountId, s, d)),
          ),
        );
      case "backend":
        return this.scoped(async () =>
          (await this.services()).flatMap((s) =>
            (this.liveDetail(s)?.backends ?? []).map((b) => mapBackend(accountId, s, b)),
          ),
        );
      case "logging-endpoint":
        return this.scoped(() => this.listLogging(accountId));
      case "dictionary":
        return this.scoped(() => this.listDictionaries(accountId));
      case "kv-store":
        return this.scoped(async () =>
          (await fastlyCursorPaged<FastlyStore>(this.ctx, "/resources/stores/kv", {}, 1000)).map(
            (st) => mapStore(accountId, "kv-store", st),
          ),
        );
      case "config-store":
        return this.scoped(async () => {
          const stores =
            (await fastlyFetch<FastlyStore[]>(this.ctx, "/resources/stores/config")) ?? [];
          return mapLimit(stores, FAN_OUT, async (st) => {
            const info = await fastlyFetch<{ item_count?: number }>(
              this.ctx,
              `/resources/stores/config/${encodeURIComponent(st.id ?? "")}/info`,
            ).catch(() => undefined);
            return mapStore(accountId, "config-store", st, {
              ...(info?.item_count !== undefined ? { itemCount: info.item_count } : {}),
            });
          });
        });
      case "secret-store":
        return this.scoped(async () =>
          (await fastlyCursorPaged<FastlyStore>(this.ctx, "/resources/stores/secret", {}, 200)).map(
            (st) => mapStore(accountId, "secret-store", st),
          ),
        );
      case "tls-certificate":
        return this.scoped(async () => {
          const { data } = await fastlyJsonApiPaged<JsonApiResource<TlsCertificateAttrs>>(
            this.ctx,
            "/tls/certificates",
          );
          return data.map((c) => mapTlsCertificate(accountId, c));
        });
      case "tls-subscription":
        return this.scoped(async () => {
          const { data, included } = await fastlyJsonApiPaged<
            JsonApiResource<TlsSubscriptionAttrs>
          >(this.ctx, "/tls/subscriptions", { include: "tls_certificates" });
          const certs = new Map<string, TlsCertificateAttrs>();
          for (const inc of included as Array<JsonApiResource<TlsCertificateAttrs>>) {
            if (inc.type === "tls_certificate" && inc.id) certs.set(inc.id, inc.attributes ?? {});
          }
          return data.map((sub) => mapTlsSubscription(accountId, sub, certs));
        });
      case "api-token":
        return this.scoped(() => this.listTokens(accountId));
      default:
        throw new Error(`Fastly plugin: unknown resource type "${typeId}"`);
    }
  }

  /** The configuration actually serving traffic: the active version, else the newest. */
  private liveDetail(s: FastlyServiceDetail) {
    if (s.active_version) return s.active_version;
    return typeof s.version === "object" && s.version !== null ? s.version : undefined;
  }

  private async listLogging(accountId: string): Promise<ResourceInstance[]> {
    const services = await this.services();
    const jobs: Array<{ svc: FastlyServiceDetail; version: number; type: string }> = [];
    for (const svc of services) {
      const version = liveVersionOf(svc);
      if (!svc.id || !version) continue;
      for (const t of LOGGING_TYPES) jobs.push({ svc, version, type: t.id });
    }
    const results = await mapLimit(jobs, FAN_OUT * 2, async ({ svc, version, type }) => {
      try {
        const list =
          (await fastlyFetch<FastlyLoggingEndpoint[]>(
            this.ctx,
            `/service/${encodeURIComponent(svc.id!)}/version/${version}/logging/${type}`,
          )) ?? [];
        return list.map((e) => mapLoggingEndpoint(accountId, svc, version, type, e));
      } catch (err) {
        const status = statusOf(err);
        if (status === 403 || status === 404) return [];
        throw err;
      }
    });
    return results.flat();
  }

  private async listDictionaries(accountId: string): Promise<ResourceInstance[]> {
    const services = (await this.services()).filter((s) => s.type !== "wasm");
    const perService = await mapLimit(services, FAN_OUT, async (svc) => {
      const version = liveVersionOf(svc);
      if (!svc.id || !version) return [];
      const dicts =
        (await fastlyFetch<FastlyDictionary[]>(
          this.ctx,
          `/service/${encodeURIComponent(svc.id)}/version/${version}/dictionary`,
        ).catch((err) => {
          if (statusOf(err) === 403 || statusOf(err) === 404) return [] as FastlyDictionary[];
          throw err;
        })) ?? [];
      return mapLimit(dicts, FAN_OUT, async (d) => {
        const info = await fastlyFetch<{ item_count?: number }>(
          this.ctx,
          `/service/${encodeURIComponent(svc.id!)}/version/${version}/dictionary/${encodeURIComponent(d.id ?? "")}/info`,
        ).catch(() => undefined);
        return mapDictionary(accountId, svc, d, info?.item_count);
      });
    });
    return perService.flat();
  }

  private async listTokens(accountId: string): Promise<ResourceInstance[]> {
    const [tokens, self, services] = await Promise.all([
      fastlyFetch<FastlyToken[]>(this.ctx, "/tokens"),
      fastlyFetch<FastlyToken>(this.ctx, "/tokens/self").catch(() => ({}) as FastlyToken),
      this.services().catch(() => [] as FastlyServiceDetail[]),
    ]);
    const names = new Map(services.map((s) => [s.id ?? "", s.name ?? ""]));
    return (tokens ?? []).map((t) => mapToken(accountId, t, self.id ?? "", names));
  }

  private async loadAccount(accountId: string): Promise<ResourceInstance> {
    const [customer, user, token, services] = await Promise.all([
      fastlyFetch<CurrentCustomer>(this.ctx, "/current_customer").catch(
        () => ({}) as CurrentCustomer,
      ),
      fastlyFetch<CurrentUser>(this.ctx, "/current_user").catch(() => ({}) as CurrentUser),
      fastlyFetch<FastlyToken>(this.ctx, "/tokens/self").catch(() => ({}) as FastlyToken),
      this.services().catch(() => undefined),
    ]);
    const customerId = customer.id ?? user.customer_id ?? "customer";
    const fields: ResourceInstance["fields"] = {};
    const set = (k: string, v: string | number | undefined) => {
      if (v !== undefined && v !== "") fields[k] = v;
    };
    set("name", customer.name ?? "Fastly");
    set("customerId", customer.id ?? user.customer_id);
    set("pricingPlan", customer.pricing_plan);
    set("serviceCount", services?.length);
    set("userLogin", user.login);
    set("userRole", user.role);
    set("tokenScope", token.scope);
    const now = new Date(0).toISOString();
    return {
      id: `${accountId}:account:${customerId}`,
      pluginId: "fastly",
      resourceTypeId: "account",
      accountId,
      displayName: customer.name ?? "Fastly",
      fields,
      resolvedOutputs: customer.id ? { customerId: customer.id } : {},
      secretStates: [],
      externalId: customerId,
      createdAt: now,
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    if (typeId === "account") return this.loadAccount(accountId);
    if (typeId === "service") {
      const [detail, products] = await Promise.all([
        this.serviceDetail(id),
        enabledProductsByService(this.ctx).catch(() => new Map<string, string[]>()),
      ]);
      return mapService(accountId, detail, products.get(id) ?? []);
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === id);
    if (!found) throw new Error(`Fastly plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Fastly plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  /** Billing, live traffic and 24-hour totals for the detail views. */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const extra: Record<string, string> = {};
    const day = rangeOrDefault(undefined, DEFAULT_METRICS_WINDOW_MS);
    const id = resource.externalId ?? externalIdOf(resource.id);
    if (resource.resourceTypeId === "account") {
      const [billing, totals] = await Promise.all([
        fetchFastlyBillingSummary(this.ctx).catch(() => undefined),
        aggregateStats(this.ctx, day)
          .then(totalsOf)
          .catch(() => undefined),
      ]);
      if (billing) extra[BILLING_KEY] = JSON.stringify(billing);
      if (totals) extra[TOTALS_KEY] = JSON.stringify(totals);
      return {
        ...resource,
        fields: {
          ...resource.fields,
          ...(billing ? { monthToDate: billing.monthToDate, currency: billing.currency } : {}),
        },
        resolvedOutputs: { ...resource.resolvedOutputs, ...extra },
      };
    }
    if (resource.resourceTypeId === "service") {
      const [detail, totals, live] = await Promise.all([
        this.serviceDetail(id).catch(() => undefined),
        serviceStats(this.ctx, id, day)
          .then(totalsOf)
          .catch(() => undefined),
        realtimeSnapshot(this.ctx, id).catch(() => undefined),
      ]);
      const versions = (detail?.versions ?? [])
        .map((v) => v.number ?? 0)
        .filter((n) => n > 0)
        .sort((a, b) => b - a);
      extra[VERSIONS_KEY] = JSON.stringify(versions);
      if (totals) extra[TOTALS_KEY] = JSON.stringify(totals);
      if (live) extra[REALTIME_KEY] = JSON.stringify(live);
      return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
    }
    if (resource.resourceTypeId === "config-store") {
      const services = await fastlyFetch<Array<{ name?: string; id?: string }>>(
        this.ctx,
        `/resources/stores/config/${encodeURIComponent(id)}/services`,
      ).catch(() => undefined);
      if (services) {
        extra[STORE_SERVICES_KEY] = JSON.stringify(services.map((s) => s.name ?? s.id ?? ""));
      }
      return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
    }
    return resource;
  }

  // -------------------------------------------------------------------------
  // Stats, metrics and costs
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const id = externalIdOf(resourceId);
    if (resourceTypeId === "service") {
      const t = totalsOf(await serviceStats(this.ctx, id, rangeOrDefault(undefined)));
      return [
        { label: "Requests (24h)", value: Math.round(t.requests).toLocaleString("en-US") },
        {
          label: "Hit ratio",
          value: t.hitRatio === undefined ? "—" : `${t.hitRatio.toFixed(1)}%`,
        },
        {
          label: "5xx (24h)",
          value: Math.round(t.status5xx).toLocaleString("en-US"),
          variant: t.status5xx > 0 ? "status-degraded" : "status-healthy",
        },
      ];
    }
    if (resourceTypeId === "account") {
      const billing = await fetchFastlyBillingSummary(this.ctx).catch(() => undefined);
      return billing
        ? [
            {
              label: "Month to date",
              value: billing.monthToDate.toLocaleString("en-US", {
                style: "currency",
                currency: billing.currency,
              }),
            },
          ]
        : [];
    }
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    if (resourceTypeId === "tls-certificate" || resourceTypeId === "tls-subscription") {
      const t = Date.parse(String(r.fields["notAfter"] ?? ""));
      if (Number.isNaN(t)) return [];
      const days = Math.floor((t - Date.now()) / 86_400_000);
      return [
        {
          label: "Expires in",
          value: `${days} days`,
          variant: days < 0 ? "status-error" : days <= 14 ? "status-degraded" : "status-healthy",
        },
      ];
    }
    return [];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const range = rangeOrDefault(timeRange);
    if (resourceTypeId === "service") {
      return serviceSeriesFrom(await serviceStats(this.ctx, externalIdOf(resourceId), range));
    }
    if (resourceTypeId === "account") {
      return serviceSeriesFrom(await aggregateStats(this.ctx, range));
    }
    return [];
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchFastlyCostData(this.ctx, range);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyFastlyCredentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    const name = (description: string) => ({
      key: "name",
      label: "Name",
      kind: "text" as const,
      required: true,
      description,
    });
    switch (typeId) {
      case "service":
        return {
          fields: [
            name("Shown in the Fastly console and in Infrawrench."),
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "vcl",
              options: [
                {
                  id: "vcl",
                  label: "Delivery (VCL)",
                  description: "Caching CDN configured with VCL.",
                },
                { id: "wasm", label: "Compute", description: "WebAssembly at the edge." },
              ],
            },
            { key: "comment", label: "Comment", kind: "text", required: false },
          ],
        };
      case "kv-store":
        return {
          fields: [
            name("Letters, digits, dashes and underscores."),
            {
              key: "location",
              label: "Primary location",
              kind: "select",
              required: false,
              defaultValue: "",
              description: "Where writes land first; reads are served from every POP.",
              options: [
                { id: "", label: "Fastly default" },
                { id: "US", label: "United States" },
                { id: "EU", label: "Europe" },
                { id: "ASIA", label: "Asia" },
                { id: "AUS", label: "Australia" },
              ],
            },
          ],
        };
      case "config-store":
      case "secret-store":
        return { fields: [name("Letters, digits, dashes and underscores.")] };
      default:
        throw new Error(`Fastly plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = (fields["name"] ?? "").trim();
    if (!name) throw new Error("Enter a name.");
    switch (typeId) {
      case "service": {
        const svc = await fastlyFetch<FastlyServiceSummary>(this.ctx, "/service", {
          method: "POST",
          form: {
            name,
            type: fields["type"] === "wasm" ? "wasm" : "vcl",
            ...(fields["comment"] ? { comment: fields["comment"] } : {}),
          },
        });
        this.invalidate();
        return mapService(accountId, svc);
      }
      case "kv-store": {
        const st = await fastlyFetch<FastlyStore>(this.ctx, "/resources/stores/kv", {
          method: "POST",
          json: { name },
          ...(fields["location"] ? { query: { location: fields["location"] } } : {}),
        });
        return mapStore(accountId, "kv-store", st);
      }
      case "config-store": {
        const st = await fastlyFetch<FastlyStore>(this.ctx, "/resources/stores/config", {
          method: "POST",
          form: { name },
        });
        return mapStore(accountId, "config-store", st, { itemCount: 0 });
      }
      case "secret-store": {
        const st = await fastlyFetch<FastlyStore>(this.ctx, "/resources/stores/secret", {
          method: "POST",
          json: { name },
        });
        return mapStore(accountId, "secret-store", st);
      }
      default:
        throw new Error(`Fastly plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    if (typeId === "service") {
      await fastlyFetch<unknown>(this.ctx, `/service/${encodeURIComponent(id)}`, {
        method: "PUT",
        form: {
          ...("name" in fields ? { name: fields["name"] } : {}),
          ...("comment" in fields ? { comment: fields["comment"] ?? "" } : {}),
        },
      });
      this.invalidate();
      return this.getResource(typeId, resourceId, accountId);
    }
    if (typeId === "service-version") {
      const [sid, num] = splitChild(id);
      await fastlyFetch<unknown>(this.ctx, `/service/${encodeURIComponent(sid)}/version/${num}`, {
        method: "PUT",
        form: { comment: fields["comment"] ?? "" },
      });
      this.invalidate();
      return this.getResource(typeId, resourceId, accountId);
    }
    if (typeId === "config-store") {
      const st = await fastlyFetch<FastlyStore>(
        this.ctx,
        `/resources/stores/config/${encodeURIComponent(id)}`,
        { method: "PUT", form: { name: (fields["name"] ?? "").trim() } },
      );
      return mapStore(accountId, "config-store", st);
    }
    throw new Error(`Fastly plugin: "${typeId}" cannot be edited from Infrawrench`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    switch (typeId) {
      case "service":
        try {
          await fastlyFetch<unknown>(this.ctx, `/service/${id}`, { method: "DELETE" });
        } catch (err) {
          if (statusOf(err) === 400 || statusOf(err) === 409) {
            throw new Error(
              "Fastly only deletes a service with no active version. Deactivate it first, then delete it.",
            );
          }
          throw err;
        }
        this.invalidate();
        return;
      case "kv-store":
        await fastlyFetch<unknown>(this.ctx, `/resources/stores/kv/${id}`, { method: "DELETE" });
        return;
      case "config-store":
        await fastlyFetch<unknown>(this.ctx, `/resources/stores/config/${id}`, {
          method: "DELETE",
        });
        return;
      case "secret-store":
        await fastlyFetch<unknown>(this.ctx, `/resources/stores/secret/${id}`, {
          method: "DELETE",
        });
        return;
      case "tls-certificate":
        await fastlyFetch<unknown>(this.ctx, `/tls/certificates/${id}`, { method: "DELETE" });
        return;
      case "tls-subscription":
        await fastlyFetch<unknown>(this.ctx, `/tls/subscriptions/${id}`, { method: "DELETE" });
        return;
      default:
        throw new Error(`Fastly plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async activeVersion(serviceId: string): Promise<number> {
    const detail = await this.serviceDetail(serviceId);
    const active = detail.active_version?.number ?? detail.versions?.find((v) => v.active)?.number;
    if (!active) throw new Error("This service has no active version.");
    return active;
  }

  private versionPath(serviceId: string, version: number | string, suffix: string): string {
    return `/service/${encodeURIComponent(serviceId)}/version/${version}/${suffix}`;
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    if (typeId === "service" && SERVICE_ACTIONS.has(actionId)) {
      if (actionId === "purge-all") {
        await fastlyFetch<unknown>(this.ctx, `/service/${encodeURIComponent(id)}/purge_all`, {
          method: "POST",
        });
        return;
      }
      const active = await this.activeVersion(id);
      await fastlyFetch<unknown>(
        this.ctx,
        this.versionPath(id, active, actionId === "clone-active" ? "clone" : "deactivate"),
        { method: "PUT" },
      );
      this.invalidate();
      return;
    }
    if (typeId === "service-version" && VERSION_ACTIONS.has(actionId)) {
      const [sid, num] = splitChild(id);
      if (actionId === "validate") {
        const res = await fastlyFetch<{ status?: string; errors?: string[]; msg?: string }>(
          this.ctx,
          this.versionPath(sid, num, "validate"),
        );
        if (res?.status && res.status !== "ok") {
          throw new Error(
            `Fastly found problems in this version: ${(res.errors ?? []).join("; ") || res.msg || res.status}`,
          );
        }
        return;
      }
      await fastlyFetch<unknown>(this.ctx, this.versionPath(sid, num, actionId), {
        method: "PUT",
      });
      this.invalidate();
      return;
    }
    if (typeId === "api-token" && actionId === "revoke") {
      const self = await fastlyFetch<FastlyToken>(this.ctx, "/tokens/self").catch(
        () => ({}) as FastlyToken,
      );
      if (self.id && self.id === id) {
        throw new Error(
          "This is the token this account uses. Revoke it in Fastly after replacing the account's credentials.",
        );
      }
      await fastlyFetch<unknown>(this.ctx, `/tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return;
    }
    throw new Error(`Fastly plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  /** Form-driven actions (`prompt-nosql-command`): purges, activation, products. */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const values = JSON.parse(String(args[0] ?? "{}")) as Record<string, string>;
    const id = externalIdOf(resourceId);
    const soft = values["soft"] === "soft" ? { "Fastly-Soft-Purge": "1" } : undefined;
    if (command === "purge-url" && (typeId === "service" || typeId === "account")) {
      const path = purgePathFor(values["url"] ?? "");
      const res = await fastlyFetch<{ status?: string; id?: string }>(
        this.ctx,
        `/purge/${encodeURI(path)}`,
        { method: "POST", ...(soft ? { headers: soft } : {}) },
      );
      return { message: `Purge ${res?.status ?? "sent"}${res?.id ? ` (id ${res.id})` : ""}.` };
    }
    if (typeId !== "service") throw new Error(`Unknown Fastly command "${command}".`);
    switch (command) {
      case "purge-keys": {
        const keys = parseKeys(values["keys"] ?? "");
        if (keys.length === 0) throw new Error("Enter at least one surrogate key.");
        if (keys.length === 1) {
          await fastlyFetch<unknown>(
            this.ctx,
            `/service/${encodeURIComponent(id)}/purge/${encodeURIComponent(keys[0]!)}`,
            { method: "POST", ...(soft ? { headers: soft } : {}) },
          );
        } else {
          // The batch endpoint takes up to 256 keys per request.
          for (let i = 0; i < keys.length; i += 256) {
            await fastlyFetch<unknown>(this.ctx, `/service/${encodeURIComponent(id)}/purge`, {
              method: "POST",
              json: { surrogate_keys: keys.slice(i, i + 256) },
              ...(soft ? { headers: soft } : {}),
            });
          }
        }
        return { message: `Purged ${keys.length} surrogate key${keys.length === 1 ? "" : "s"}.` };
      }
      case "activate-version": {
        const version = Number(values["version"]);
        if (!Number.isInteger(version) || version <= 0) throw new Error("Pick a version.");
        await fastlyFetch<unknown>(this.ctx, this.versionPath(id, version, "activate"), {
          method: "PUT",
        });
        this.invalidate();
        return { message: `Version ${version} is now active.` };
      }
      case "set-product": {
        const enable = values["state"] !== "disable";
        await setProductEnabled(this.ctx, values["product"] ?? "", id, enable);
        return { message: enable ? "Product enabled." : "Product disabled." };
      }
      default:
        throw new Error(`Unknown Fastly command "${command}".`);
    }
  }

  // -------------------------------------------------------------------------
  // Key browser: edge dictionaries, config stores and KV stores
  // -------------------------------------------------------------------------

  async listKvKeys(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    params?: { prefix?: string; cursor?: string; limit?: number },
  ): Promise<KvListResult> {
    const id = externalIdOf(resourceId);
    const limit = Math.min(Math.max(params?.limit ?? 100, 1), 1000);
    const prefix = params?.prefix ?? "";
    if (resourceTypeId === "kv-store") {
      const res = await fastlyFetch<{ data?: string[]; meta?: { next_cursor?: string } }>(
        this.ctx,
        `/resources/stores/kv/${encodeURIComponent(id)}/keys`,
        {
          query: {
            limit,
            ...(prefix ? { prefix } : {}),
            ...(params?.cursor ? { cursor: params.cursor } : {}),
          },
        },
      );
      return {
        items: (res?.data ?? []).map((name) => ({ name })),
        ...(res?.meta?.next_cursor ? { nextCursor: res.meta.next_cursor } : {}),
      };
    }
    let all: Array<{ item_key?: string }> = [];
    if (resourceTypeId === "config-store") {
      all =
        (await fastlyFetch<Array<{ item_key?: string }>>(
          this.ctx,
          `/resources/stores/config/${encodeURIComponent(id)}/items`,
        )) ?? [];
    } else if (resourceTypeId === "dictionary") {
      const [sid, did] = splitChild(id);
      all = await fastlyPaged<{ item_key?: string }>(
        this.ctx,
        `/service/${encodeURIComponent(sid)}/dictionary/${encodeURIComponent(did)}/items`,
        { sort: "item_key", direction: "ascend" },
        1000,
      );
    } else {
      throw new Error(`Fastly plugin: "${resourceTypeId}" has no keys`);
    }
    const names = all
      .map((i) => i.item_key ?? "")
      .filter((k) => k && k.startsWith(prefix))
      .sort();
    const offset = Number(params?.cursor ?? 0) || 0;
    const page = names.slice(offset, offset + limit);
    return {
      items: page.map((name) => ({ name })),
      ...(offset + limit < names.length ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  private itemPath(resourceTypeId: string, id: string, key: string): string {
    const k = encodeURIComponent(key);
    if (resourceTypeId === "kv-store")
      return `/resources/stores/kv/${encodeURIComponent(id)}/keys/${k}`;
    if (resourceTypeId === "config-store") {
      return `/resources/stores/config/${encodeURIComponent(id)}/item/${k}`;
    }
    if (resourceTypeId === "dictionary") {
      const [sid, did] = splitChild(id);
      return `/service/${encodeURIComponent(sid)}/dictionary/${encodeURIComponent(did)}/item/${k}`;
    }
    throw new Error(`Fastly plugin: "${resourceTypeId}" has no keys`);
  }

  async getKvValue(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
  ): Promise<string> {
    const path = this.itemPath(resourceTypeId, externalIdOf(resourceId), key);
    if (resourceTypeId === "kv-store") {
      return (await fastlyRaw(this.ctx, path, { headers: { Accept: "*/*" } })).body;
    }
    const item = await fastlyFetch<{ item_value?: string }>(this.ctx, path);
    return item?.item_value ?? "";
  }

  async putKvValue(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
    value: string,
  ): Promise<void> {
    const path = this.itemPath(resourceTypeId, externalIdOf(resourceId), key);
    if (resourceTypeId === "kv-store") {
      await fastlyRaw(this.ctx, path, { method: "PUT", raw: value });
      return;
    }
    // PUT on a dictionary or config-store item is an upsert.
    await fastlyFetch<unknown>(this.ctx, path, { method: "PUT", form: { item_value: value } });
  }

  async deleteKvKey(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
  ): Promise<void> {
    await fastlyRaw(this.ctx, this.itemPath(resourceTypeId, externalIdOf(resourceId), key), {
      method: "DELETE",
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderFastlyDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderFastlySidebar(resource);
  }
}
