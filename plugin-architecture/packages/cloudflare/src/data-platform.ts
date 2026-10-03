/**
 * Dispatch for the Basin (Pipelines, Catalog, SQL) and Workers Analytics
 * Engine resource types. `CloudflareClient` hands any of these type ids to
 * the functions below, so the shared client only carries one guard per
 * method rather than a case per type.
 */
import type {
  CreateResourceConfig,
  DetailViewSchema,
  MetricSeries,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./clients/shared.js";
import * as pipelinesApi from "./clients/basin-pipelines-client.js";
import * as catalogApi from "./clients/basin-catalog-client.js";
import * as aeApi from "./clients/analytics-engine-client.js";
import {
  renderAnalyticsEngineDatasetDetail,
  renderBasinCatalogDetail,
  renderBasinPipelineDetail,
  renderBasinSidebarItem,
  renderBasinSinkDetail,
  renderBasinStreamDetail,
  renderBasinTableDetail,
} from "./detail-renderers/basin.js";
import {
  fetchCatalogMetrics,
  fetchPipelineMetrics,
  fetchSinkMetrics,
  fetchStreamMetrics,
  fetchTableMetrics,
} from "./basin-metrics.js";
import { getDataPlatformCreateConfig } from "./data-platform-create-configs.js";

export const DATA_PLATFORM_TYPE_IDS = [
  "basin-pipeline",
  "basin-stream",
  "basin-sink",
  "basin-catalog",
  "basin-table",
  "analytics-engine-dataset",
] as const;

export type DataPlatformTypeId = (typeof DATA_PLATFORM_TYPE_IDS)[number];

export function isDataPlatformType(typeId: string): typeId is DataPlatformTypeId {
  return (DATA_PLATFORM_TYPE_IDS as readonly string[]).includes(typeId);
}

/** `<accountId>:<typeId>:<externalId>` → typeId (external ids may contain colons). */
function typeOf(resourceId: string): string {
  return resourceId.split(":")[1] ?? "";
}

function externalOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

/** True when `executeQuery` / `introspectResource` for this id belong here. */
export function isDataPlatformResourceId(resourceId: string): boolean {
  return isDataPlatformType(typeOf(resourceId));
}

export async function listDataPlatform(
  api: CloudflareApi,
  typeId: DataPlatformTypeId,
  accountId: string,
): Promise<ResourceInstance[]> {
  switch (typeId) {
    case "basin-pipeline":
      return pipelinesApi.listPipelines(api, accountId);
    case "basin-stream":
      return pipelinesApi.listStreams(api, accountId);
    case "basin-sink":
      return pipelinesApi.listSinks(api, accountId);
    case "basin-catalog":
      return catalogApi.listCatalogs(api, accountId);
    case "basin-table":
      return catalogApi.listTables(api, accountId);
    case "analytics-engine-dataset":
      return aeApi.listDatasets(api, accountId);
  }
}

export async function getDataPlatform(
  api: CloudflareApi,
  typeId: DataPlatformTypeId,
  resourceId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const ext = externalOf(resourceId);
  switch (typeId) {
    case "basin-pipeline":
      return pipelinesApi.getPipeline(api, ext, accountId);
    case "basin-stream":
      return pipelinesApi.getStream(api, ext, accountId);
    case "basin-sink":
      return pipelinesApi.getSink(api, ext, accountId);
    case "basin-catalog":
      return catalogApi.getCatalog(api, ext, accountId);
    case "basin-table":
      return catalogApi.getTable(api, ext, accountId);
    case "analytics-engine-dataset": {
      const found = (await aeApi.listDatasets(api, accountId)).find((r) => r.id === resourceId);
      if (!found) throw new Error(`Analytics Engine dataset "${ext}" not found`);
      return found;
    }
  }
}

export async function createDataPlatform(
  api: CloudflareApi,
  typeId: DataPlatformTypeId,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  switch (typeId) {
    case "basin-pipeline":
      return pipelinesApi.createPipeline(api, accountId, fields);
    case "basin-stream":
      return pipelinesApi.createStream(api, accountId, fields);
    case "basin-sink":
      return pipelinesApi.createSink(api, accountId, fields);
    case "basin-catalog":
      return catalogApi.enableCatalog(api, accountId, fields);
    default:
      throw new Error(`Cloudflare plugin: createResource not supported for type "${typeId}"`);
  }
}

/**
 * Edit. `changed` is the host's changed-keys set; current values are merged
 * underneath so each builder sees the full state (a blank password field
 * means "keep").
 */
export async function updateDataPlatform(
  api: CloudflareApi,
  typeId: DataPlatformTypeId,
  resourceId: string,
  accountId: string,
  changed: Record<string, string>,
): Promise<ResourceInstance> {
  const ext = externalOf(resourceId);
  const current = await getDataPlatform(api, typeId, resourceId, accountId);
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(current.fields)) {
    if (v !== undefined && v !== null) merged[k] = String(v);
  }
  Object.assign(merged, changed);
  switch (typeId) {
    case "basin-stream":
      return pipelinesApi.editStream(api, accountId, ext, merged);
    case "basin-catalog":
      return catalogApi.editCatalog(api, accountId, ext, merged, Object.keys(changed));
    case "basin-table":
      return catalogApi.editTable(api, accountId, ext, merged);
    default:
      throw new Error(`Cloudflare plugin: updateResource not supported for type "${typeId}"`);
  }
}

export async function deleteDataPlatform(
  api: CloudflareApi,
  typeId: DataPlatformTypeId,
  resourceId: string,
): Promise<void> {
  const ext = externalOf(resourceId);
  switch (typeId) {
    case "basin-pipeline":
      return pipelinesApi.deletePipeline(api, ext);
    case "basin-stream":
      return pipelinesApi.deleteStream(api, ext);
    case "basin-sink":
      return pipelinesApi.deleteSink(api, ext);
    case "basin-catalog":
      return catalogApi.disableCatalog(api, ext);
    default:
      throw new Error(`Cloudflare plugin: deleteResource not supported for type "${typeId}"`);
  }
}

export async function resolveDataPlatformOutput(
  api: CloudflareApi,
  typeId: DataPlatformTypeId,
  resourceId: string,
  outputKey: string,
  accountId: string,
): Promise<string> {
  const resource = await getDataPlatform(api, typeId, resourceId, accountId);
  const value = resource.resolvedOutputs[outputKey];
  if (typeof value === "string") return value;
  throw new Error(`Cloudflare plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
}

/** Pipelines: the list omits the stream/sink tables and failure reason, so fetch the detail. */
export async function enrichDataPlatform(
  api: CloudflareApi,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  if (resource.resourceTypeId !== "basin-pipeline" || !resource.externalId) return resource;
  try {
    const full = await pipelinesApi.getPipeline(api, resource.externalId, resource.accountId);
    return { ...resource, fields: { ...resource.fields, ...full.fields } };
  } catch {
    return resource;
  }
}

export function renderDataPlatformDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  switch (resource.resourceTypeId as DataPlatformTypeId) {
    case "basin-pipeline":
      return renderBasinPipelineDetail(resource, resourceTypes);
    case "basin-stream":
      return renderBasinStreamDetail(resource, resourceTypes);
    case "basin-sink":
      return renderBasinSinkDetail(resource, resourceTypes);
    case "basin-catalog":
      return renderBasinCatalogDetail(resource, resourceTypes);
    case "basin-table":
      return renderBasinTableDetail(resource, resourceTypes);
    case "analytics-engine-dataset":
      return renderAnalyticsEngineDatasetDetail(resource);
  }
}

export function renderDataPlatformSidebar(resource: ResourceInstance): SidebarItemSchema | null {
  return renderBasinSidebarItem(resource);
}

export async function dataPlatformCreateConfig(
  api: CloudflareApi,
  typeId: string,
): Promise<CreateResourceConfig | null> {
  return getDataPlatformCreateConfig(api, typeId);
}

/** SQL for the catalog, table and dataset types. Basin SQL is read-only. */
export async function executeDataPlatformQuery(
  api: CloudflareApi,
  resourceId: string,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
  const typeId = typeOf(resourceId);
  const ext = externalOf(resourceId);
  if (typeId === "basin-catalog") return catalogApi.runBasinSql(api, ext, sql);
  if (typeId === "basin-table") {
    const ref = catalogApi.parseTableExternalId(ext);
    if (!ref) throw new Error(`Cloudflare plugin: malformed Basin table id "${ext}"`);
    return catalogApi.runBasinSql(api, ref.bucket, sql);
  }
  if (typeId === "analytics-engine-dataset") return aeApi.executeAnalyticsEngineQuery(api, sql);
  throw new Error(`Cloudflare plugin: SQL isn't available for "${typeId}" resources`);
}

export async function introspectDataPlatform(
  api: CloudflareApi,
  resourceId: string,
): Promise<SqlTableMeta[]> {
  const typeId = typeOf(resourceId);
  const ext = externalOf(resourceId);
  if (typeId === "basin-catalog") return catalogApi.introspectCatalog(api, ext);
  if (typeId === "basin-table") {
    const ref = catalogApi.parseTableExternalId(ext);
    if (!ref) return [];
    // The whole catalog is queryable from a table's editor (JOINs across tables).
    return catalogApi.introspectCatalog(api, ref.bucket);
  }
  if (typeId === "analytics-engine-dataset") return aeApi.introspectAnalyticsEngine(api, ext);
  return [];
}

export async function fetchDataPlatformMetrics(
  api: CloudflareApi,
  typeId: DataPlatformTypeId,
  resourceId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const ext = externalOf(resourceId);
  if (!ext) return [];
  switch (typeId) {
    case "basin-pipeline":
      return fetchPipelineMetrics(api, ext, timeRange);
    case "basin-stream":
      return fetchStreamMetrics(api, ext, timeRange);
    case "basin-sink":
      return fetchSinkMetrics(api, ext, timeRange);
    case "basin-catalog": {
      let account: string;
      try {
        account = await api.getAccountId();
      } catch {
        return [];
      }
      return fetchCatalogMetrics(api, `${account}_${ext}`, timeRange);
    }
    case "basin-table":
      return fetchTableMetrics(api, ext, timeRange);
    case "analytics-engine-dataset":
      return aeApi.fetchAnalyticsEngineMetrics(api, ext, timeRange);
  }
}
