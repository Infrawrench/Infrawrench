import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceCreateReturn,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  ListTruncatedError,
  pathEncode,
  requireListPage,
  reportUnreadListPart,
  rethrowIncompleteList,
  unencodedSegment,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { AlgoliaApi, errorText, isStatus, keyFingerprint } from "./api.js";
import {
  APPLICATION_EXTERNAL_ID,
  externalOf,
  makeInstance,
  mapAbTest,
  mapApiKey,
  mapCrawler,
  mapIndex,
  splitList,
} from "./mappers.js";
import {
  ENRICH_CRAWL_STATS,
  ENRICH_INDEXES,
  ENRICH_NO_RESULTS,
  ENRICH_SOURCES,
  ENRICH_TOP_SEARCHES,
  renderAlgoliaDetail,
  renderAlgoliaSidebarItem,
} from "./render.js";
import { ACL_LABELS, ACLS } from "./resource-types.js";
import type {
  AlAbTest,
  AlAbTestPage,
  AlAcl,
  AlApiKey,
  AlApiKeyBody,
  AlCrawlerRow,
  AlIndex,
  AlSettings,
  AlSettingsPatch,
  AlUsagePoint,
} from "./types.js";

const INDEX_TTL_MS = 30_000;
const FAN_OUT = 6;
const MAX_SETTINGS_FETCH = 150;
const VENDOR = "Algolia";
const INDEX_PAGE_SIZE = 1000;
const MAX_INDEX_PAGES = 50;
const AB_TEST_PAGE_SIZE = 100;
const MAX_AB_TEST_PAGES = 100;
/** What `/3` answers for a request it turned down, which `/2` may still take. */
const AB_TEST_V3_REFUSED = [400, 404, 405, 422];
/** `POST /3/abtests` requires these; they are the rates a test here reports. */
const AB_TEST_METRICS = [{ name: "clickThroughRate" }, { name: "conversionRate" }];
// The document's largest `itemsPerPage` and last `page`: the route serves no more than this.
const CRAWLER_PAGE_SIZE = 100;
const MAX_CRAWLER_PAGES = 100;
const DAY_MS = 86_400_000;

export const KEY_VALUE_FIELD = "apiKey";

function str(v: string | null | undefined): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function intField(raw: string | undefined, label: string, min: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min)
    throw new Error(`${label} must be a whole number of at least ${min}.`);
  return n;
}

function parseFormArg(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: object = JSON.parse(raw);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed))
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    return out;
  } catch {
    return {};
  }
}

/** A policy-picker JSON array or a comma-separated list. */
export function parseList(raw: string | undefined): string[] {
  const t = (raw ?? "").trim();
  if (t.startsWith("[")) {
    try {
      const parsed: (string | number)[] = JSON.parse(t);
      return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return splitList(t);
}

const isAcl = (value: string): value is AlAcl => ACLS.some((acl) => acl === value);

export function parseAcl(raw: string | undefined): AlAcl[] {
  const parsed = [...new Set(parseList(raw))];
  const bad = parsed.filter((a) => !isAcl(a));
  if (bad.length) throw new Error(`Unknown ACL ${bad.join(", ")}. Use any of: ${ACLS.join(", ")}.`);
  return parsed.filter(isAcl);
}

/** Field and setting share a spelling. */
const LIST_SETTINGS = [
  "searchableAttributes",
  "customRanking",
  "attributesForFaceting",
  "attributesToRetrieve",
  "unretrievableAttributes",
  "queryLanguages",
  "indexLanguages",
  "replicas",
] as const;

/** Edited fields (form spelling) to an Algolia settings patch. */
export function settingsPatch(fields: Record<string, string>): AlSettingsPatch {
  const patch: AlSettingsPatch = {};
  for (const setting of LIST_SETTINGS) {
    if (fields[setting] !== undefined) patch[setting] = splitList(fields[setting]);
  }
  const hits = intField(fields["hitsPerPage"], "Hits per page", 1);
  if (hits !== undefined) patch.hitsPerPage = hits;
  const limit = intField(fields["paginationLimitedTo"], "Pagination limit", 1);
  if (limit !== undefined) patch.paginationLimitedTo = limit;
  const distinct = intField(fields["distinct"], "Distinct", 0);
  if (distinct !== undefined) patch.distinct = distinct;
  if (fields["attributeForDistinct"] !== undefined) {
    patch.attributeForDistinct = str(fields["attributeForDistinct"]) || null;
  }
  const typo = str(fields["typoTolerance"]);
  if (typo) patch.typoTolerance = typo === "true" ? true : typo === "false" ? false : typo;
  for (const b of [
    "ignorePlurals",
    "removeStopWords",
    "enableRules",
    "enablePersonalization",
  ] as const) {
    if (fields[b] !== undefined && fields[b] !== "") patch[b] = fields[b] === "true";
  }
  for (const e of ["queryType", "removeWordsIfNoResults", "mode"] as const) {
    if (str(fields[e])) patch[e] = str(fields[e]);
  }
  return patch;
}

/** Usage API payload (`{stat: [{t, v}]}`) to series; per-server values collapse to their maximum. */
export function usageSeries(
  res: Record<string, AlUsagePoint[] | undefined> | undefined,
  labels: Record<string, { label: string; unit: string }>,
): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const [stat, meta] of Object.entries(labels)) {
    const pts = (res?.[stat] ?? [])
      .map((p) => ({
        timestamp: p.t,
        value:
          typeof p.v === "number"
            ? p.v
            : Math.max(
                0,
                ...Object.values(p.v ?? {})
                  .map(Number)
                  .filter(Number.isFinite),
              ),
      }))
      .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
    if (pts.length) out.push({ label: meta.label, unit: meta.unit, points: pts });
  }
  return out;
}

const APP_USAGE: Record<string, { label: string; unit: string }> = {
  total_search_operations: { label: "Search Operations", unit: "operations" },
  total_write_operations: { label: "Write Operations", unit: "operations" },
  records: { label: "Records", unit: "records" },
  data_size: { label: "Data Size", unit: "bytes" },
  avg_processing_time: { label: "Avg Processing Time", unit: "ms" },
  "90p_processing_time": { label: "p90 Processing Time", unit: "ms" },
  "99p_processing_time": { label: "p99 Processing Time", unit: "ms" },
  max_qps: { label: "Max QPS", unit: "req/s" },
  used_search_capacity: { label: "Search Capacity Used", unit: "%" },
  degraded_queries_max_capacity_queries_impacted: {
    label: "Queries Degraded by Capacity",
    unit: "queries",
  },
};

const INDEX_USAGE: Record<string, { label: string; unit: string }> = {
  total_search_operations: { label: "Search Operations", unit: "operations" },
  total_write_operations: { label: "Write Operations", unit: "operations" },
  records: { label: "Records", unit: "records" },
  data_size: { label: "Data Size", unit: "bytes" },
  avg_processing_time: { label: "Avg Processing Time", unit: "ms" },
};

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Algolia plugin client. One account is one application (its ID and Admin
 * API key); optional keys add usage metrics, cluster monitoring and crawlers.
 */
export class AlgoliaClient implements PluginClient {
  readonly api: AlgoliaApi;
  private indexCache: { at: number; value: Promise<AlIndex[]> } | undefined;

  constructor(
    credentials: Credentials,
    private readonly resourceTypes: ResourceTypeDefinition[],
    private readonly services?: HostServices,
  ) {
    const appId = str(credentials["appId"]);
    const apiKey = str(credentials["apiKey"]);
    if (!appId) throw new Error("Algolia plugin: missing appId credential");
    if (!apiKey) throw new Error("Algolia plugin: missing apiKey credential");
    this.api = new AlgoliaApi(
      {
        appId,
        apiKey,
        usageApiKey: str(credentials["usageApiKey"]),
        monitoringApiKey: str(credentials["monitoringApiKey"]),
        analyticsRegion: str(credentials["analyticsRegion"]),
        crawlerUserId: str(credentials["crawlerUserId"]),
        crawlerApiKey: str(credentials["crawlerApiKey"]),
        caCert: credentials["caCert"] ?? "",
      },
      services,
    );
  }

  // ── Discovery ────────────────────────────────────────────────────────

  indexes(): Promise<AlIndex[]> {
    if (this.indexCache && Date.now() - this.indexCache.at < INDEX_TTL_MS)
      return this.indexCache.value;
    const value = (async () => {
      const path = "/1/indexes";
      const out: AlIndex[] = [];
      // By hand: `withPagination` numbers pages from 1, and these start at 0.
      for (let page = 0; page < MAX_INDEX_PAGES; page++) {
        const res = await this.api.search.get(path, {
          query: { page, hitsPerPage: INDEX_PAGE_SIZE },
        });
        const rows = requireListPage(res?.items, { vendor: VENDOR, path, key: "items", page: res });
        out.push(...rows);
        // `nbPages` is optional in the document, so a full page without it may have a next one.
        const more = res?.nbPages ? page + 1 < res.nbPages : rows.length === INDEX_PAGE_SIZE;
        if (!more) return out;
      }
      throw new ListTruncatedError({
        vendor: VENDOR,
        path,
        items: out.length,
        maxPages: MAX_INDEX_PAGES,
      });
    })();
    const slot = { at: Date.now(), value };
    value.catch(() => {
      slot.at = 0;
    });
    this.indexCache = slot;
    return value;
  }

  private invalidateIndexes(): void {
    this.indexCache = undefined;
  }

  private settings(name: string): Promise<AlSettings> {
    return this.api.search.get(`/1/indexes/${pathEncode(name)}/settings`);
  }

  private async keys(): Promise<AlApiKey[]> {
    const path = "/1/keys";
    const res = await this.api.search.get(path);
    return requireListPage(res?.keys, { vendor: VENDOR, path, key: "keys", page: res });
  }

  /**
   * The document's `/3` route, or the deprecated `/2` one when `/3` turns the request down,
   * which it does before doing anything. No live call has confirmed `/3` for every
   * application, so `/2` stays until the document drops it, which fails plugingen's check.
   * Anything else, a 5xx above all, may have taken effect, so it is never sent twice.
   */
  private abTestRoute<T>(v3: () => Promise<T>, v2: () => Promise<T>): Promise<T> {
    return v3().catch((e: unknown) => {
      if (isStatus(e, ...AB_TEST_V3_REFUSED)) return v2();
      throw e;
    });
  }

  /** Every A/B test: `offset` and `limit`, up to the `total` each page reports. */
  private async abTestRows(): Promise<AlAbTest[]> {
    let path: "/3/abtests" | "/2/abtests" = "/3/abtests";
    const v3 = (offset: number): Promise<AlAbTestPage> =>
      this.api.abTests.get("/3/abtests", { query: { offset, limit: AB_TEST_PAGE_SIZE } });
    const v2 = (offset: number): Promise<AlAbTestPage> =>
      this.api.abTestsV2.get("/2/abtests", { query: { offset, limit: AB_TEST_PAGE_SIZE } });
    const first = () =>
      this.abTestRoute(
        () => v3(0),
        () => {
          path = "/2/abtests";
          return v2(0);
        },
      ).catch((e: unknown) => {
        // The document's answer for a plan without A/B testing: there are none to read.
        if (isStatus(e, 402)) return null;
        // The analytics ACL missing, or neither route answering, says nothing about what
        // exists, so the stored tests stay. A host that keeps no track shows the refusal.
        if (isStatus(e, 403, ...AB_TEST_V3_REFUSED) && reportUnreadListPart({ idPrefixes: [""] }))
          return null;
        throw e;
      });
    const out: AlAbTest[] = [];
    for (let page = 0; page < MAX_AB_TEST_PAGES; page++) {
      const res =
        page === 0
          ? await first()
          : await (path === "/3/abtests" ? v3(out.length) : v2(out.length));
      if (res === null) return [];
      const rows = requireListPage(res?.abtests, {
        vendor: VENDOR,
        path,
        key: "abtests",
        page: res,
      });
      out.push(...rows);
      if (!rows.length || out.length >= res.total) return out;
    }
    throw new ListTruncatedError({
      vendor: VENDOR,
      path,
      items: out.length,
      maxPages: MAX_AB_TEST_PAGES,
    });
  }

  /** Every crawler of this application, by page. */
  private async crawlerRows(): Promise<AlCrawlerRow[]> {
    const path = "/1/crawlers";
    const out: AlCrawlerRow[] = [];
    for (let page = 1; page <= MAX_CRAWLER_PAGES; page++) {
      const res = await this.api.crawler
        .get(path, {
          query: { appID: this.api.creds.appId, page, itemsPerPage: CRAWLER_PAGE_SIZE },
        })
        .catch((e: unknown) => {
          if (page > 1) throw e;
          // Algolia's reference: a 404 here is "does not have results for this combination of
          // query params", so an application with no crawlers must not fail. A 404 could also
          // be a moved route, so the stored rows stay rather than being pruned; the desktop
          // prunes nothing, so there it reads as the none it says.
          if (isStatus(e, 404)) {
            reportUnreadListPart({ idPrefixes: [""] });
            return null;
          }
          if (isStatus(e, 403) && reportUnreadListPart({ idPrefixes: [""] })) return null;
          throw e;
        });
      if (res === null) return [];
      // The document makes `items` and `total` optional. Only a stated 0 means none here.
      const rows = requireListPage(res?.items ?? (res?.total === 0 ? [] : undefined), {
        vendor: VENDOR,
        path,
        key: "items",
        page: res,
      });
      out.push(...rows);
      const done =
        res?.total !== undefined ? out.length >= res.total : rows.length < CRAWLER_PAGE_SIZE;
      if (done || !rows.length) return out;
    }
    throw new ListTruncatedError({
      vendor: VENDOR,
      path,
      items: out.length,
      maxPages: MAX_CRAWLER_PAGES,
    });
  }

  private async keyByFingerprint(fp: string): Promise<AlApiKey> {
    const key = (await this.keys()).find((k) => keyFingerprint(k.value) === fp);
    if (!key) {
      throw Object.assign(new Error("Algolia plugin: API key not found"), { status: 404 });
    }
    return key;
  }

  /** Clusters the application runs on (Monitoring API key only). */
  private async clusters(): Promise<string[]> {
    if (!this.api.creds.monitoringApiKey) return [];
    const res = await this.api.monitoring.get("/1/inventory/servers").catch(() => undefined);
    return [...new Set((res?.inventory ?? []).map((s) => s.cluster ?? "").filter(Boolean))].sort();
  }

  // ── Listing ──────────────────────────────────────────────────────────

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "application":
          return [await this.application(accountId)];
        case "index": {
          const indexes = await this.indexes();
          // Settings feed the edit form; large applications get them for the first indices only.
          const settings = await mapLimit(indexes.slice(0, MAX_SETTINGS_FETCH), FAN_OUT, (i) =>
            this.settings(i.name).catch((e: unknown) => {
              // A key without the settings ACL, or an index deleted since the list. Anything
              // else would blank the stored settings for a sync, so it fails the type instead.
              if (isStatus(e, 403, 404)) return undefined;
              throw e;
            }),
          );
          return indexes.map((i, n) => mapIndex(i, settings[n], accountId));
        }
        case "api-key":
          return (await this.keys()).map((k) => mapApiKey(k, accountId));
        case "ab-test":
          return (await this.abTestRows()).map((t) => mapAbTest(t, accountId));
        case "crawler": {
          if (!this.api.hasCrawler) return [];
          const crawlers = await mapLimit(await this.crawlerRows(), FAN_OUT, async (c) => {
            const full = await this.api.crawler
              .get(`/1/crawlers/${pathEncode(c.id)}`, { query: { withConfig: true } })
              .catch((e: unknown) => {
                // The list named it a moment ago, so it has been deleted since.
                if (isStatus(e, 404)) return null;
                // No status can be told without the detail, and mapping the row alone would
                // call it paused. One refused crawler keeps its stored row; the rest still read.
                const row = `${accountId}:crawler:${c.id}`;
                if (isStatus(e, 400, 403) && reportUnreadListPart({ idPrefixes: [row] }))
                  return null;
                throw e;
              });
            return full && mapCrawler(c.id, full, accountId);
          });
          return crawlers.filter((crawler) => crawler !== null);
        }
        default:
          throw new Error(`Algolia plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async application(accountId: string): Promise<ResourceInstance> {
    const [indexes, keys, clusters] = await Promise.all([
      this.indexes(),
      this.keys().catch((err): AlApiKey[] => {
        rethrowIncompleteList(err);
        return [];
      }),
      this.clusters(),
    ]);
    const primaries = indexes.filter((i) => !i.primary);
    const appId = this.api.creds.appId;
    return makeInstance({
      accountId,
      typeId: "application",
      externalId: APPLICATION_EXTERNAL_ID,
      displayName: appId,
      fields: {
        appId,
        indexCount: indexes.length,
        records: primaries.reduce((s, i) => s + (i.entries ?? 0), 0),
        dataSize: indexes.reduce((s, i) => s + (i.dataSize ?? 0), 0),
        apiKeyCount: keys.length,
        region: clusters.join(", "),
      },
      outputs: { appId, searchHost: `${appId.toLowerCase()}-dsn.algolia.net` },
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      switch (typeId) {
        case "index": {
          const [list, settings] = await Promise.all([this.indexes(), this.settings(id)]);
          const meta = list.find((i) => i.name === id) ?? { name: id };
          return mapIndex(meta, settings, accountId);
        }
        case "api-key":
          return mapApiKey(await this.keyByFingerprint(id), accountId);
        case "ab-test":
          return mapAbTest(
            await this.abTestRoute<AlAbTest>(
              () => this.api.abTests.get(`/3/abtests/${pathEncode(id)}`),
              () => this.api.abTestsV2.get(`/2/abtests/${pathEncode(id)}`),
            ),
            accountId,
          );
        case "crawler":
          return mapCrawler(
            id,
            await this.api.crawler.get(`/1/crawlers/${pathEncode(id)}`, {
              query: { withConfig: true },
            }),
            accountId,
          );
        default: {
          const all = await runPluginEffect(this.listResources(typeId, accountId));
          const found = all.find((r) => r.id === resourceId || r.externalId === id);
          if (!found) throw new Error(`Algolia plugin: ${typeId} ${id} not found`);
          return found;
        }
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "application" && outputKey === "adminApiKey") return this.api.creds.apiKey;
      if (typeId === "api-key" && outputKey === "apiKey") {
        return (await this.keyByFingerprint(externalOf(resourceId))).value;
      }
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      return r.resolvedOutputs[outputKey] ?? "";
    });
  }

  // ── Detail ───────────────────────────────────────────────────────────

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const fields = { ...resource.fields };
      const id = resource.externalId ?? externalOf(resource.id);
      const end = Date.now();
      const range = { startDate: day(end - 7 * DAY_MS), endDate: day(end) };
      if (resource.resourceTypeId === "application") {
        const sources = await this.api.search.get("/1/security/sources").catch(() => []);
        if (sources.length) {
          fields[ENRICH_SOURCES] = JSON.stringify(
            sources.map((s) => ({ source: s.source, description: s.description ?? "" })),
          );
          fields["allowedSources"] = sources.map((s) => s.source).join(", ");
        }
      } else if (resource.resourceTypeId === "index") {
        const [syn, rules, top, none, list] = await Promise.all([
          this.api.search
            .post(`/1/indexes/${pathEncode(id)}/synonyms/search`, {
              body: { query: "", hitsPerPage: 1 },
            })
            .catch(() => undefined),
          this.api.search
            .post(`/1/indexes/${pathEncode(id)}/rules/search`, {
              body: { query: "", hitsPerPage: 1 },
            })
            .catch(() => undefined),
          this.api.analytics
            .get("/2/searches", {
              query: { index: id, limit: 10, ...range },
            })
            .catch(() => undefined),
          this.api.analytics
            .get("/2/searches/noResults", {
              query: { index: id, limit: 10, ...range },
            })
            .catch(() => undefined),
          this.indexes().catch((): AlIndex[] => []),
        ]);
        if (syn?.nbHits !== undefined) fields["synonymCount"] = syn.nbHits;
        if (rules?.nbHits !== undefined) fields["ruleCount"] = rules.nbHits;
        if (top?.searches?.length) {
          fields[ENRICH_TOP_SEARCHES] = JSON.stringify(
            top.searches.map((s) => ({
              search: s.search || "(empty)",
              count: String(s.count ?? 0),
              hits: String(s.nbHits ?? ""),
            })),
          );
        }
        if (none?.searches?.length) {
          fields[ENRICH_NO_RESULTS] = JSON.stringify(
            none.searches.map((s) => ({
              search: s.search || "(empty)",
              count: String(s.count ?? 0),
            })),
          );
        }
        fields[ENRICH_INDEXES] = JSON.stringify(list.map((i) => i.name));
      } else if (resource.resourceTypeId === "crawler") {
        const request = this.api.crawler.get(`/1/crawlers/${pathEncode(id)}/stats/urls`);
        // Missing credentials fail the detail, where a failed request only loses the stats.
        const stats = await (this.api.hasCrawler ? request.catch(() => undefined) : request);
        if (stats) {
          fields["crawledUrls"] = stats.count ?? 0;
          fields[ENRICH_CRAWL_STATS] = JSON.stringify(
            (stats.data ?? []).map((d) => ({
              status: d.status ?? "",
              reason: d.reason ?? "",
              count: String(d.count ?? 0),
            })),
          );
        }
      }
      return { ...resource, fields };
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderAlgoliaDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderAlgoliaSidebarItem(resource);
  }

  /** Full index settings as JSON, for the manifest editor. */
  getManifest(resourceId: string): PluginEffect<string> {
    return attempt(async () => {
      return JSON.stringify(await this.settings(externalOf(resourceId)), null, 2);
    });
  }

  applyManifest(resourceId: string, _accountId: string, manifest: string): PluginEffect<void> {
    return attempt(async () => {
      let settings: unknown;
      try {
        settings = JSON.parse(manifest);
      } catch {
        throw new Error("Settings must be a JSON object.");
      }
      if (!isSettingsObject(settings)) {
        throw new Error("Settings must be a JSON object.");
      }
      await this.api.search.put(`/1/indexes/${pathEncode(externalOf(resourceId))}/settings`, {
        body: settings,
      });
      this.invalidateIndexes();
    });
  }

  // ── Create ───────────────────────────────────────────────────────────

  private async indexOptions(primaryOnly = false) {
    const list = await this.indexes().catch((): AlIndex[] => []);
    return list
      .filter((i) => !primaryOnly || !i.primary)
      .map((i) => ({ id: i.name, label: i.name, description: `${i.entries ?? 0} records` }));
  }

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case "index":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true, placeholder: "products" },
              {
                key: "copyFrom",
                label: "Start from",
                kind: "select",
                required: false,
                defaultValue: "",
                options: [
                  { id: "", label: "Empty index with the settings below" },
                  ...(await this.indexOptions()).map((o) => ({
                    ...o,
                    label: `Settings of ${o.label}`,
                  })),
                ],
                description:
                  "Copying another index's configuration copies settings, synonyms and rules, not records",
              },
              {
                key: "searchableAttributes",
                label: "Searchable attributes",
                kind: "string-list",
                required: false,
                placeholder: "title",
                showWhen: { fieldKey: "copyFrom", fieldValue: "" },
              },
              {
                key: "attributesForFaceting",
                label: "Facets",
                kind: "string-list",
                required: false,
                placeholder: "searchable(brand)",
                showWhen: { fieldKey: "copyFrom", fieldValue: "" },
              },
              {
                key: "customRanking",
                label: "Custom ranking",
                kind: "string-list",
                required: false,
                placeholder: "desc(popularity)",
                showWhen: { fieldKey: "copyFrom", fieldValue: "" },
              },
            ],
          };
        case "api-key":
          return {
            fields: [
              {
                key: "description",
                label: "Description",
                kind: "text",
                required: true,
                placeholder: "Storefront search",
              },
              {
                key: "acl",
                label: "Permissions",
                kind: "policy-picker",
                required: true,
                policies: ACLS.map((a) => ({ id: a, label: a, description: ACL_LABELS[a] ?? "" })),
              },
              {
                key: "indexes",
                label: "Restrict to indices",
                kind: "policy-picker",
                required: false,
                description: "Leave empty for every index",
                policies: (await this.indexOptions()).map((o) => ({ id: o.id, label: o.label })),
              },
              {
                key: "referers",
                label: "Allowed referrers",
                kind: "string-list",
                required: false,
                placeholder: "https://example.com/*",
              },
              {
                key: "maxQueriesPerIPPerHour",
                label: "Max queries per IP per hour",
                kind: "number",
                required: false,
                minValue: 0,
              },
              {
                key: "maxHitsPerQuery",
                label: "Max hits per query",
                kind: "number",
                required: false,
                minValue: 0,
              },
              {
                key: "expiresAt",
                label: "Expires",
                kind: "datetime",
                datetimeMode: "datetime",
                required: false,
                description: "Leave empty for a key that never expires",
              },
            ],
          };
        case "ab-test": {
          const options = await this.indexOptions(true);
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "indexA",
                label: "Variant A (control)",
                kind: "select",
                required: true,
                options,
              },
              {
                key: "indexB",
                label: "Variant B",
                kind: "select",
                required: true,
                options: (await this.indexOptions()).map((o) => ({ id: o.id, label: o.label })),
                description: "Usually a replica of A with changed settings",
              },
              {
                key: "trafficB",
                label: "Traffic to B (%)",
                kind: "number",
                required: true,
                minValue: 1,
                maxValue: 99,
                defaultValue: "50",
              },
              {
                key: "endAt",
                label: "End",
                kind: "datetime",
                datetimeMode: "datetime",
                required: true,
              },
            ],
          };
        }
        default:
          throw new Error(`Algolia plugin: cannot create "${typeId}"`);
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceCreateReturn> {
    return attempt(async () => {
      switch (typeId) {
        case "index": {
          const name = str(fields["name"]);
          if (!name || name.length > 512 || /^\s|\s$/.test(name))
            throw new Error("Enter an index name.");
          const from = str(fields["copyFrom"]);
          if (from) {
            await this.api.search.post(`/1/indexes/${pathEncode(from)}/operation`, {
              body: {
                operation: "copy",
                destination: name,
                scope: ["settings", "synonyms", "rules"],
              },
            });
          } else {
            await this.api.search.put(`/1/indexes/${pathEncode(name)}/settings`, {
              body: settingsPatch({
                searchableAttributes: fields["searchableAttributes"] ?? "",
                attributesForFaceting: fields["attributesForFaceting"] ?? "",
                customRanking: fields["customRanking"] ?? "",
              }),
            });
          }
          this.invalidateIndexes();
          return mapIndex({ name, entries: 0 }, undefined, accountId);
        }
        case "api-key": {
          const body = this.keyBody(fields);
          if (!body.acl?.length) throw new Error("Pick at least one permission.");
          const res = await this.api.search.post("/1/keys", { body });
          return mapApiKey(
            { ...body, value: res.key, createdAt: Date.parse(res.createdAt ?? "") || Date.now() },
            accountId,
          );
        }
        case "ab-test": {
          const a = str(fields["indexA"]);
          const b = str(fields["indexB"]);
          if (!a || !b || a === b) throw new Error("Choose two different indices.");
          const pct = intField(fields["trafficB"], "Traffic to B", 1) ?? 50;
          if (pct > 99) throw new Error("Traffic to B must be between 1 and 99 percent.");
          const endAt = new Date(str(fields["endAt"]));
          if (Number.isNaN(endAt.getTime()) || endAt.getTime() <= Date.now())
            throw new Error("Choose an end date in the future.");
          const test = {
            name: str(fields["name"]),
            variants: [
              { index: a, trafficPercentage: 100 - pct },
              { index: b, trafficPercentage: pct },
            ],
            endAt: endAt.toISOString(),
          };
          const res = await this.abTestRoute(
            () =>
              this.api.abTests.post("/3/abtests", {
                body: {
                  ...test,
                  metrics: AB_TEST_METRICS,
                  // Left out it means Bayesian, which also requires a primary metric. This
                  // keeps the p-value results a test on `/2` has always had.
                  configuration: { method: "frequentist" },
                },
              }),
            () => this.api.abTestsV2.post("/2/abtests", { body: test }),
          );
          return mapAbTest(
            {
              abTestID: res.abTestID,
              name: str(fields["name"]),
              status: "active",
              endAt: endAt.toISOString(),
              variants: [
                { index: a, trafficPercentage: 100 - pct },
                { index: b, trafficPercentage: pct },
              ],
            },
            accountId,
          );
        }
        default:
          throw new Error(`Algolia plugin: cannot create "${typeId}"`);
      }
    });
  }

  /** API key body from form fields (create) or edited fields merged over the current key (update). */
  private keyBody(fields: Record<string, string>, current?: AlApiKey): AlApiKeyBody {
    const body: AlApiKeyBody = {
      acl: fields["acl"] !== undefined ? parseAcl(fields["acl"]) : (current?.acl ?? []),
    };
    const description =
      fields["description"] !== undefined ? str(fields["description"]) : current?.description;
    if (description) body.description = description;
    const indexes =
      fields["indexes"] !== undefined ? parseList(fields["indexes"]) : current?.indexes;
    if (indexes?.length) body.indexes = indexes;
    const referers =
      fields["referers"] !== undefined ? parseList(fields["referers"]) : current?.referers;
    if (referers?.length) body.referers = referers;
    const qp =
      fields["queryParameters"] !== undefined
        ? str(fields["queryParameters"])
        : current?.queryParameters;
    if (qp) body.queryParameters = qp;
    const maxHits =
      intField(fields["maxHitsPerQuery"], "Max hits per query", 0) ?? current?.maxHitsPerQuery;
    if (maxHits) body.maxHitsPerQuery = maxHits;
    const maxQ =
      intField(fields["maxQueriesPerIPPerHour"], "Max queries per IP per hour", 0) ??
      current?.maxQueriesPerIPPerHour;
    if (maxQ) body.maxQueriesPerIPPerHour = maxQ;
    if (fields["expiresAt"]) {
      const at = Date.parse(fields["expiresAt"]);
      if (!Number.isFinite(at) || at <= Date.now())
        throw new Error("Choose an expiry in the future.");
      const created = current?.createdAt ?? Date.now();
      body.validity = Math.round((at - created) / 1000);
    } else {
      const validity = intField(fields["validity"], "Validity", 0) ?? current?.validity;
      if (validity) body.validity = validity;
    }
    return body;
  }

  // ── Update ───────────────────────────────────────────────────────────

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      switch (typeId) {
        case "index": {
          const patch = settingsPatch(fields);
          if (Object.keys(patch).length) {
            await this.api.search.put(`/1/indexes/${pathEncode(id)}/settings`, {
              query: { forwardToReplicas: false },
              body: patch,
            });
            this.invalidateIndexes();
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "api-key": {
          const current = await this.keyByFingerprint(id);
          const body = this.keyBody(fields, current);
          if (!body.acl?.length) throw new Error("An API key needs at least one permission.");
          await this.api.search.put(`/1/keys/${pathEncode(current.value)}`, { body });
          return mapApiKey({ ...current, ...body }, accountId);
        }
        default:
          throw new Error(`Algolia plugin: cannot update "${typeId}"`);
      }
    });
  }

  // ── Delete ───────────────────────────────────────────────────────────

  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      switch (typeId) {
        case "index":
          await this.api.search.delete(`/1/indexes/${pathEncode(id)}`);
          this.invalidateIndexes();
          return;
        case "api-key": {
          const key = await this.keyByFingerprint(id);
          await this.api.search.delete(`/1/keys/${pathEncode(key.value)}`);
          return;
        }
        case "ab-test":
          await this.abTestRoute<unknown>(
            () => this.api.abTests.delete(`/3/abtests/${pathEncode(id)}`),
            () => this.api.abTestsV2.delete(`/2/abtests/${pathEncode(id)}`),
          );
          return;
        case "crawler":
          await this.api.crawler.delete(`/1/crawlers/${pathEncode(id)}`);
          return;
        default:
          throw new Error(`Algolia plugin: cannot delete "${typeId}"`);
      }
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────

  invokeAction(typeId: string, resourceId: string, actionId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      if (typeId === "index" && actionId === "clear") {
        await this.api.search.post(`/1/indexes/${pathEncode(id)}/clear`);
        return;
      }
      if (typeId === "ab-test" && actionId === "stop") {
        await this.abTestRoute<unknown>(
          () => this.api.abTests.post(`/3/abtests/${pathEncode(id)}/stop`),
          () => this.api.abTestsV2.post(`/2/abtests/${pathEncode(id)}/stop`),
        );
        return;
      }
      if (
        typeId === "crawler" &&
        (actionId === "run" || actionId === "pause" || actionId === "reindex")
      ) {
        await this.api.crawler.post(`/1/crawlers/${pathEncode(id)}/${actionId}`);
        return;
      }
      throw new Error(`Algolia plugin: action "${actionId}" is not supported for "${typeId}"`);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      const vals = parseFormArg(args[0]);
      if (typeId === "index" && (command === "copyIndex" || command === "moveIndex")) {
        const destination = str(vals["destination"]);
        if (!destination || destination === id)
          throw new Error("Choose a different destination index.");
        const scope =
          command === "copyIndex" && vals["scope"] && vals["scope"] !== "all"
            ? splitList(vals["scope"])
            : undefined;
        await this.api.search.post(`/1/indexes/${pathEncode(id)}/operation`, {
          body: {
            operation: command === "copyIndex" ? "copy" : "move",
            destination,
            ...(scope ? { scope } : {}),
          },
        });
        this.invalidateIndexes();
        return null;
      }
      throw new Error(`Algolia plugin: unknown command "${command}"`);
    });
  }

  // ── Logs ─────────────────────────────────────────────────────────────

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      const types = ["all", "query", "build", "error"] as const;
      const type = types.find((t) => t === params.container) ?? "all";
      const res = await this.api.search.get("/1/logs", {
        query: {
          length: Math.min(Math.max(params.tailLines ?? 100, 1), 1000),
          type,
          ...(typeId === "index" ? { indexName: externalOf(resourceId) } : {}),
        },
      });
      const lines = (res?.logs ?? [])
        .slice()
        .reverse()
        .map(
          (l) =>
            `${l.timestamp ?? ""} ${l.method ?? ""} ${l.url ?? ""} ${l.answer_code ?? ""} ${l.processing_time_ms ?? "?"}ms` +
            `${l.index ? ` index=${l.index}` : ""}${l.query_nb_hits ? ` hits=${l.query_nb_hits}` : ""} ip=${l.ip ?? ""}\n`,
        );
      return { text: lines.join(""), containers: [...types], activeContainer: type };
    });
  }

  // ── Metrics ──────────────────────────────────────────────────────────

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const end = timeRange?.endMs ?? Date.now();
      const start = timeRange?.startMs ?? end - 7 * DAY_MS;
      const hourly = end - start <= 7 * DAY_MS;
      const usageQuery = {
        startDate: new Date(start).toISOString(),
        endDate: new Date(end).toISOString(),
        granularity: hourly ? "hourly" : "daily",
      };
      if (resourceTypeId === "application") {
        const [usage, monitoring] = await Promise.all([
          this.api.creds.usageApiKey
            ? this.api.usage
                .get(`/1/usage/${unencodedSegment(Object.keys(APP_USAGE).join(","))}`, {
                  query: usageQuery,
                })
                .then((r) => usageSeries(r, APP_USAGE))
                .catch((): MetricSeries[] => [])
            : Promise.resolve<MetricSeries[]>([]),
          this.monitoringSeries(),
        ]);
        return [...usage, ...monitoring];
      }
      if (resourceTypeId === "index") {
        const index = externalOf(resourceId);
        const [usage, analytics] = await Promise.all([
          this.api.creds.usageApiKey
            ? this.api.usage
                .get(
                  `/1/usage/${unencodedSegment(Object.keys(INDEX_USAGE).join(","))}/${pathEncode(index)}`,
                  {
                    query: usageQuery,
                  },
                )
                .then((r) => usageSeries(r, INDEX_USAGE))
                .catch((): MetricSeries[] => [])
            : Promise.resolve<MetricSeries[]>([]),
          this.analyticsSeries(index, day(start), day(end)),
        ]);
        return [...usage, ...analytics];
      }
      return [];
    });
  }

  private async monitoringSeries(): Promise<MetricSeries[]> {
    const clusters = await this.clusters();
    if (!clusters.length) return [];
    const list = unencodedSegment(clusters.join(","));
    const [latency, indexing] = await Promise.all([
      this.api.monitoring.get(`/1/latency/${list}`).catch(() => undefined),
      this.api.monitoring.get(`/1/indexing/${list}`).catch(() => undefined),
    ]);
    const out: MetricSeries[] = [];
    for (const [cluster, pts] of Object.entries(latency?.metrics?.latency ?? {})) {
      out.push({
        label: `Search Latency (${cluster})`,
        unit: "ms",
        points: pts.map((p) => ({ timestamp: p.t, value: Number(p.v) })),
      });
    }
    for (const [cluster, pts] of Object.entries(indexing?.metrics?.indexing ?? {})) {
      out.push({
        label: `Indexing Time (${cluster})`,
        unit: "ms",
        points: pts.map((p) => ({ timestamp: p.t, value: Number(p.v) })),
      });
    }
    return out;
  }

  /** Daily search analytics for one index. Empty when the key lacks the analytics ACL. */
  private async analyticsSeries(
    index: string,
    startDate: string,
    endDate: string,
  ): Promise<MetricSeries[]> {
    const query = { index, startDate, endDate };
    const { analytics } = this.api;
    const [searches, users, noResult, ctr] = await Promise.all([
      analytics.get("/2/searches/count", { query }).catch(() => undefined),
      analytics.get("/2/users/count", { query }).catch(() => undefined),
      analytics.get("/2/searches/noResultRate", { query }).catch(() => undefined),
      analytics.get("/2/clicks/clickThroughRate", { query }).catch(() => undefined),
    ]);
    const series = (
      label: string,
      unit: string,
      dates: Array<{ date: string; value: number | null | undefined }> | undefined,
      scale = 1,
    ) => {
      const points = (dates ?? [])
        .flatMap(({ date, value }) =>
          value === null || value === undefined
            ? []
            : [{ timestamp: Date.parse(`${date}T00:00:00Z`), value: value * scale }],
        )
        .filter((p) => Number.isFinite(p.timestamp));
      return points.length ? [{ label, unit, points }] : [];
    };
    return [
      ...series(
        "Searches (analytics)",
        "searches",
        searches?.dates?.map((d) => ({ date: d.date, value: d.count })),
      ),
      ...series(
        "Users",
        "users",
        users?.dates?.map((d) => ({ date: d.date, value: d.count })),
      ),
      ...series(
        "No-Result Rate",
        "%",
        noResult?.dates?.map((d) => ({ date: d.date, value: d.rate })),
        100,
      ),
      ...series(
        "Click-Through Rate",
        "%",
        ctr?.dates?.map((d) => ({ date: d.date, value: d.rate })),
        100,
      ),
    ];
  }
}

/** The document leaves every setting optional, so any object is one to Algolia to judge. */
function isSettingsObject(value: unknown): value is AlSettingsPatch {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export { errorText };
