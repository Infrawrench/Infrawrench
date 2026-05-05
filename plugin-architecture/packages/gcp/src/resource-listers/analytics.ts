import type { ResourceInstance } from "@infrawrench/plugin-base";
import { type ListerContext } from "./shared.js";

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
  // Hydrate each dataset with its full metadata — the list endpoint only
  // returns {id, datasetReference, location, friendlyName, labels}, but
  // the detail view wants defaultRoundingMode / isCaseInsensitive / etc.
  return Promise.all(
    items.map(async (ds) => {
      const ref = ds["datasetReference"] as Record<string, string> | undefined;
      const datasetId = ref?.["datasetId"] ?? String(ds["id"]).split(":").pop() ?? "";
      let full: Record<string, unknown> = ds;
      try {
        full = await ctx.get<Record<string, unknown>>(
          `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets/${datasetId}`,
        );
      } catch {
        /* fall back to the listing payload */
      }
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
        fields: {
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
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${p}:${datasetId}`,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      };
    }),
  );
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
  let full: Record<string, unknown> = listItem;
  try {
    full = await ctx.get<Record<string, unknown>>(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}/tables/${tableId}`,
    );
  } catch {
    /* fall back to listing payload (missing numRows / numBytes) */
  }

  const schema = full["schema"] as { fields?: Array<Record<string, unknown>> } | undefined;
  const tableConstraints = full["tableConstraints"] as
    | { primaryKey?: { columns?: string[] } }
    | undefined;
  const primaryKeys = tableConstraints?.primaryKey?.columns?.join(", ") ?? "";

  const timePart = full["timePartitioning"] as Record<string, unknown> | undefined;
  const rangePart = full["rangePartitioning"] as
    | { field?: string; range?: { start?: string; end?: string; interval?: string } }
    | undefined;
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
    fields: {
      name: tableId,
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
    },
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

  const all: ResourceInstance[] = [];
  for (const datasetId of datasetIds) {
    let tables: Array<Record<string, unknown>> = [];
    try {
      tables = await ctx.paginate<Record<string, unknown>>(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets/${datasetId}/tables`,
        "tables",
      );
    } catch {
      continue;
    }
    // Hydrate each table with GET — list endpoint omits storage + schema.
    const hydrated = await Promise.all(
      tables.map((t) => hydrateBqTable(ctx, accountId, p, datasetId, t)),
    );
    all.push(...hydrated);
  }
  return all;
}

export async function listDataflowJobs(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://dataflow.googleapis.com/v1b3/projects/${p}/jobs`,
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

export async function listVertexAiEndpoints(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const regions = [
    "us-central1",
    "us-east1",
    "us-west1",
    "europe-west1",
    "europe-west4",
    "asia-east1",
    "asia-northeast1",
  ];
  const results: ResourceInstance[] = [];
  await Promise.all(
    regions.map(async (region) => {
      try {
        const items = await ctx.paginate<Record<string, unknown>>(
          `https://${region}-aiplatform.googleapis.com/v1/projects/${p}/locations/${region}/endpoints`,
          "endpoints",
        );
        for (const ep of items) {
          const fullName = String(ep["name"]);
          const name = fullName.split("/").pop() ?? "";
          const displayName = String(ep["displayName"] ?? name);
          const deployedModels = ep["deployedModels"] as unknown[] | undefined;
          const trafficSplit = ep["trafficSplit"] as Record<string, number> | undefined;
          results.push({
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
          });
        }
      } catch {
        // Skip regions where Vertex AI is not enabled
      }
    }),
  );
  return results;
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
