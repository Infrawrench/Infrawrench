/**
 * Basin Pipelines (formerly Cloudflare Pipelines): streams, sinks and the SQL
 * pipelines that connect them.
 *
 * Verified 2026-10 against developers.cloudflare.com/api/resources/pipelines
 * and the `cloudflare` SDK 6.4 typings: the current surface is the v1 API,
 *   - streams:   GET/POST /accounts/{aid}/pipelines/v1/streams,
 *                GET/PATCH/DELETE .../streams/{id} (PATCH: HTTP ingest + Worker binding only)
 *   - sinks:     GET/POST .../pipelines/v1/sinks, GET/DELETE .../sinks/{id} (no update)
 *   - pipelines: GET/POST .../pipelines/v1/pipelines, GET/DELETE .../pipelines/{id}
 *                (no update: Cloudflare documents that pipeline SQL is immutable)
 * Basin GA (2026-10-01) kept these paths; the legacy v0 `/pipelines` API is
 * deprecated and not surfaced here. Permission: Pipelines Read / Write.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";

const SCOPE = "Account · Pipelines:Read";

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "true";
}

function positiveInt(v: string | undefined): number | undefined {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function instance(
  typeId: string,
  accountId: string,
  externalId: string,
  displayName: string,
  fields: ResourceInstance["fields"],
  outputs: Record<string, string>,
  createdAt: string,
  updatedAt: string,
): ResourceInstance {
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "cloudflare",
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields,
    resolvedOutputs: outputs,
    secretStates: [],
    externalId,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: updatedAt || new Date().toISOString(),
  };
}

// ── Streams ────────────────────────────────────────────────────────────────

/** Summarise a stream/sink schema: field list, or "Unstructured" when absent. */
function schemaSummary(schema: unknown): { summary: string; count: number } {
  const fields = rec(schema)["fields"];
  if (!Array.isArray(fields) || fields.length === 0) return { summary: "Unstructured", count: 0 };
  const parts = fields.map((f) => {
    const r = rec(f);
    const required = r["required"] === true ? "" : "?";
    return `${str(r["name"])}${required}: ${str(r["type"])}`;
  });
  return { summary: parts.join(", "), count: fields.length };
}

export function mapStream(s: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = str(s["id"]);
  const name = str(s["name"]);
  const http = rec(s["http"]);
  const cors = rec(http["cors"]);
  const origins = Array.isArray(cors["origins"]) ? cors["origins"].map(str) : [];
  const binding = rec(s["worker_binding"]);
  const format = rec(s["format"]);
  const schema = schemaSummary(s["schema"]);
  const endpoint = str(s["endpoint"]);
  return instance(
    "basin-stream",
    accountId,
    id,
    name,
    {
      name,
      endpoint,
      httpEnabled: http["enabled"] === true,
      httpAuthentication: http["authentication"] === true,
      corsOrigins: origins.join(", "),
      workerBinding: binding["enabled"] === true,
      format: str(format["type"]) || "json",
      schema: schema.summary,
      schemaFieldCount: schema.count,
      version: Number(s["version"] ?? 0),
      createdAt: str(s["created_at"]),
      modifiedAt: str(s["modified_at"]),
    },
    { streamId: id, streamName: name, endpoint },
    str(s["created_at"]),
    str(s["modified_at"]),
  );
}

export async function listStreams(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const out: ResourceInstance[] = [];
      for await (const s of api.cf.pipelines.streams.list({ account_id })) {
        out.push(mapStream(asRecord(s), accountId));
      }
      return out;
    },
    "Basin streams",
    SCOPE,
  );
}

export async function getStream(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const s = await api.cf.pipelines.streams.get(externalId, { account_id });
  return mapStream(asRecord(s), accountId);
}

/** Split the comma/newline-separated CORS origin list the forms submit. */
function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\n,]/)
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Parse the stream schema the create form accepts: either `{ "fields": [...] }`
 * (the shape Cloudflare's docs and `wrangler ... --schema-file` use) or a bare
 * array of fields. Blank means an unstructured stream.
 */
export function parseStreamSchema(raw: string | undefined): { fields: unknown[] } | undefined {
  const text = (raw ?? "").trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      'Schema must be JSON: { "fields": [{ "name": "user_id", "type": "string", "required": true }] }',
    );
  }
  const fields = Array.isArray(parsed) ? parsed : rec(parsed)["fields"];
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('Schema needs a non-empty "fields" array.');
  }
  return { fields };
}

export async function createStream(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const origins = parseOrigins(fields["corsOrigins"]);
  const schema = parseStreamSchema(fields["schema"]);
  const params = {
    account_id,
    name: fields["name"] ?? "",
    http: {
      enabled: bool(fields["httpEnabled"], true),
      authentication: bool(fields["httpAuthentication"], true),
      ...(origins.length > 0 ? { cors: { origins } } : {}),
    },
    worker_binding: { enabled: bool(fields["workerBinding"], true) },
    ...(schema ? { schema } : { format: { type: "json" as const, unstructured: true } }),
  };
  // The schema field union is wide (struct/list nest); the user's JSON is
  // passed through as-is and validated by Cloudflare.
  const s = await api.cf.pipelines.streams.create(
    params as Parameters<typeof api.cf.pipelines.streams.create>[0],
  );
  return mapStream(asRecord(s), accountId);
}

/** PATCH the only mutable parts of a stream: HTTP ingest and the Worker binding. */
export async function editStream(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  merged: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const origins = parseOrigins(merged["corsOrigins"]);
  const s = await api.cf.pipelines.streams.update(externalId, {
    account_id,
    http: {
      enabled: bool(merged["httpEnabled"], true),
      authentication: bool(merged["httpAuthentication"], true),
      cors: { origins },
    },
    worker_binding: { enabled: bool(merged["workerBinding"], true) },
  });
  return mapStream(asRecord(s), accountId);
}

export async function deleteStream(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.pipelines.streams.delete(externalId, { account_id });
}

// ── Sinks ──────────────────────────────────────────────────────────────────

export const SINK_TYPE_LABELS: Record<string, string> = {
  r2_data_catalog: "Basin Catalog table",
  r2: "R2 files",
};

export function mapSink(s: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = str(s["id"]);
  const name = str(s["name"]);
  const type = str(s["type"]);
  const config = rec(s["config"]);
  const rolling = rec(config["rolling_policy"]);
  const format = rec(s["format"]);
  const partitioning = rec(config["partitioning"]);
  const fileSize = Number(rolling["file_size_bytes"] ?? 0);
  return instance(
    "basin-sink",
    accountId,
    id,
    name,
    {
      name,
      type: SINK_TYPE_LABELS[type] ?? type,
      bucket: str(config["bucket"]),
      namespace: str(config["namespace"]),
      tableName: str(config["table_name"]),
      path: str(config["path"]),
      partitioning: str(partitioning["time_pattern"]),
      jurisdiction: str(config["jurisdiction"]),
      format: str(format["type"]),
      compression: str(format["compression"]),
      rollIntervalSeconds: Number(rolling["interval_seconds"] ?? 0) || "",
      rollSizeMb: fileSize > 0 ? Math.round(fileSize / 1_048_576) : "",
      createdAt: str(s["created_at"]),
      modifiedAt: str(s["modified_at"]),
    },
    { sinkId: id, sinkName: name },
    str(s["created_at"]),
    str(s["modified_at"]),
  );
}

export async function listSinks(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const out: ResourceInstance[] = [];
      for await (const s of api.cf.pipelines.sinks.list({ account_id })) {
        out.push(mapSink(asRecord(s), accountId));
      }
      return out;
    },
    "Basin sinks",
    SCOPE,
  );
}

export async function getSink(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const s = await api.cf.pipelines.sinks.get(externalId, { account_id });
  return mapSink(asRecord(s), accountId);
}

/**
 * The account's own token id, for deriving R2 S3 credentials. Tries the user
 * token verify endpoint, then the account-owned one.
 */
async function tokenId(api: CloudflareApi, account_id: string): Promise<string> {
  for (const path of ["/user/tokens/verify", `/accounts/${account_id}/tokens/verify`]) {
    try {
      // The SDK's raw `get` returns the `{ success, result }` envelope.
      const res = await api.cf.get<unknown, Record<string, unknown>>(path);
      const id = rec(rec(res)["result"])["id"];
      if (typeof id === "string" && id) return id;
    } catch {
      /* try the next shape */
    }
  }
  throw new Error(
    "Couldn't derive R2 credentials from this account's API token. Enter an R2 access key ID and secret instead.",
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * R2 S3 credentials for an R2 sink. Blank fields fall back to the account's
 * own API token, which Cloudflare documents as an R2 access key: the token id
 * is the Access Key ID and the SHA-256 of the token value is the secret
 * (developers.cloudflare.com/r2/api/tokens/).
 */
export async function resolveR2Credentials(
  api: CloudflareApi,
  account_id: string,
  fields: Record<string, string>,
): Promise<{ access_key_id: string; secret_access_key: string }> {
  const accessKeyId = (fields["accessKeyId"] ?? "").trim();
  const secret = (fields["secretAccessKey"] ?? "").trim();
  if (accessKeyId && secret) return { access_key_id: accessKeyId, secret_access_key: secret };
  if (accessKeyId || secret) {
    throw new Error("Enter both the R2 access key ID and secret, or leave both blank.");
  }
  return {
    access_key_id: await tokenId(api, account_id),
    secret_access_key: await sha256Hex(api.apiToken),
  };
}

const COMPRESSIONS = ["uncompressed", "snappy", "gzip", "zstd", "lz4"] as const;
type Compression = (typeof COMPRESSIONS)[number];
function compression(v: string | undefined): Compression {
  return (COMPRESSIONS as readonly string[]).includes(v ?? "") ? (v as Compression) : "zstd";
}

export async function createSink(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const type = fields["type"] === "r2" ? "r2" : "r2_data_catalog";
  const interval = positiveInt(fields["rollIntervalSeconds"]);
  const sizeMb = positiveInt(fields["rollSizeMb"]);
  const rolling_policy = {
    ...(interval ? { interval_seconds: interval } : {}),
    ...(sizeMb ? { file_size_bytes: sizeMb * 1_048_576 } : {}),
  };
  const hasRolling = Object.keys(rolling_policy).length > 0;

  let params: Parameters<typeof api.cf.pipelines.sinks.create>[0];
  if (type === "r2_data_catalog") {
    const bucket = fields["catalogBucket"] || fields["bucket"] || "";
    params = {
      account_id,
      name: fields["name"] ?? "",
      type,
      // Catalog sinks write Parquet only.
      format: { type: "parquet", compression: compression(fields["compression"]) },
      config: {
        account_id,
        bucket,
        namespace: fields["namespace"] || "default",
        table_name: fields["tableName"] ?? "",
        // Blank: the account's own token (it needs R2 Storage + Data Catalog write).
        token: (fields["catalogToken"] ?? "").trim() || api.apiToken,
        ...(hasRolling ? { rolling_policy } : {}),
      },
    };
  } else {
    const isJson = fields["format"] === "json";
    params = {
      account_id,
      name: fields["name"] ?? "",
      type,
      format: isJson
        ? { type: "json" }
        : { type: "parquet", compression: compression(fields["compression"]) },
      config: {
        account_id,
        bucket: fields["bucket"] ?? "",
        credentials: await resolveR2Credentials(api, account_id, fields),
        ...(fields["path"] ? { path: fields["path"] } : {}),
        ...(fields["partitioning"]
          ? { partitioning: { time_pattern: fields["partitioning"] } }
          : {}),
        ...(hasRolling ? { rolling_policy } : {}),
      },
    };
  }
  const s = await api.cf.pipelines.sinks.create(params);
  return mapSink(asRecord(s), accountId);
}

export async function deleteSink(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.pipelines.sinks.delete(externalId, { account_id });
}

// ── Pipelines ──────────────────────────────────────────────────────────────

export interface PipelineTable {
  name: string;
  type: string;
  version: number;
}

export function mapPipeline(p: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = str(p["id"]);
  const name = str(p["name"]);
  const tables = Array.isArray(p["tables"]) ? p["tables"].map(rec) : [];
  const names = (type: string) =>
    tables
      .filter((t) => str(t["type"]) === type)
      .map((t) => str(t["name"]))
      .join(", ");
  const fields: ResourceInstance["fields"] = {
    name,
    status: str(p["status"]),
    sql: str(p["sql"]),
    createdAt: str(p["created_at"]),
    modifiedAt: str(p["modified_at"]),
  };
  if (tables.length > 0) {
    fields["streams"] = names("stream");
    fields["sinks"] = names("sink");
  }
  if (p["failure_reason"]) fields["failureReason"] = str(p["failure_reason"]);
  return instance(
    "basin-pipeline",
    accountId,
    id,
    name,
    fields,
    { pipelineId: id, pipelineName: name },
    str(p["created_at"]),
    str(p["modified_at"]),
  );
}

export async function listPipelines(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const out: ResourceInstance[] = [];
      for await (const p of api.cf.pipelines.listV1({ account_id })) {
        out.push(mapPipeline(asRecord(p), accountId));
      }
      return out;
    },
    "Basin pipelines",
    SCOPE,
  );
}

/** Pipeline detail: unlike the list, carries the stream/sink tables and any failure reason. */
export async function getPipeline(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const p = await api.cf.pipelines.getV1(externalId, { account_id });
  return mapPipeline(asRecord(p), accountId);
}

/** Quote a stream/sink name for pipeline SQL when it isn't a plain identifier. */
function sqlIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** The SQL a pipeline runs when the user only picks a stream and a sink. */
export function defaultPipelineSql(stream: string, sink: string): string {
  return `INSERT INTO ${sqlIdent(sink)} SELECT * FROM ${sqlIdent(stream)}`;
}

export async function createPipeline(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  let sql = (fields["sql"] ?? "").trim();
  if (!sql) {
    const stream = fields["stream"] ?? "";
    const sink = fields["sink"] ?? "";
    if (!stream || !sink) throw new Error("Pick a stream and a sink, or write the pipeline SQL.");
    sql = defaultPipelineSql(stream, sink);
  }
  const created = await api.cf.pipelines.createV1({ account_id, name: fields["name"] ?? "", sql });
  return mapPipeline(asRecord(created), accountId);
}

export async function deletePipeline(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.pipelines.deleteV1(externalId, { account_id });
}

/** Stream and sink names for the pipeline create form's pickers. */
export async function getStreamAndSinkOptions(
  api: CloudflareApi,
): Promise<{ streams: string[]; sinks: string[] }> {
  const account_id = await api.getAccountId();
  const streams: string[] = [];
  const sinks: string[] = [];
  try {
    for await (const s of api.cf.pipelines.streams.list({ account_id })) streams.push(s.name);
  } catch {
    /* picker stays empty; SQL can still be typed */
  }
  try {
    for await (const s of api.cf.pipelines.sinks.list({ account_id })) sinks.push(s.name);
  } catch {
    /* as above */
  }
  return { streams, sinks };
}
