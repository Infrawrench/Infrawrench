import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { splitList } from "./mappers.js";

/**
 * Terraform mapping for Algolia's own provider `algolia/algolia` (1.0,
 * github.com/algolia/terraform-provider-algolia docs/resources, verified
 * 2026-10). Settings are grouped into nested blocks.
 *
 * - `algolia_index`: `name`, `attributes { searchable_attributes,
 *   attributes_to_retrieve, unretrievable_attributes, attribute_for_distinct }`,
 *   `ranking { custom_ranking }`, `faceting { attributes_for_faceting }`,
 *   `pagination { hits_per_page, pagination_limited_to }`,
 *   `typos { typo_tolerance }` (a string), `languages { query_languages,
 *   index_languages, ignore_plurals, remove_stop_words,
 *   remove_words_if_no_results }`, `query_strategy { query_type }`,
 *   `advanced { distinct, enable_rules, enable_personalization, mode, replicas }`.
 *   Import id: the index name. Replicas are exported from their primary only.
 * - `algolia_api_key`: `acl`, `description`, `indexes`, `referers`,
 *   `query_parameters`, `max_hits_per_query`, `max_queries_per_ip_per_hour`,
 *   `expires_at`. Its import id is the key value itself, which the inventory
 *   never stores, so the block carries a comment instead.
 *
 * A/B tests are left out: `algolia_ab_test` needs the write-once `metrics`
 * list the API never returns.
 */

function list(resource: ResourceInstance, key: string): TerraformValue | undefined {
  const items = splitList(fieldString(resource, key));
  return items.length ? tf.list(items.map((i) => tf.str(i))) : undefined;
}

function bool(resource: ResourceInstance, key: string): TerraformValue | undefined {
  const v = resource.fields[key];
  if (v === undefined || v === "") return undefined;
  return tf.bool(v === true || v === "true");
}

function block(entries: Record<string, TerraformValue | undefined>): TerraformValue | undefined {
  const kept = Object.fromEntries(
    Object.entries(entries).filter((e): e is [string, TerraformValue] => e[1] !== undefined),
  );
  return Object.keys(kept).length ? tf.block(kept) : undefined;
}

function str(resource: ResourceInstance, key: string): TerraformValue | undefined {
  const v = fieldString(resource, key);
  return v ? tf.str(v) : undefined;
}

function num(resource: ResourceInstance, key: string): TerraformValue | undefined {
  const n = fieldNumber(resource, key);
  return n === undefined ? undefined : tf.num(n);
}

function mapIndex(resource: ResourceInstance): TerraformExportResult | null {
  const name = fieldString(resource, "name") || resource.externalId || "";
  if (!name || fieldString(resource, "role") !== "primary") return null;
  const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
  const blocks: Record<string, TerraformValue | undefined> = {
    attributes: block({
      searchable_attributes: list(resource, "searchableAttributes"),
      attributes_to_retrieve: list(resource, "attributesToRetrieve"),
      unretrievable_attributes: list(resource, "unretrievableAttributes"),
      attribute_for_distinct: str(resource, "attributeForDistinct"),
    }),
    ranking: block({ custom_ranking: list(resource, "customRanking") }),
    faceting: block({ attributes_for_faceting: list(resource, "attributesForFaceting") }),
    pagination: block({
      hits_per_page: num(resource, "hitsPerPage"),
      pagination_limited_to: num(resource, "paginationLimitedTo"),
    }),
    typos: block({ typo_tolerance: str(resource, "typoTolerance") }),
    languages: block({
      query_languages: list(resource, "queryLanguages"),
      index_languages: list(resource, "indexLanguages"),
      ignore_plurals: bool(resource, "ignorePlurals"),
      remove_stop_words: bool(resource, "removeStopWords"),
      remove_words_if_no_results: str(resource, "removeWordsIfNoResults"),
    }),
    query_strategy: block({ query_type: str(resource, "queryType") }),
    advanced: block({
      distinct: num(resource, "distinct"),
      enable_rules: bool(resource, "enableRules"),
      enable_personalization: bool(resource, "enablePersonalization"),
      mode: str(resource, "mode"),
      replicas: list(resource, "replicas"),
    }),
  };
  for (const [k, v] of Object.entries(blocks)) if (v) attributes[k] = v;
  return {
    resource: {
      type: "algolia_index",
      name,
      attributes,
      importId: name,
      comments: [
        "Only the settings Infrawrench syncs are exported; compare with the index's full settings JSON before applying.",
      ],
    },
  };
}

function mapApiKey(resource: ResourceInstance): TerraformExportResult | null {
  const acl = list(resource, "acl");
  if (!acl) return null;
  const attributes: Record<string, TerraformValue> = { acl };
  const extras: Record<string, TerraformValue | undefined> = {
    description: str(resource, "description"),
    indexes: list(resource, "indexes"),
    referers: list(resource, "referers"),
    query_parameters: str(resource, "queryParameters"),
    max_hits_per_query:
      (fieldNumber(resource, "maxHitsPerQuery") ?? 0) > 0
        ? num(resource, "maxHitsPerQuery")
        : undefined,
    max_queries_per_ip_per_hour:
      (fieldNumber(resource, "maxQueriesPerIPPerHour") ?? 0) > 0
        ? num(resource, "maxQueriesPerIPPerHour")
        : undefined,
    expires_at: str(resource, "expiresAt"),
  };
  for (const [k, v] of Object.entries(extras)) if (v) attributes[k] = v;
  return {
    resource: {
      type: "algolia_api_key",
      name: fieldString(resource, "description") || resource.externalId || resource.displayName,
      attributes,
      comments: [
        "Import with the key value itself: copy it from the key's API Key output in Infrawrench.",
      ],
    },
  };
}

export const algoliaTerraformExport: TerraformExportCapability = {
  provider: { name: "algolia", source: "algolia/algolia", version: "~> 1.0" },
  providerConfig: {
    app_id: tf.ref("var.algolia_app_id"),
    api_key: tf.ref("var.algolia_api_key"),
  },
  variables: [
    { name: "algolia_app_id", description: "Algolia application ID" },
    { name: "algolia_api_key", description: "Algolia Admin API key", sensitive: true },
  ],
  supportedResourceTypeIds: ["index", "api-key"],
  mapResource(resource) {
    if (resource.resourceTypeId === "index") return mapIndex(resource);
    if (resource.resourceTypeId === "api-key") return mapApiKey(resource);
    return null;
  },
};
