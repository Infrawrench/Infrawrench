import type { ResourceInstance } from "@infrawrench/plugin-base";
import { keyFingerprint } from "./api.js";
import type { AlAbTest, AlApiKey, AlCrawler, AlIndex, AlSettings } from "./types.js";

export const PLUGIN_ID = "algolia";
export const APPLICATION_EXTERNAL_ID = "application";

type Fields = ResourceInstance["fields"];

export function makeInstance(opts: {
  accountId: string;
  typeId: string;
  externalId: string;
  displayName: string;
  fields: Fields;
  outputs?: Record<string, string>;
  parentResourceId?: string;
  createdAt?: string | null | undefined;
}): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${opts.accountId}:${opts.typeId}:${opts.externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: opts.typeId,
    accountId: opts.accountId,
    displayName: opts.displayName,
    fields: opts.fields,
    resolvedOutputs: opts.outputs ?? {},
    secretStates: [],
    externalId: opts.externalId,
    ...(opts.parentResourceId ? { parentResourceId: opts.parentResourceId } : {}),
    createdAt: opts.createdAt || now,
    updatedAt: now,
    lastSyncedAt: now,
  };
}

export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

const join = (v: string[] | null | undefined) => (v ?? []).join(", ");

export function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The settings this plugin surfaces as editable fields, in their field spelling. */
export function settingsFields(s: AlSettings | undefined): Fields {
  if (!s) return {};
  const fields: Fields = {
    searchableAttributes: join(s.searchableAttributes),
    attributesForFaceting: join(s.attributesForFaceting),
    attributesToRetrieve: join(s.attributesToRetrieve),
    unretrievableAttributes: join(s.unretrievableAttributes),
    customRanking: join(s.customRanking),
    queryLanguages: join(s.queryLanguages),
    indexLanguages: join(s.indexLanguages),
    replicas: join(s.replicas),
  };
  if (s.hitsPerPage !== undefined) fields["hitsPerPage"] = s.hitsPerPage;
  if (s.paginationLimitedTo !== undefined) fields["paginationLimitedTo"] = s.paginationLimitedTo;
  if (s.typoTolerance !== undefined) fields["typoTolerance"] = String(s.typoTolerance);
  if (s.distinct !== undefined)
    fields["distinct"] = typeof s.distinct === "boolean" ? (s.distinct ? 1 : 0) : s.distinct;
  if (s.attributeForDistinct) fields["attributeForDistinct"] = s.attributeForDistinct;
  if (s.ignorePlurals !== undefined) fields["ignorePlurals"] = s.ignorePlurals !== false;
  if (s.removeStopWords !== undefined) fields["removeStopWords"] = s.removeStopWords !== false;
  if (s.enableRules !== undefined) fields["enableRules"] = s.enableRules;
  if (s.enablePersonalization !== undefined)
    fields["enablePersonalization"] = s.enablePersonalization;
  if (s.queryType) fields["queryType"] = s.queryType;
  if (s.removeWordsIfNoResults) fields["removeWordsIfNoResults"] = s.removeWordsIfNoResults;
  if (s.mode) fields["mode"] = s.mode;
  return fields;
}

export function mapIndex(
  i: AlIndex,
  settings: AlSettings | undefined,
  accountId: string,
): ResourceInstance {
  const fields: Fields = {
    name: i.name,
    entries: i.entries ?? 0,
    dataSize: i.dataSize ?? 0,
    fileSize: i.fileSize ?? 0,
    lastBuildTimeS: i.lastBuildTimeS ?? 0,
    primary: i.primary ?? "",
    role: i.primary ? (i.virtual ? "virtual replica" : "replica") : "primary",
    abTest: i.abTest?.abTestId !== undefined ? String(i.abTest.abTestId) : "",
    ...settingsFields(settings),
  };
  if (!settings && i.replicas?.length) fields["replicas"] = i.replicas.join(", ");
  if (i.createdAt) fields["createdAt"] = i.createdAt;
  if (i.updatedAt) fields["updatedAt"] = i.updatedAt;
  return makeInstance({
    accountId,
    typeId: "index",
    externalId: i.name,
    displayName: i.name,
    fields,
    outputs: { indexName: i.name },
    createdAt: i.createdAt || undefined,
  });
}

export function mapApiKey(k: AlApiKey, accountId: string): ResourceInstance {
  // `createdAt` is milliseconds since the epoch; `validity` is seconds.
  const created = k.createdAt ? new Date(k.createdAt).toISOString() : "";
  const fields: Fields = {
    description: k.description ?? "",
    acl: join(k.acl),
    indexes: join(k.indexes),
    referers: join(k.referers),
    queryParameters: k.queryParameters ?? "",
    maxHitsPerQuery: k.maxHitsPerQuery ?? 0,
    maxQueriesPerIPPerHour: k.maxQueriesPerIPPerHour ?? 0,
    validity: k.validity ?? 0,
    keyPrefix: `${k.value.slice(0, 4)}…`,
    expiresAt: "",
  };
  if (created) {
    fields["createdAt"] = created;
    if (k.validity && k.validity > 0) {
      fields["expiresAt"] = new Date(k.createdAt! + k.validity * 1000).toISOString();
    }
  }
  const fp = keyFingerprint(k.value);
  return makeInstance({
    accountId,
    typeId: "api-key",
    externalId: fp,
    displayName: k.description || `Key ${k.value.slice(0, 4)}… (${join(k.acl) || "no ACL"})`,
    fields,
    createdAt: created || undefined,
  });
}

export function mapAbTest(t: AlAbTest, accountId: string): ResourceInstance {
  const v = t.variants ?? [];
  const fields: Fields = {
    name: t.name ?? "",
    abTestId: t.abTestID,
    status: t.status ?? "",
    indexA: v[0]?.index ?? "",
    indexB: v[1]?.index ?? "",
    trafficB: v[1]?.trafficPercentage ?? 0,
    endAt: t.endAt ?? "",
  };
  if (t.clickSignificance !== undefined && t.clickSignificance !== null) {
    fields["clickSignificance"] = t.clickSignificance;
  }
  if (t.conversionSignificance !== undefined && t.conversionSignificance !== null) {
    fields["conversionSignificance"] = t.conversionSignificance;
  }
  if (v[0]?.clickThroughRate != null)
    fields["ctrA"] = Math.round(v[0].clickThroughRate * 10000) / 100;
  if (v[1]?.clickThroughRate != null)
    fields["ctrB"] = Math.round(v[1].clickThroughRate * 10000) / 100;
  if (t.createdAt) fields["createdAt"] = t.createdAt;
  if (t.stoppedAt) fields["stoppedAt"] = t.stoppedAt;
  return makeInstance({
    accountId,
    typeId: "ab-test",
    externalId: String(t.abTestID),
    displayName: t.name || `A/B test ${t.abTestID}`,
    fields,
    createdAt: t.createdAt,
  });
}

export function crawlerStatus(c: AlCrawler): string {
  if (c.blocked) return "blocked";
  if (c.reindexing) return "reindexing";
  if (c.running) return "running";
  return "paused";
}

export function mapCrawler(id: string, c: AlCrawler, accountId: string): ResourceInstance {
  const fields: Fields = {
    name: c.name ?? id,
    crawlerId: id,
    status: crawlerStatus(c),
    blockingError: c.blockingError ?? "",
    indexPrefix: c.config?.indexPrefix ?? "",
    schedule: c.config?.schedule ?? "",
    startUrls: (c.config?.startUrls ?? []).join(", "),
    lastReindexStartedAt: c.lastReindexStartedAt ?? "",
    lastReindexEndedAt: c.lastReindexEndedAt ?? "",
  };
  if (c.createdAt) fields["createdAt"] = c.createdAt;
  return makeInstance({
    accountId,
    typeId: "crawler",
    externalId: id,
    displayName: c.name ?? id,
    fields,
    createdAt: c.createdAt,
  });
}
