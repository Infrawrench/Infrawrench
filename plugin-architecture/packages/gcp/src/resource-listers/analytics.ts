import type { ResourceInstance } from "@infrawrench/plugin-base";
import {
  isRegionRefusal,
  mapWithConcurrency,
  readEachParent,
  readEachRegion,
  type ListerContext,
} from "./shared.js";

/** BigQuery's per-item GETs in flight at once, well inside its per-method request rate. */
const BQ_HYDRATE_CONCURRENCY = 8;

/**
 * The fields BigQuery's list answers carry (`datasets.list`, `tables.list`). When an
 * item's GET fails these are all a row can vouch for, and the rest are left out: the
 * sync merges fields over the stored ones, so a field left out keeps its last value
 * where writing a blank would show `0` rows and no schema until the next sync.
 */
const BQ_DATASET_LIST_FIELDS = new Set(["name", "friendlyName", "location", "labels"]);
const BQ_TABLE_LIST_FIELDS = new Set([
  "name",
  "datasetId",
  "friendlyName",
  "type",
  "labels",
  "creationTime",
  "expirationTime",
  "partitioning",
  "clusteringFields",
]);

function keepListedFields<V>(
  hydrated: boolean,
  keep: ReadonlySet<string>,
  fields: Record<string, V>,
): Record<string, V> {
  if (hydrated) return fields;
  return Object.fromEntries(Object.entries(fields).filter(([key]) => keep.has(key)));
}

/** An item's full resource, or undefined when its GET failed and only the list's part is known. */
async function hydrate(ctx: ListerContext, url: string) {
  try {
    return await ctx.get<Record<string, unknown>>(url);
  } catch {
    // A throttle, a 5xx, a refused get or an item deleted since the list: the list
    // still named it, so the row stays and only its detail fields wait for a later sync.
    return undefined;
  }
}

/** BigQuery returns millisecond-epoch strings in most timestamp fields. */
function formatBqTimestamp(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

function formatBqBytes(value: unknown): string {
  if (value === undefined || value === null || value === "") return "0 B";
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(2)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

function formatBqCount(value: unknown): string {
  if (value === undefined || value === null || value === "") return "0";
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US");
}

export async function listBigQueryDatasets(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets`,
    "datasets",
  );
  // Hydrate each dataset with its full metadata: the list endpoint only
  // returns {id, datasetReference, location, friendlyName, labels}, but
  // the detail view wants defaultRoundingMode / isCaseInsensitive / etc.
  return mapWithConcurrency(items, BQ_HYDRATE_CONCURRENCY, async (ds) => {
    const ref = ds["datasetReference"] as Record<string, string> | undefined;
    const datasetId = ref?.["datasetId"] ?? String(ds["id"]).split(":").pop() ?? "";
    const hydrated = await hydrate(
      ctx,
      `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets/${datasetId}`,
    );
    const full = hydrated ?? ds;
    const labelsObj = (full["labels"] as Record<string, string> | undefined) ?? {};
    const labels = Object.entries(labelsObj)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const friendlyName = String(full["friendlyName"] ?? "");
    return {
      id: ctx.id(accountId, "bigquery-dataset", `${p}:${datasetId}`),
      pluginId: "gcp",
      resourceTypeId: "bigquery-dataset",
      accountId,
      displayName: friendlyName || datasetId,
      fields: keepListedFields(hydrated !== undefined, BQ_DATASET_LIST_FIELDS, {
        name: datasetId,
        friendlyName,
        location: String(full["location"] ?? ""),
        description: String(full["description"] ?? ""),
        defaultTableExpirationMs: Number(full["defaultTableExpirationMs"] ?? 0),
        defaultPartitionExpirationMs: Number(full["defaultPartitionExpirationMs"] ?? 0),
        defaultCollation: String(full["defaultCollation"] ?? ""),
        defaultRoundingMode: String(full["defaultRoundingMode"] ?? ""),
        isCaseInsensitive: Boolean(full["isCaseInsensitive"] ?? false),
        storageBillingModel: String(full["storageBillingModel"] ?? ""),
        maxTimeTravelHours: Number(full["maxTimeTravelHours"] ?? 0),
        labels,
        creationTime: formatBqTimestamp(full["creationTime"]),
        lastModifiedTime: formatBqTimestamp(full["lastModifiedTime"]),
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}:${datasetId}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

async function hydrateBqTable(
  ctx: ListerContext,
  accountId: string,
  project: string,
  datasetId: string,
  listItem: Record<string, unknown>,
): Promise<ResourceInstance> {
  const ref = listItem["tableReference"] as Record<string, string> | undefined;
  const tableId = ref?.["tableId"] ?? "";
  const hydrated = await hydrate(
    ctx,
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}/tables/${tableId}`,
  );
  const full = hydrated ?? listItem;

  const schema = full["schema"] as { fields?: Array<Record<string, unknown>> } | undefined;
  const tableConstraints = full["tableConstraints"] as
    { primaryKey?: { columns?: string[] } } | undefined;
  const primaryKeys = tableConstraints?.primaryKey?.columns?.join(", ") ?? "";

  const timePart = full["timePartitioning"] as Record<string, unknown> | undefined;
  const rangePart = full["rangePartitioning"] as
    { field?: string; range?: { start?: string; end?: string; interval?: string } } | undefined;
  let partitioning = "";
  if (timePart) {
    const type = String(timePart["type"] ?? "DAY");
    const field = timePart["field"] ? String(timePart["field"]) : "_PARTITIONTIME";
    partitioning = `${type} on ${field}`;
  } else if (rangePart?.field) {
    partitioning = `RANGE on ${rangePart.field}`;
  }

  const clustering = full["clustering"] as { fields?: string[] } | undefined;
  const clusteringFields = clustering?.fields?.join(", ") ?? "";

  const labelsObj = (full["labels"] as Record<string, string> | undefined) ?? {};
  const labels = Object.entries(labelsObj)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  const friendlyName = String(full["friendlyName"] ?? "");
  const type = String(full["type"] ?? "TABLE");
  const location = String(full["location"] ?? "");

  const externalId = `${project}:${datasetId}/${tableId}`;

  return {
    id: ctx.id(accountId, "bigquery-table", externalId),
    pluginId: "gcp",
    resourceTypeId: "bigquery-table",
    accountId,
    displayName: friendlyName || tableId,
    parentResourceId: ctx.id(accountId, "bigquery-dataset", `${project}:${datasetId}`),
    fields: keepListedFields(hydrated !== undefined, BQ_TABLE_LIST_FIELDS, {
      name: tableId,
      // Fully-qualified, matching a dataset's external id: dataset names are
      // only unique within a project, so the bare id would be ambiguous.
      datasetId: `${project}:${datasetId}`,
      friendlyName,
      type,
      location,
      description: String(full["description"] ?? ""),
      labels,
      creationTime: formatBqTimestamp(full["creationTime"]),
      lastModifiedTime: formatBqTimestamp(full["lastModifiedTime"]),
      expirationTime: full["expirationTime"] ? formatBqTimestamp(full["expirationTime"]) : "NEVER",
      primaryKeys,
      partitioning,
      clusteringFields,
      defaultCollation: String(full["defaultCollation"] ?? ""),
      defaultRoundingMode: String(full["defaultRoundingMode"] ?? ""),
      caseInsensitive: Boolean(full["caseInsensitive"] ?? false),
      numRows: formatBqCount(full["numRows"]),
      numBytes: formatBqBytes(full["numBytes"]),
      numActiveLogicalBytes: formatBqBytes(full["numActiveLogicalBytes"]),
      numLongTermLogicalBytes: formatBqBytes(full["numLongTermLogicalBytes"]),
      numCurrentPhysicalBytes: formatBqBytes(full["numCurrentPhysicalBytes"]),
      numTotalPhysicalBytes: formatBqBytes(full["numTotalPhysicalBytes"]),
      numActivePhysicalBytes: formatBqBytes(full["numActivePhysicalBytes"]),
      numLongTermPhysicalBytes: formatBqBytes(full["numLongTermPhysicalBytes"]),
      numTimeTravelPhysicalBytes: formatBqBytes(full["numTimeTravelPhysicalBytes"]),
      schemaJson: schema ? JSON.stringify(schema.fields ?? [], null, 2) : "",
    }),
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: formatBqTimestamp(full["creationTime"]) || ctx.now(),
    updatedAt: formatBqTimestamp(full["lastModifiedTime"]) || ctx.now(),
  };
}

export async function listBigQueryTables(
  ctx: ListerContext,
  accountId: string,
  p: string,
  datasetFilter?: string,
): Promise<ResourceInstance[]> {
  // Enumerate datasets we need to scan. If a filter is provided (the parent
  // resource's dataset ID), skip the dataset listing call.
  let datasetIds: string[];
  if (datasetFilter) {
    datasetIds = [datasetFilter];
  } else {
    const datasets = await ctx.paginate<Record<string, unknown>>(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets`,
      "datasets",
    );
    datasetIds = datasets
      .map((ds) => {
        const ref = ds["datasetReference"] as Record<string, string> | undefined;
        return ref?.["datasetId"] ?? "";
      })
      .filter(Boolean);
  }

  return readEachParent(
    datasetIds,
    async (datasetId) => {
      const tables = await ctx.paginate<Record<string, unknown>>(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets/${datasetId}/tables`,
        "tables",
      );
      // Hydrate each table with GET: list endpoint omits storage + schema.
      return mapWithConcurrency(tables, BQ_HYDRATE_CONCURRENCY, (t) =>
        hydrateBqTable(ctx, accountId, p, datasetId, t),
      );
    },
    {
      sequential: true,
      unread: (datasetId) => ({
        parentResourceIds: [ctx.id(accountId, "bigquery-dataset", `${p}:${datasetId}`)],
      }),
    },
  );
}

export async function listDataflowJobs(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  // `jobs.list` only answers for us-central1. `jobs:aggregated` is every region's.
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://dataflow.googleapis.com/v1b3/projects/${p}/jobs:aggregated`,
    "jobs",
    { filter: "ACTIVE" },
  );
  return items.map((job) => {
    const name = String(job["name"]);
    const region = String(job["location"] ?? "");
    const sdkVersion = (job["jobMetadata"] as Record<string, unknown> | undefined)?.[
      "sdkVersion"
    ] as Record<string, string> | undefined;
    return {
      id: ctx.id(accountId, "dataflow-job", String(job["id"])),
      pluginId: "gcp",
      resourceTypeId: "dataflow-job",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        type: String(job["type"] ?? ""),
        state: String(job["currentState"] ?? ""),
        sdkVersion: sdkVersion?.["version"] ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(job["id"]),
      createdAt: String(job["createTime"] ?? ctx.now()),
      updatedAt: String(job["currentStateTime"] ?? ctx.now()),
    };
  });
}

/** The regions read before the list came from `locations.list`, for when that is refused. */
const VERTEX_FALLBACK_REGIONS = [
  "us-central1",
  "us-east1",
  "us-west1",
  "europe-west1",
  "europe-west4",
  "asia-east1",
  "asia-northeast1",
];

/**
 * A region such as `us-central1` or `northamerica-northeast1`, which has its own
 * `{region}-aiplatform` host. Endpoints are regional, and `global` or a multi-region
 * has no such host: reading one would fail on the name lookup and take the type with it.
 */
const VERTEX_REGION = /^[a-z]+-[a-z]+\d+$/;

/** Every region Vertex AI serves this project, read from the API rather than a fixed list. */
async function listVertexAiRegions(ctx: ListerContext, p: string): Promise<string[]> {
  try {
    const locations = await ctx.paginate<{ locationId?: string; name?: string }>(
      `https://aiplatform.googleapis.com/v1/projects/${p}/locations`,
      "locations",
    );
    const ids = locations.map((l) => l.locationId ?? l.name?.split("/").pop() ?? "");
    const regions = [...new Set(ids.filter((id) => VERTEX_REGION.test(id)))];
    // No region at all can't be right for a service in dozens of them, and reading none
    // would prune every stored endpoint.
    return regions.length > 0 ? regions : VERTEX_FALLBACK_REGIONS;
  } catch (err) {
    // A throttle, a 5xx or an expired credential fails the type. A refused location
    // list falls back to the regions this always read, whose own answers then decide.
    if (!isRegionRefusal(err)) throw err;
    return VERTEX_FALLBACK_REGIONS;
  }
}

export async function listVertexAiEndpoints(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const regions = await listVertexAiRegions(ctx, p);
  return readEachRegion(
    regions,
    async (region) => {
      const items = await ctx.paginate<Record<string, unknown>>(
        `https://${region}-aiplatform.googleapis.com/v1/projects/${p}/locations/${region}/endpoints`,
        "endpoints",
      );
      return items.map((ep) => {
        const fullName = String(ep["name"]);
        const name = fullName.split("/").pop() ?? "";
        const displayName = String(ep["displayName"] ?? name);
        const deployedModels = ep["deployedModels"] as unknown[] | undefined;
        const trafficSplit = ep["trafficSplit"] as Record<string, number> | undefined;
        return {
          id: ctx.id(accountId, "vertex-ai-endpoint", fullName),
          pluginId: "gcp",
          resourceTypeId: "vertex-ai-endpoint",
          accountId,
          displayName,
          fields: {
            name: fullName,
            displayName,
            region,
            state: String(ep["state"] ?? ""),
            deployedModelCount: Array.isArray(deployedModels) ? deployedModels.length : 0,
            trafficSplit: trafficSplit ? JSON.stringify(trafficSplit) : "",
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: fullName,
          createdAt: String(ep["createTime"] ?? ctx.now()),
          updatedAt: String(ep["updateTime"] ?? ctx.now()),
        };
      });
    },
    // Google writes the project's number into these names, not the id this holds, so a
    // region's rows can't be told by prefix.
    { unread: () => ({ idPrefixes: [ctx.id(accountId, "vertex-ai-endpoint", "")] }) },
  );
}

export async function listComposerEnvironments(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://composer.googleapis.com/v1/projects/${p}/locations/-/environments`,
    "environments",
  );
  return items.map((env) => {
    const fullName = String(env["name"]);
    const name = fullName.split("/").pop() ?? "";
    const location = fullName.split("/locations/")[1]?.split("/")[0] ?? "";
    const config = env["config"] as Record<string, unknown> | undefined;
    const softwareConfig = config?.["softwareConfig"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "composer-environment", fullName),
      pluginId: "gcp",
      resourceTypeId: "composer-environment",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        state: String(env["state"] ?? ""),
        imageVersion: String(softwareConfig?.["imageVersion"] ?? ""),
        airflowUri: String(config?.["airflowUri"] ?? ""),
        dagGcsPrefix: String(config?.["dagGcsPrefix"] ?? ""),
      },
      resolvedOutputs: { airflowUri: String(config?.["airflowUri"] ?? "") },
      secretStates: [],
      externalId: fullName,
      createdAt: String(env["createTime"] ?? ctx.now()),
      updatedAt: String(env["updateTime"] ?? ctx.now()),
    };
  });
}
