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
import { withMetricsCapability } from "@infrawrench/plugin-base";
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
  AlApiKey,
  AlCrawler,
  AlIndex,
  AlLogEntry,
  AlSettings,
  AlSource,
  AlUsagePoint,
} from "./types.js";

const INDEX_TTL_MS = 30_000;
const FAN_OUT = 6;
const MAX_SETTINGS_FETCH = 150;
const DAY_MS = 86_400_000;

export const KEY_VALUE_FIELD = "apiKey";

const enc = encodeURIComponent;

function str(v: unknown): string {
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
    const parsed = JSON.parse(raw) as Record<string, unknown>;
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
      return (JSON.parse(t) as unknown[]).map((x) => String(x).trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return splitList(t);
}

export function parseAcl(raw: string | undefined): string[] {
  const acl = [...new Set(parseList(raw))];
  const bad = acl.filter((a) => !ACLS.includes(a));
  if (bad.length) throw new Error(`Unknown ACL ${bad.join(", ")}. Use any of: ${ACLS.join(", ")}.`);
  return acl;
}

const LIST_SETTINGS: Record<string, string> = {
  searchableAttributes: "searchableAttributes",
  customRanking: "customRanking",
  attributesForFaceting: "attributesForFaceting",
  attributesToRetrieve: "attributesToRetrieve",
  unretrievableAttributes: "unretrievableAttributes",
  queryLanguages: "queryLanguages",
  indexLanguages: "indexLanguages",
  replicas: "replicas",
};

/** Edited fields (form spelling) to an Algolia settings patch. */
export function settingsPatch(fields: Record<string, string>): AlSettings {
  const patch: AlSettings = {};
  for (const [field, setting] of Object.entries(LIST_SETTINGS)) {
    if (fields[field] !== undefined) patch[setting] = splitList(fields[field]);
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
    credentials: Record<string, string>,
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
      const out: AlIndex[] = [];
      for (let page = 0; page < 50; page++) {
        const res = await this.api.search<{ items?: AlIndex[]; nbPages?: number }>("/1/indexes", {
          query: { page, hitsPerPage: 1000 },
        });
        out.push(...(res?.items ?? []));
        if (!res?.nbPages || page + 1 >= res.nbPages) break;
      }
      return out;
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
    return this.api.search<AlSettings>(`/1/indexes/${enc(name)}/settings`);
  }

  private async keys(): Promise<AlApiKey[]> {
    const res = await this.api.search<{ keys?: AlApiKey[] }>("/1/keys");
    return res?.keys ?? [];
  }

  private async keyByFingerprint(fp: string): Promise<AlApiKey> {
    const key = (await this.keys()).find((k) => keyFingerprint(k.value) === fp);
    if (!key) {
      const err = new Error("Algolia plugin: API key not found") as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return key;
  }

  /** Clusters the application runs on (Monitoring API key only). */
  private async clusters(): Promise<string[]> {
    if (!this.api.creds.monitoringApiKey) return [];
    const res = await this.api
      .monitoring<{ inventory?: Array<{ cluster?: string }> }>("/1/inventory/servers")
      .catch(() => undefined);
    return [...new Set((res?.inventory ?? []).map((s) => s.cluster ?? "").filter(Boolean))].sort();
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "application":
        return [await this.application(accountId)];
      case "index": {
        const indexes = await this.indexes();
        // Settings feed the edit form; large applications get them for the first indices only.
        const settings = await mapLimit(indexes.slice(0, MAX_SETTINGS_FETCH), FAN_OUT, (i) =>
          this.settings(i.name).catch(() => undefined),
        );
        return indexes.map((i, n) => mapIndex(i, settings[n], accountId));
      }
      case "api-key":
        return (await this.keys()).map((k) => mapApiKey(k, accountId));
      case "ab-test": {
        try {
          const res = await this.api.analytics<{ abtests?: AlAbTest[] | null }>("/2/abtests", {
            query: { limit: 100 },
          });
          return (res?.abtests ?? []).map((t) => mapAbTest(t, accountId));
        } catch (e) {
          // A/B testing needs a plan that includes it and the analytics ACL.
          if (isStatus(e, 400, 401, 403, 404)) return [];
          throw e;
        }
      }
      case "crawler": {
        if (!this.api.hasCrawler) return [];
        const res = await this.api.crawler<{ items?: Array<{ id: string; name?: string }> }>(
          "/1/crawlers",
          {
            query: { appID: this.api.creds.appId, itemsPerPage: 100 },
          },
        );
        const crawlers = await mapLimit(res?.items ?? [], FAN_OUT, async (c) => {
          const full = await this.api
            .crawler<AlCrawler>(`/1/crawlers/${enc(c.id)}`, { query: { withConfig: true } })
            .catch(() => ({ name: c.name }) as AlCrawler);
          return mapCrawler(c.id, full, accountId);
        });
        return crawlers;
      }
      default:
        throw new Error(`Algolia plugin: unknown resource type "${typeId}"`);
    }
  }

  private async application(accountId: string): Promise<ResourceInstance> {
    const [indexes, keys, clusters] = await Promise.all([
      this.indexes(),
      this.keys().catch(() => [] as AlApiKey[]),
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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
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
        return mapAbTest(await this.api.analytics<AlAbTest>(`/2/abtests/${enc(id)}`), accountId);
      case "crawler":
        return mapCrawler(
          id,
          await this.api.crawler<AlCrawler>(`/1/crawlers/${enc(id)}`, {
            query: { withConfig: true },
          }),
          accountId,
        );
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.id === resourceId || r.externalId === id);
        if (!found) throw new Error(`Algolia plugin: ${typeId} ${id} not found`);
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "application" && outputKey === "adminApiKey") return this.api.creds.apiKey;
    if (typeId === "api-key" && outputKey === "apiKey") {
      return (await this.keyByFingerprint(externalOf(resourceId))).value;
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    return r.resolvedOutputs[outputKey] ?? "";
  }

  // ── Detail ───────────────────────────────────────────────────────────

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const fields = { ...resource.fields };
    const id = resource.externalId ?? externalOf(resource.id);
    const end = Date.now();
    const range = { startDate: day(end - 7 * DAY_MS), endDate: day(end) };
    if (resource.resourceTypeId === "application") {
      const sources = await this.api
        .search<AlSource[]>("/1/security/sources")
        .catch(() => [] as AlSource[]);
      if (sources.length) {
        fields[ENRICH_SOURCES] = JSON.stringify(
          sources.map((s) => ({ source: s.source, description: s.description ?? "" })),
        );
        fields["allowedSources"] = sources.map((s) => s.source).join(", ");
      }
    } else if (resource.resourceTypeId === "index") {
      const [syn, rules, top, none, list] = await Promise.all([
        this.api
          .search<{ nbHits?: number }>(`/1/indexes/${enc(id)}/synonyms/search`, {
            method: "POST",
            body: { query: "", hitsPerPage: 1 },
          })
          .catch(() => undefined),
        this.api
          .search<{ nbHits?: number }>(`/1/indexes/${enc(id)}/rules/search`, {
            method: "POST",
            body: { query: "", hitsPerPage: 1 },
          })
          .catch(() => undefined),
        this.api
          .analytics<{ searches?: Array<{ search?: string; count?: number; nbHits?: number }> }>(
            "/2/searches",
            {
              query: { index: id, limit: 10, ...range },
            },
          )
          .catch(() => undefined),
        this.api
          .analytics<{ searches?: Array<{ search?: string; count?: number }> }>(
            "/2/searches/noResults",
            {
              query: { index: id, limit: 10, ...range },
            },
          )
          .catch(() => undefined),
        this.indexes().catch(() => [] as AlIndex[]),
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
      const stats = await this.api
        .crawler<{
          count?: number;
          data?: Array<{ reason?: string; status?: string; count?: number }>;
        }>(`/1/crawlers/${enc(id)}/stats/urls`)
        .catch(() => undefined);
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
  async getManifest(resourceId: string): Promise<string> {
    return JSON.stringify(await this.settings(externalOf(resourceId)), null, 2);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    let settings: unknown;
    try {
      settings = JSON.parse(manifest);
    } catch {
      throw new Error("Settings must be a JSON object.");
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Settings must be a JSON object.");
    }
    await this.api.search(`/1/indexes/${enc(externalOf(resourceId))}/settings`, {
      method: "PUT",
      body: settings,
    });
    this.invalidateIndexes();
  }

  // ── Create ───────────────────────────────────────────────────────────

  private async indexOptions(primaryOnly = false) {
    const list = await this.indexes().catch(() => [] as AlIndex[]);
    return list
      .filter((i) => !primaryOnly || !i.primary)
      .map((i) => ({ id: i.name, label: i.name, description: `${i.entries ?? 0} records` }));
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
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
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceCreateReturn> {
    switch (typeId) {
      case "index": {
        const name = str(fields["name"]);
        if (!name || name.length > 512 || /^\s|\s$/.test(name))
          throw new Error("Enter an index name.");
        const from = str(fields["copyFrom"]);
        if (from) {
          await this.api.search(`/1/indexes/${enc(from)}/operation`, {
            method: "POST",
            body: {
              operation: "copy",
              destination: name,
              scope: ["settings", "synonyms", "rules"],
            },
          });
        } else {
          await this.api.search(`/1/indexes/${enc(name)}/settings`, {
            method: "PUT",
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
        const res = await this.api.search<{ key: string; createdAt?: string }>("/1/keys", {
          method: "POST",
          body,
        });
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
        const res = await this.api.analytics<{ abTestID: number }>("/2/abtests", {
          method: "POST",
          body: {
            name: str(fields["name"]),
            variants: [
              { index: a, trafficPercentage: 100 - pct },
              { index: b, trafficPercentage: pct },
            ],
            endAt: endAt.toISOString(),
          },
        });
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
  }

  /** API key body from form fields (create) or edited fields merged over the current key (update). */
  private keyBody(fields: Record<string, string>, current?: AlApiKey): Omit<AlApiKey, "value"> {
    const body: Omit<AlApiKey, "value"> = {
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

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "index": {
        const patch = settingsPatch(fields);
        if (Object.keys(patch).length) {
          await this.api.search(`/1/indexes/${enc(id)}/settings`, {
            method: "PUT",
            query: { forwardToReplicas: false },
            body: patch,
          });
          this.invalidateIndexes();
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "api-key": {
        const current = await this.keyByFingerprint(id);
        const body = this.keyBody(fields, current);
        if (!body.acl?.length) throw new Error("An API key needs at least one permission.");
        await this.api.search(`/1/keys/${enc(current.value)}`, { method: "PUT", body });
        return mapApiKey({ ...current, ...body }, accountId);
      }
      default:
        throw new Error(`Algolia plugin: cannot update "${typeId}"`);
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "index":
        await this.api.search(`/1/indexes/${enc(id)}`, { method: "DELETE" });
        this.invalidateIndexes();
        return;
      case "api-key": {
        const key = await this.keyByFingerprint(id);
        await this.api.search(`/1/keys/${enc(key.value)}`, { method: "DELETE" });
        return;
      }
      case "ab-test":
        await this.api.analytics(`/2/abtests/${enc(id)}`, { method: "DELETE" });
        return;
      case "crawler":
        await this.api.crawler(`/1/crawlers/${enc(id)}`, { method: "DELETE" });
        return;
      default:
        throw new Error(`Algolia plugin: cannot delete "${typeId}"`);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const id = externalOf(resourceId);
    if (typeId === "index" && actionId === "clear") {
      await this.api.search(`/1/indexes/${enc(id)}/clear`, { method: "POST" });
      return;
    }
    if (typeId === "ab-test" && actionId === "stop") {
      await this.api.analytics(`/2/abtests/${enc(id)}/stop`, { method: "POST" });
      return;
    }
    if (typeId === "crawler" && ["run", "pause", "reindex"].includes(actionId)) {
      await this.api.crawler(`/1/crawlers/${enc(id)}/${actionId}`, { method: "POST" });
      return;
    }
    throw new Error(`Algolia plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
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
      await this.api.search(`/1/indexes/${enc(id)}/operation`, {
        method: "POST",
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
  }

  // ── Logs ─────────────────────────────────────────────────────────────

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const types = ["all", "query", "build", "error"];
    const type = params.container && types.includes(params.container) ? params.container : "all";
    const res = await this.api.search<{ logs?: AlLogEntry[] }>("/1/logs", {
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
    return { text: lines.join(""), containers: types, activeContainer: type };
  }

  // ── Metrics ──────────────────────────────────────────────────────────

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
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
          ? this.api
              .usage<Record<string, AlUsagePoint[]>>(
                `/1/usage/${Object.keys(APP_USAGE).join(",")}`,
                { query: usageQuery },
              )
              .then((r) => usageSeries(r, APP_USAGE))
              .catch(() => [] as MetricSeries[])
          : Promise.resolve([] as MetricSeries[]),
        this.monitoringSeries(),
      ]);
      return [...usage, ...monitoring];
    }
    if (resourceTypeId === "index") {
      const index = externalOf(resourceId);
      const [usage, analytics] = await Promise.all([
        this.api.creds.usageApiKey
          ? this.api
              .usage<Record<string, AlUsagePoint[]>>(
                `/1/usage/${Object.keys(INDEX_USAGE).join(",")}/${enc(index)}`,
                {
                  query: usageQuery,
                },
              )
              .then((r) => usageSeries(r, INDEX_USAGE))
              .catch(() => [] as MetricSeries[])
          : Promise.resolve([] as MetricSeries[]),
        this.analyticsSeries(index, day(start), day(end)),
      ]);
      return [...usage, ...analytics];
    }
    return [];
  }

  private async monitoringSeries(): Promise<MetricSeries[]> {
    const clusters = await this.clusters();
    if (!clusters.length) return [];
    const list = clusters.join(",");
    const [latency, indexing] = await Promise.all([
      this.api
        .monitoring<{ metrics?: { latency?: Record<string, AlUsagePoint[]> } }>(
          `/1/latency/${list}`,
        )
        .catch(() => undefined),
      this.api
        .monitoring<{ metrics?: { indexing?: Record<string, AlUsagePoint[]> } }>(
          `/1/indexing/${list}`,
        )
        .catch(() => undefined),
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
    const q = { index, startDate, endDate };
    const get = <T>(path: string) =>
      this.api.analytics<T>(path, { query: q }).catch(() => undefined);
    const [searches, users, noResult, ctr] = await Promise.all([
      get<{ dates?: Array<{ date: string; count: number }> }>("/2/searches/count"),
      get<{ dates?: Array<{ date: string; count: number }> }>("/2/users/count"),
      get<{ dates?: Array<{ date: string; rate: number | null }> }>("/2/searches/noResultRate"),
      get<{ dates?: Array<{ date: string; rate: number | null }> }>("/2/clicks/clickThroughRate"),
    ]);
    const series = (
      label: string,
      unit: string,
      dates: Array<{ date: string; value: number | null | undefined }> | undefined,
      scale = 1,
    ) => {
      const points = (dates ?? [])
        .filter((d) => d.value !== null && d.value !== undefined)
        .map((d) => ({
          timestamp: Date.parse(`${d.date}T00:00:00Z`),
          value: (d.value as number) * scale,
        }))
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
