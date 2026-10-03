import type { CreateResourceConfig } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./clients/shared.js";
import {
  getBucketOptions,
  getCatalogBucketOptions,
  getUncatalogedBucketOptions,
} from "./clients/basin-catalog-client.js";
import { getStreamAndSinkOptions } from "./clients/basin-pipelines-client.js";

type Field = CreateResourceConfig["fields"][number];

const ON_OFF = [
  { id: "true", label: "Enabled" },
  { id: "false", label: "Disabled" },
];

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Compaction + snapshot expiration fields shared by the catalog create form. */
function maintenanceFields(): Field[] {
  const whenCompaction = { fieldKey: "compaction", fieldValue: "enabled" };
  const whenSnapshots = { fieldKey: "snapshotExpiration", fieldValue: "enabled" };
  return [
    {
      key: "compaction",
      label: "Compaction",
      kind: "select",
      required: false,
      defaultValue: "enabled",
      description: "Merge small data files into larger ones so queries read fewer files",
      options: [
        { id: "enabled", label: "Enabled" },
        { id: "disabled", label: "Disabled" },
      ],
    },
    {
      key: "targetSizeMb",
      label: "Target File Size",
      kind: "select",
      required: false,
      defaultValue: "128",
      showWhen: whenCompaction,
      options: ["64", "128", "256", "512"].map((s) => ({ id: s, label: `${s} MB` })),
    },
    {
      key: "snapshotExpiration",
      label: "Snapshot Expiration",
      kind: "select",
      required: false,
      defaultValue: "disabled",
      description: "Remove old table snapshots and the data files only they reference",
      options: [
        { id: "enabled", label: "Enabled" },
        { id: "disabled", label: "Disabled" },
      ],
    },
    {
      key: "maxSnapshotAge",
      label: "Max Snapshot Age (days)",
      kind: "number",
      required: false,
      defaultValue: "30",
      minValue: 1,
      showWhen: whenSnapshots,
    },
    {
      key: "minSnapshotsToKeep",
      label: "Min Snapshots to Keep",
      kind: "number",
      required: false,
      defaultValue: "5",
      minValue: 1,
      showWhen: whenSnapshots,
    },
    {
      key: "maintenanceToken",
      label: "Maintenance Token",
      kind: "password",
      required: false,
      description:
        "API token the maintenance jobs run with (needs R2 Storage and Data Catalog write). Leave blank to use this account's token.",
      showWhen: {
        anyOf: [
          { fieldKey: "compaction", fieldValue: "enabled" },
          { fieldKey: "snapshotExpiration", fieldValue: "enabled" },
        ],
      },
    },
  ];
}

/** Create forms for the Basin and Analytics Engine types, or null for any other type. */
export async function getDataPlatformCreateConfig(
  api: CloudflareApi,
  typeId: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "basin-catalog") {
    const buckets = await safe(() => getUncatalogedBucketOptions(api), []);
    return {
      fields: [
        {
          key: "bucket",
          label: "R2 Bucket",
          kind: "select",
          required: true,
          description:
            "Turns on the Iceberg REST catalog for this bucket. Create the bucket under R2 Buckets first if you need a new one.",
          options: buckets,
        },
        ...maintenanceFields(),
      ],
    };
  }

  if (typeId === "basin-stream") {
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          placeholder: "events",
          description: "Used as the table name in pipeline SQL (letters, digits, underscores)",
        },
        {
          key: "httpEnabled",
          label: "HTTP Ingest",
          kind: "select",
          required: false,
          defaultValue: "true",
          description: "Accept events by POST to the stream's ingest endpoint",
          options: ON_OFF,
        },
        {
          key: "httpAuthentication",
          label: "Require Token on HTTP Ingest",
          kind: "select",
          required: false,
          defaultValue: "true",
          description: "Callers must send a Cloudflare API token with Pipelines Send",
          showWhen: { fieldKey: "httpEnabled", fieldValue: "true" },
          options: ON_OFF,
        },
        {
          key: "corsOrigins",
          label: "CORS Origins",
          kind: "string-list",
          required: false,
          placeholder: "https://app.example.com",
          description: "Browser origins allowed to send events directly",
          showWhen: { fieldKey: "httpEnabled", fieldValue: "true" },
        },
        {
          key: "workerBinding",
          label: "Worker Binding",
          kind: "select",
          required: false,
          defaultValue: "true",
          description: "Allow Workers to send events through a `[[pipelines]]` binding",
          options: ON_OFF,
        },
        {
          key: "schema",
          label: "Schema",
          kind: "code",
          codeLanguage: "json",
          required: false,
          placeholder: '{ "fields": [{ "name": "user_id", "type": "string", "required": true }] }',
          description:
            "Optional. Typed fields (string, int32, int64, float32, float64, bool, timestamp, json, binary, list, struct) are validated on ingest. Leave blank for an unstructured stream. Can't be changed later.",
        },
      ],
    };
  }

  if (typeId === "basin-sink") {
    const [catalogBuckets, buckets] = await Promise.all([
      safe(() => getCatalogBucketOptions(api), []),
      safe(() => getBucketOptions(api), []),
    ]);
    const whenCatalog = { fieldKey: "type", fieldValue: "r2_data_catalog" };
    const whenR2 = { fieldKey: "type", fieldValue: "r2" };
    const whenParquet = {
      anyOf: [whenCatalog, { fieldKey: "format", fieldValue: "parquet" }],
    };
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true, placeholder: "events_sink" },
        {
          key: "type",
          label: "Destination",
          kind: "select",
          required: true,
          defaultValue: "r2_data_catalog",
          options: [
            { id: "r2_data_catalog", label: "Basin Catalog table (Iceberg)" },
            { id: "r2", label: "Files in an R2 bucket" },
          ],
        },
        {
          key: "catalogBucket",
          label: "Catalog",
          kind: "select",
          required: false,
          description:
            catalogBuckets.length > 0
              ? "A bucket with Basin Catalog enabled"
              : "No catalogs yet: create a Basin Catalog first",
          showWhen: whenCatalog,
          options: catalogBuckets,
        },
        {
          key: "namespace",
          label: "Namespace",
          kind: "text",
          required: false,
          defaultValue: "default",
          description: "Created if it doesn't exist",
          showWhen: whenCatalog,
        },
        {
          key: "tableName",
          label: "Table",
          kind: "text",
          required: false,
          description: "A new table name; a sink can't write into an existing table",
          showWhen: whenCatalog,
        },
        {
          key: "catalogToken",
          label: "Catalog Token",
          kind: "password",
          required: false,
          description:
            "API token the sink writes with (needs R2 Storage and Data Catalog write). Leave blank to use this account's token.",
          showWhen: whenCatalog,
        },
        {
          key: "bucket",
          label: "R2 Bucket",
          kind: "select",
          required: false,
          showWhen: whenR2,
          options: buckets,
        },
        {
          key: "path",
          label: "Path Prefix",
          kind: "text",
          required: false,
          placeholder: "analytics/events",
          showWhen: whenR2,
        },
        {
          key: "partitioning",
          label: "Partitioning",
          kind: "text",
          required: false,
          defaultValue: "year=%Y/month=%m/day=%d",
          description: "strftime pattern for the directory each file lands in",
          showWhen: whenR2,
        },
        {
          key: "format",
          label: "File Format",
          kind: "select",
          required: false,
          defaultValue: "parquet",
          showWhen: whenR2,
          options: [
            { id: "parquet", label: "Parquet" },
            { id: "json", label: "JSON (newline-delimited)" },
          ],
        },
        {
          key: "accessKeyId",
          label: "R2 Access Key ID",
          kind: "text",
          required: false,
          description:
            "Leave both R2 credentials blank to derive them from this account's API token (it needs R2 Storage write).",
          showWhen: whenR2,
        },
        {
          key: "secretAccessKey",
          label: "R2 Secret Access Key",
          kind: "password",
          required: false,
          showWhen: whenR2,
        },
        {
          key: "compression",
          label: "Compression",
          kind: "select",
          required: false,
          defaultValue: "zstd",
          showWhen: whenParquet,
          options: [
            { id: "zstd", label: "zstd" },
            { id: "snappy", label: "Snappy" },
            { id: "gzip", label: "gzip" },
            { id: "lz4", label: "LZ4" },
            { id: "uncompressed", label: "Uncompressed" },
          ],
        },
        {
          key: "rollIntervalSeconds",
          label: "Roll Interval (seconds)",
          kind: "number",
          required: false,
          defaultValue: "300",
          minValue: 10,
          description:
            "How often a new file is written. Catalog sinks need at least 60 so writes don't conflict with compaction.",
        },
        {
          key: "rollSizeMb",
          label: "Roll Size (MB)",
          kind: "number",
          required: false,
          minValue: 1,
          description: "Start a new file once the current one reaches this size",
        },
      ],
    };
  }

  if (typeId === "basin-pipeline") {
    const { streams, sinks } = await safe(() => getStreamAndSinkOptions(api), {
      streams: [],
      sinks: [],
    });
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          placeholder: "events_pipeline",
        },
        {
          key: "stream",
          label: "Source Stream",
          kind: "select",
          required: false,
          description:
            streams.length > 0
              ? "Where events come from"
              : "No streams yet: create a Basin Stream first",
          options: streams.map((s) => ({ id: s, label: s })),
        },
        {
          key: "sink",
          label: "Destination Sink",
          kind: "select",
          required: false,
          description:
            sinks.length > 0
              ? "Where results are written"
              : "No sinks yet: create a Basin Sink first",
          options: sinks.map((s) => ({ id: s, label: s })),
        },
        {
          key: "sql",
          label: "SQL",
          kind: "code",
          codeLanguage: "sql",
          required: false,
          placeholder: "INSERT INTO my_sink SELECT * FROM my_stream WHERE event_type = 'purchase'",
          description:
            "Optional. Leave blank to copy every event from the stream to the sink unchanged. Can't be edited after creation.",
        },
      ],
    };
  }

  return null;
}
