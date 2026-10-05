/**
 * The price catalog's server half: fetch each plugin's normalized price list,
 * cache it per the plugin's declared cadence, and answer search / compare
 * over the cache with the pure functions in `@infrawrench/client-core`.
 *
 * Provider logic stays in the plugins (`priceCatalog` + `fetchPriceCatalog`);
 * this file knows nothing about any provider. It only decides *which* half
 * to call (the Plugin's public fetch, or a client built from one of the org's
 * accounts when the declaration says credentials are needed) and how long a
 * result stays fresh.
 *
 * ## Caching
 *
 * One in-memory entry per (plugin, service, region), plus the account id for
 * a credentialed catalog: list prices are public, but a result fetched with
 * one org's credentials is never served to another org, so an org without an
 * AWS account sees AWS as "connect an account" rather than borrowing someone
 * else's API access. Entries live for the plugin's `refreshHours`; an expired
 * entry is served while one refresh runs behind it (a price list a few hours
 * staler than declared is a far better answer than a 20-second spinner), and
 * failures are remembered briefly so a down pricing API is not hammered on
 * every keystroke of a search box.
 *
 * Each pod keeps its own cache. That is deliberate: the data is public,
 * cheap to refetch on the cadences involved, and persisting it would add a
 * table whose only job is to hold numbers the providers already host.
 */
import type {
  Plugin,
  PluginClient,
  PriceCatalogDeclaration,
  PriceCatalogProduct,
  PriceCatalogResult,
} from "@infrawrench/plugin-base";
import {
  DEFAULT_PRICE_CATALOG_AREA,
  PRICE_CATALOG_DEFAULT_LIMIT,
  buildCatalogRows,
  compareTargetFromSpecs,
  identityConverter,
  rankEquivalents,
  resolveCatalogRegion,
  rowMatchesQuery,
  sortCatalogRows,
  summarizeCurrencies,
  type PriceCatalogArea,
  type PriceCatalogCompareProvider,
  type PriceCatalogCompareQuery,
  type PriceCatalogCompareResponse,
  type PriceCatalogConverter,
  type PriceCatalogProviderStatus,
  type PriceCatalogRow,
  type PriceCatalogSearchQuery,
  type PriceCatalogSearchResponse,
  type PriceRateType,
} from "@infrawrench/client-core";

/** What the service needs from the rest of the server; injected for tests. */
export interface PriceCatalogDeps {
  listPlugins(): Promise<Plugin[]>;
  /** The org's live (not deleted) account ids on a plugin, oldest first. */
  listAccountIds(organizationId: string, pluginId: string): Promise<string[]>;
  getClient(accountId: string, organizationId: string): Promise<PluginClient | null>;
  /** Run a public fetch with the host's HTTP plumbing and egress guard. */
  runPublicFetch(
    plugin: Plugin,
    organizationId: string,
    fn: (plugin: Plugin) => Promise<PriceCatalogResult>,
  ): Promise<PriceCatalogResult>;
  /** The org's comparison currency and converter. */
  loadConverter(
    organizationId: string,
  ): Promise<{ displayCurrency: string | null; convert: PriceCatalogConverter }>;
  now(): number;
}

interface CacheEntry {
  fetchedAt: number;
  expiresAt: number;
  result: PriceCatalogResult | null;
  error: string | null;
  inFlight: Promise<void> | null;
}

/** How long a failed fetch is remembered before the next attempt. */
const ERROR_TTL_MS = 5 * 60_000;
/** A search waits this long for a cold provider before reporting "loading". */
const COLD_WAIT_MS = 20_000;
const MAX_CACHE_ENTRIES = 2_000;

type CatalogPlugin = Plugin & {
  manifest: Plugin["manifest"] & { priceCatalog: PriceCatalogDeclaration };
};

function hasCatalog(plugin: Plugin): plugin is CatalogPlugin {
  return Boolean(plugin.manifest.priceCatalog);
}

function errorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

interface ProviderFetch {
  plugin: CatalogPlugin;
  status: PriceCatalogProviderStatus;
  products: PriceCatalogProduct[];
}

export function createPriceCatalogService(deps: PriceCatalogDeps) {
  const cache = new Map<string, CacheEntry>();

  function evictIfFull(): void {
    if (cache.size < MAX_CACHE_ENTRIES) return;
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of cache) {
      if (!entry.inFlight && entry.fetchedAt < oldest) {
        oldest = entry.fetchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }

  async function catalogPlugins(): Promise<CatalogPlugin[]> {
    return (await deps.listPlugins()).filter(hasCatalog);
  }

  function baseStatus(plugin: CatalogPlugin): PriceCatalogProviderStatus {
    const decl = plugin.manifest.priceCatalog;
    return {
      pluginId: plugin.manifest.id,
      pluginName: plugin.manifest.displayName,
      requiresCredentials: decl.requiresCredentials,
      permission: decl.permission ?? null,
      source: decl.source,
      refreshHours: decl.refreshHours,
      services: decl.services,
      regions: decl.regions,
      state: "ready",
      region: null,
      error: null,
      fetchedAt: null,
      truncated: false,
    };
  }

  /**
   * Fetch one (plugin, service, region) through the cache. Resolves to the
   * entry as it stands after at most `waitMs`: a cold fetch slower than that
   * keeps running and lands in the cache for the next request.
   */
  async function loadEntry(
    plugin: CatalogPlugin,
    organizationId: string,
    serviceId: string,
    region: string | undefined,
    waitMs: number,
  ): Promise<{ entry: CacheEntry | null; state: "ready" | "no-account" | "loading" | "error" }> {
    const decl = plugin.manifest.priceCatalog;
    let accountIds: string[] = [];
    if (decl.requiresCredentials) {
      accountIds = await deps.listAccountIds(organizationId, plugin.manifest.id);
      if (accountIds.length === 0) return { entry: null, state: "no-account" };
    }
    const regionKey = decl.regionScoped === false ? "*" : (region ?? "*");
    const key = [
      plugin.manifest.id,
      serviceId,
      regionKey,
      decl.requiresCredentials ? `${organizationId}:${accountIds[0]}` : "public",
    ].join("|");

    const now = deps.now();
    let entry = cache.get(key);
    const fresh = entry && !entry.inFlight && now < entry.expiresAt;
    if (entry && fresh) return { entry, state: entry.result ? "ready" : "error" };

    if (!entry) {
      evictIfFull();
      entry = { fetchedAt: 0, expiresAt: 0, result: null, error: null, inFlight: null };
      cache.set(key, entry);
    }
    const current = entry;
    if (!current.inFlight) {
      const request = { serviceId, ...(region && decl.regionScoped !== false ? { region } : {}) };
      current.inFlight = (async () => {
        try {
          let result: PriceCatalogResult;
          if (decl.requiresCredentials) {
            result = await fetchWithAccounts(plugin, organizationId, accountIds, request);
          } else {
            const fetchPublic = plugin.fetchPriceCatalog;
            if (!fetchPublic) throw new Error("This plugin declares a catalog it cannot fetch.");
            result = await deps.runPublicFetch(plugin, organizationId, (p) =>
              p.fetchPriceCatalog!(request),
            );
          }
          const at = deps.now();
          current.result = result;
          current.error = null;
          current.fetchedAt = at;
          current.expiresAt = at + decl.refreshHours * 3_600_000;
        } catch (e) {
          // A stale success beats a fresh failure: keep serving the last good
          // list and report the error beside it.
          current.error = errorMessage(e);
          current.expiresAt = deps.now() + ERROR_TTL_MS;
          if (!current.result) current.fetchedAt = deps.now();
        } finally {
          current.inFlight = null;
        }
      })();
    }

    // Stale-while-revalidate: an expired entry with data answers now.
    if (current.result) return { entry: current, state: "ready" };

    const inFlight = current.inFlight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      inFlight!.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) return { entry: null, state: "loading" };
    return { entry: current, state: current.result ? "ready" : "error" };
  }

  async function fetchWithAccounts(
    plugin: CatalogPlugin,
    organizationId: string,
    accountIds: string[],
    request: { serviceId: string; region?: string },
  ): Promise<PriceCatalogResult> {
    // Two accounts at most: the second covers "the oldest account's key was
    // rotated", without turning one bad provider into N slow failures.
    let lastError: unknown = null;
    for (const accountId of accountIds.slice(0, 2)) {
      try {
        const client = await deps.getClient(accountId, organizationId);
        if (!client?.fetchPriceCatalog) {
          lastError = new Error("This account's plugin cannot fetch prices.");
          continue;
        }
        return await client.fetchPriceCatalog(request);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Fetch every in-scope provider's products for the region chosen for it. */
  async function fetchProviders(
    organizationId: string,
    opts: {
      pluginIds?: string[] | undefined;
      serviceIds?: string[] | undefined;
      region?: string | undefined;
      area: PriceCatalogArea;
      waitMs?: number;
    },
  ): Promise<ProviderFetch[]> {
    const plugins = (await catalogPlugins()).filter(
      (p) => !opts.pluginIds || opts.pluginIds.includes(p.manifest.id),
    );
    return Promise.all(
      plugins.map(async (plugin): Promise<ProviderFetch> => {
        const status = baseStatus(plugin);
        const decl = plugin.manifest.priceCatalog;
        const region = resolveCatalogRegion(decl.regions, {
          region: opts.region,
          area: opts.area,
        });
        if (!region) {
          return { plugin, status: { ...status, state: "no-region" }, products: [] };
        }
        status.region = region.id;
        const services = decl.services.filter(
          (s) => !opts.serviceIds || opts.serviceIds.includes(s.id),
        );
        const products: PriceCatalogProduct[] = [];
        const states: string[] = [];
        const errors: string[] = [];
        let fetchedAt: number | null = null;
        for (const service of services) {
          try {
            const { entry, state } = await loadEntry(
              plugin,
              organizationId,
              service.id,
              region.id,
              opts.waitMs ?? COLD_WAIT_MS,
            );
            states.push(state);
            if (entry?.error) errors.push(entry.error);
            if (entry?.result) {
              products.push(...entry.result.products);
              if (entry.result.truncated) status.truncated = true;
              fetchedAt =
                fetchedAt === null ? entry.fetchedAt : Math.min(fetchedAt, entry.fetchedAt);
            }
          } catch (e) {
            states.push("error");
            errors.push(errorMessage(e));
          }
        }
        status.state = states.includes("no-account")
          ? "no-account"
          : products.length > 0 || states.every((s) => s === "ready")
            ? "ready"
            : states.includes("loading")
              ? "loading"
              : "error";
        status.error = errors[0] ?? null;
        status.fetchedAt = fetchedAt !== null ? new Date(fetchedAt).toISOString() : null;
        return { plugin, status, products };
      }),
    );
  }

  function rowsFor(
    fetches: ProviderFetch[],
    rateType: PriceRateType,
    term: string | undefined,
    convert: PriceCatalogConverter,
  ): PriceCatalogRow[] {
    const rows: PriceCatalogRow[] = [];
    for (const f of fetches) {
      if (!f.status.region) continue;
      const decl = f.plugin.manifest.priceCatalog;
      rows.push(
        ...buildCatalogRows({
          pluginId: f.plugin.manifest.id,
          pluginName: f.plugin.manifest.displayName,
          services: decl.services,
          region: f.status.region,
          regionLabel: decl.regions.find((r) => r.id === f.status.region)?.label ?? f.status.region,
          products: f.products,
          rateType,
          term,
          convert,
        }),
      );
    }
    return rows;
  }

  async function listProviders(organizationId: string): Promise<PriceCatalogProviderStatus[]> {
    const plugins = await catalogPlugins();
    return Promise.all(
      plugins.map(async (plugin) => {
        const status = baseStatus(plugin);
        if (plugin.manifest.priceCatalog.requiresCredentials) {
          const ids = await deps.listAccountIds(organizationId, plugin.manifest.id);
          if (ids.length === 0) status.state = "no-account";
        }
        return status;
      }),
    );
  }

  async function search(
    organizationId: string,
    query: PriceCatalogSearchQuery,
  ): Promise<PriceCatalogSearchResponse> {
    const area = query.area ?? DEFAULT_PRICE_CATALOG_AREA;
    const rateType = query.rateType ?? "on-demand";
    const [fetches, { displayCurrency, convert }] = await Promise.all([
      fetchProviders(organizationId, {
        pluginIds: query.pluginIds,
        serviceIds: query.serviceIds,
        region: query.region,
        area,
      }),
      deps.loadConverter(organizationId),
    ]);
    const all = rowsFor(fetches, rateType, query.term, convert);
    const gpuModels = [
      ...new Set(
        fetches.flatMap((f) =>
          f.products.map((p) => p.specs.gpuModel).filter((m): m is string => !!m),
        ),
      ),
    ].sort();
    const matched = sortCatalogRows(
      all.filter((row) => rowMatchesQuery(row, query)),
      query.sort ?? "price",
      query.order ?? "asc",
    );
    const offset = query.offset ?? 0;
    const limit = query.limit ?? PRICE_CATALOG_DEFAULT_LIMIT;
    const { currencies, mixedCurrencies } = summarizeCurrencies(matched);
    return {
      rows: matched.slice(offset, offset + limit),
      total: matched.length,
      offset,
      limit,
      area,
      rateType,
      providers: fetches.map((f) => f.status),
      displayCurrency,
      currencies,
      mixedCurrencies,
      gpuModels,
      generatedAt: new Date(deps.now()).toISOString(),
    };
  }

  async function compare(
    organizationId: string,
    query: PriceCatalogCompareQuery,
  ): Promise<PriceCatalogCompareResponse> {
    const area = query.area ?? DEFAULT_PRICE_CATALOG_AREA;
    const rateType = query.rateType ?? "on-demand";
    const { displayCurrency, convert } = await deps.loadConverter(organizationId);

    let reference: PriceCatalogRow | null = null;
    if (query.reference) {
      const [refFetch] = await fetchProviders(organizationId, {
        pluginIds: [query.reference.pluginId],
        area,
      });
      if (refFetch) {
        const product = refFetch.products.find((p) => p.sku === query.reference!.sku);
        if (product) {
          // The reference's own row, at whatever rate it has in its region:
          // on-demand when present so the target is described honestly.
          reference =
            rowsFor([{ ...refFetch, products: [product] }], rateType, undefined, convert)[0] ??
            rowsFor([{ ...refFetch, products: [product] }], "on-demand", undefined, convert)[0] ??
            null;
        }
      }
      if (!reference) {
        throw new PriceCatalogNotFoundError(
          `No product "${query.reference.sku}" in the ${query.reference.pluginId} catalog for ${area}.`,
        );
      }
    }

    const target = reference
      ? compareTargetFromSpecs(reference.specs)
      : {
          vcpus: query.vcpus ?? null,
          memoryGb: query.memoryGb ?? null,
          gpuCount: query.gpuCount && query.gpuCount > 0 ? query.gpuCount : null,
          gpuModel: query.gpuModel ?? null,
        };
    if (
      target.vcpus === null &&
      target.memoryGb === null &&
      target.gpuCount === null &&
      target.gpuModel === null
    ) {
      throw new PriceCatalogQueryError(
        "Say what to compare: vcpus, memoryGb, gpuCount or gpuModel, or a reference product.",
      );
    }

    const fetches = await fetchProviders(organizationId, { pluginIds: query.pluginIds, area });
    const alternatives = query.alternatives ?? 2;
    const providers: PriceCatalogCompareProvider[] = fetches.map((f) => {
      const ranked = rankEquivalents(rowsFor([f], rateType, undefined, convert), target);
      const decl = f.plugin.manifest.priceCatalog;
      return {
        pluginId: f.plugin.manifest.id,
        pluginName: f.plugin.manifest.displayName,
        region: f.status.region,
        regionLabel: decl.regions.find((r) => r.id === f.status.region)?.label ?? null,
        state: f.status.state,
        error: f.status.error,
        best: ranked[0] ?? null,
        alternatives: ranked.slice(1, 1 + Math.max(0, alternatives)),
      };
    });
    providers.sort((a, b) => {
      const av = a.best?.comparable?.amount;
      const bv = b.best?.comparable?.amount;
      if (av === undefined && bv === undefined) return a.pluginName < b.pluginName ? -1 : 1;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return av - bv;
    });
    const bests = providers.flatMap((p) => (p.best ? [p.best] : []));
    return {
      target,
      reference,
      area,
      rateType,
      providers,
      displayCurrency,
      mixedCurrencies: summarizeCurrencies(bests).mixedCurrencies,
      generatedAt: new Date(deps.now()).toISOString(),
    };
  }

  return {
    listProviders,
    search,
    compare,
    /** Test hook. */
    clearCache: () => cache.clear(),
  };
}

export type PriceCatalogService = ReturnType<typeof createPriceCatalogService>;

/** The request cannot be answered as asked (HTTP 400). */
export class PriceCatalogQueryError extends Error {}
/** A reference product does not exist (HTTP 404). */
export class PriceCatalogNotFoundError extends Error {}

export { identityConverter };
