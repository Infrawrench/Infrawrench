import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/** ACL values the Search API accepts (`acl` enum, search.yml, 2026-10). */
export const ACLS = [
  "search",
  "browse",
  "addObject",
  "deleteObject",
  "deleteIndex",
  "listIndexes",
  "settings",
  "editSettings",
  "analytics",
  "recommendation",
  "usage",
  "logs",
  "seeUnretrievableAttributes",
  "personalization",
  "inference",
];

export const ACL_LABELS: Record<string, string> = {
  search: "Search the indices",
  browse: "Browse every record",
  addObject: "Add and update records",
  deleteObject: "Delete records",
  deleteIndex: "Delete and clear indices",
  listIndexes: "List indices",
  settings: "Read index settings",
  editSettings: "Change index settings",
  analytics: "Read analytics",
  recommendation: "Recommend models",
  usage: "Read usage",
  logs: "Read API logs",
  seeUnretrievableAttributes: "See unretrievable attributes",
  personalization: "Personalization",
  inference: "Inference",
};

/** ACLs that let a key change or destroy data, for the access review. */
export const WRITE_ACLS = ["addObject", "deleteObject", "deleteIndex", "editSettings"];

export const ApplicationResourceType = rt({
  name: "Application",
  id: "application",
  accountRoot: true,
  description: "The Algolia application this account connects to",
  fields: [
    f("appId", "Application ID", { editable: false }),
    f("indexCount", "Indices", { kind: "number", required: false, editable: false }),
    f("records", "Records", { kind: "number", required: false, editable: false }),
    f("dataSize", "Data Size (bytes)", { kind: "number", required: false, editable: false }),
    f("apiKeyCount", "API Keys", { kind: "number", required: false, editable: false }),
    f("region", "Clusters", { required: false, editable: false }),
    f("allowedSources", "Admin Key Allowed Sources", { required: false, editable: false }),
  ],
  outputs: [
    o("appId", "Application ID"),
    o("searchHost", "Search Host"),
    o("adminApiKey", "Admin API Key", { sensitive: true }),
  ],
  secretExportTemplates: [
    {
      id: "algolia-env",
      displayName: "Algolia environment variables",
      description: "ALGOLIA_APP_ID and ALGOLIA_ADMIN_API_KEY",
      entries: [
        { envKey: "ALGOLIA_APP_ID", outputKey: "appId" },
        { envKey: "ALGOLIA_ADMIN_API_KEY", outputKey: "adminApiKey" },
      ],
    },
  ],
  iconKey: "search",
  supportsDelete: false,
  supportsMetrics: true,
});

export const IndexResourceType = rt({
  name: "Index",
  plural: "Indices",
  id: "index",
  description: "An Algolia index: its records, size, replicas and search settings",
  fields: [
    f("name", "Name", { editable: false }),
    f("role", "Role", {
      kind: "enum",
      enumValues: ["primary", "replica", "virtual replica"],
      editable: false,
    }),
    f("primary", "Primary Index", { required: false, editable: false }),
    f("entries", "Records", { kind: "number", required: false, editable: false }),
    f("dataSize", "Data Size (bytes)", { kind: "number", required: false, editable: false }),
    f("fileSize", "File Size (bytes)", { kind: "number", required: false, editable: false }),
    f("lastBuildTimeS", "Last Build (s)", { kind: "number", required: false, editable: false }),
    f("synonymCount", "Synonyms", { kind: "number", required: false, editable: false }),
    f("ruleCount", "Rules", { kind: "number", required: false, editable: false }),
    f("abTest", "A/B Test", { required: false, editable: false }),
    f("searchableAttributes", "Searchable Attributes", {
      required: false,
      description: "Comma-separated, in priority order; unordered(attr) ignores word position",
    }),
    f("customRanking", "Custom Ranking", {
      required: false,
      description: "Comma-separated desc(attr) / asc(attr) entries",
    }),
    f("attributesForFaceting", "Facets", {
      required: false,
      description: "Comma-separated; wrap as searchable(attr) or filterOnly(attr) as needed",
    }),
    f("attributesToRetrieve", "Attributes to Retrieve", {
      required: false,
      description: "Comma-separated; * for all",
    }),
    f("unretrievableAttributes", "Unretrievable Attributes", { required: false }),
    f("replicas", "Replicas", {
      required: false,
      description:
        "Comma-separated replica names; virtual(name) for a virtual replica. Removing one unlinks it.",
    }),
    f("hitsPerPage", "Hits per Page", { kind: "number", required: false }),
    f("paginationLimitedTo", "Pagination Limit", { kind: "number", required: false }),
    f("typoTolerance", "Typo Tolerance", {
      kind: "enum",
      enumValues: ["true", "false", "min", "strict"],
      required: false,
    }),
    f("distinct", "Distinct", {
      kind: "number",
      required: false,
      description: "0 off, 1 one hit per value, more to group",
    }),
    f("attributeForDistinct", "Attribute for Distinct", { required: false }),
    f("ignorePlurals", "Ignore Plurals", { kind: "boolean", required: false }),
    f("removeStopWords", "Remove Stop Words", { kind: "boolean", required: false }),
    f("queryLanguages", "Query Languages", {
      required: false,
      description: "Comma-separated ISO codes, e.g. en, fr",
    }),
    f("indexLanguages", "Index Languages", { required: false }),
    f("queryType", "Prefix Matching", {
      kind: "enum",
      enumValues: ["prefixLast", "prefixAll", "prefixNone"],
      required: false,
    }),
    f("removeWordsIfNoResults", "Remove Words If No Results", {
      kind: "enum",
      enumValues: ["none", "lastWords", "firstWords", "allOptional"],
      required: false,
    }),
    f("enableRules", "Rules Enabled", { kind: "boolean", required: false }),
    f("enablePersonalization", "Personalization", { kind: "boolean", required: false }),
    f("mode", "Search Mode", {
      kind: "enum",
      enumValues: ["keywordSearch", "neuralSearch"],
      required: false,
      description: "neuralSearch needs a NeuralSearch plan",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("indexName", "Index Name")],
  dependsOn: [{ fieldKey: "primary", targetTypeId: "index", label: "replica of" }],
  orphanRule: {
    conditions: [
      { fieldKey: "entries", when: "equals", value: "0" },
      { fieldKey: "role", when: "equals", value: "primary" },
      { fieldKey: "replicas", when: "empty" },
    ],
    reason: "Primary index with no records and no replicas",
  },
  iconKey: "index",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
});

export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description: "An Algolia API key with its ACL and restrictions",
  fields: [
    f("description", "Description", { required: false }),
    f("acl", "ACL", { description: `Comma-separated, any of: ${ACLS.join(", ")}` }),
    f("indexes", "Indices", {
      required: false,
      description: "Comma-separated names or patterns (dev_*); empty for all",
    }),
    f("referers", "Referrers", {
      required: false,
      description: "Comma-separated, e.g. https://example.com/*",
    }),
    f("queryParameters", "Forced Query Parameters", {
      required: false,
      description: "URL query string added to every search, e.g. filters=tenant%3Aacme",
    }),
    f("maxHitsPerQuery", "Max Hits per Query", {
      kind: "number",
      required: false,
      description: "0 for no limit",
    }),
    f("maxQueriesPerIPPerHour", "Max Queries per IP per Hour", {
      kind: "number",
      required: false,
      description: "0 for no limit",
    }),
    f("validity", "Validity (s)", {
      kind: "number",
      required: false,
      description: "Seconds until expiry from creation; 0 never expires",
    }),
    f("keyPrefix", "Key Starts With", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
  ],
  outputs: [o("apiKey", "API Key", { sensitive: true })],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "API key expires" },
  ],
  principalRole: { role: "key" },
  iconKey: "key",
  supportsCreate: true,
  supportsUpdate: true,
});

export const AbTestResourceType = rt({
  name: "A/B Test",
  id: "ab-test",
  description: "An A/B test splitting traffic between two indices",
  fields: [
    f("name", "Name", { editable: false }),
    f("abTestId", "Test ID", { kind: "number", editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["active", "stopped", "expired", "failed"],
      editable: false,
    }),
    f("indexA", "Variant A Index", { editable: false }),
    f("indexB", "Variant B Index", { editable: false }),
    f("trafficB", "Traffic to B (%)", { kind: "number", required: false, editable: false }),
    f("ctrA", "Click-Through A (%)", { kind: "number", required: false, editable: false }),
    f("ctrB", "Click-Through B (%)", { kind: "number", required: false, editable: false }),
    f("clickSignificance", "Click Significance", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("conversionSignificance", "Conversion Significance", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("endAt", "Ends", { required: false, editable: false }),
    f("stoppedAt", "Stopped", { required: false, editable: false }),
  ],
  dependsOn: [
    { fieldKey: "indexA", targetTypeId: "index", label: "variant A" },
    { fieldKey: "indexB", targetTypeId: "index", label: "variant B" },
  ],
  iconKey: "experiment",
  supportsCreate: true,
});

export const CrawlerResourceType = rt({
  name: "Crawler",
  id: "crawler",
  description: "An Algolia Crawler that fills indices from a website",
  fields: [
    f("name", "Name", { editable: false }),
    f("crawlerId", "Crawler ID", { editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["running", "reindexing", "paused", "blocked"],
      editable: false,
    }),
    f("blockingError", "Blocking Error", { required: false, editable: false }),
    f("indexPrefix", "Index Prefix", { required: false, editable: false }),
    f("schedule", "Schedule", { required: false, editable: false }),
    f("startUrls", "Start URLs", { required: false, editable: false }),
    f("crawledUrls", "Crawled URLs", { kind: "number", required: false, editable: false }),
    f("lastReindexStartedAt", "Last Crawl Started", { required: false, editable: false }),
    f("lastReindexEndedAt", "Last Crawl Ended", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "spider",
  lifecycle: {
    startActionId: "run",
    stopActionId: "pause",
    statusFieldKey: "status",
    runningValues: ["running", "reindexing"],
    stoppedValues: ["paused"],
  },
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ApplicationResourceType,
  IndexResourceType,
  ApiKeyResourceType,
  AbTestResourceType,
  CrawlerResourceType,
];
