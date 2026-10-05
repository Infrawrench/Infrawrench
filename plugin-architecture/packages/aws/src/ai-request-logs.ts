/**
 * AI request logs on AWS: Bedrock model invocation logs (S3 or CloudWatch
 * Logs) and the documented custom JSONL format in an S3 bucket.
 *
 * Bedrock writes one JSON record per invocation with the model, token counts
 * (`input.inputTokenCount`, `input.cacheReadInputTokenCount`,
 * `input.cacheWriteInputTokenCount`, `output.outputTokenCount`) and the
 * caller-supplied `requestMetadata` object (the Converse `requestMetadata`
 * field or the `X-Amzn-Bedrock-Request-Metadata` header). The host joins those
 * to the Bedrock lines on the bill.
 *
 * - https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html
 * - https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-request-metadata.html
 * - https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetModelInvocationLoggingConfiguration.html
 *
 * Volume: an S3 day is streamed object by object and folded into an
 * `AiRequestAccumulator` as it is read, so memory is one object at a time and
 * nothing raw is returned. The CloudWatch path does the `GROUP BY` inside Logs
 * Insights (the network-flow precedent): only grouped rows cross the wire,
 * and the query is billed to the account per GB scanned, which the source
 * kind declares so the host can say so.
 */
import {
  DescribeLogGroupsCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  AiRequestAccumulator,
  AiRequestLogSetupError,
  objectKeyMatchesDay,
  parseAiRequestJsonLine,
  readMaybeGzipText,
  type AiRequestLogFetchRange,
  type AiRequestLogFetchResult,
  type AiRequestLogLocation,
  type AiRequestLogsCapabilityDeclaration,
  type AiRequestRecord,
} from "@infrawrench/plugin-base";

import type { AwsCredentials } from "./auth.js";
import { getAwsClients } from "./aws-clients.js";
import { getCallerIdentity } from "./preflight.js";
import { fetchSigned } from "./signed-request.js";
import { ensureArray, parseXml } from "./xml.js";

const LOGGING_HELP_URL =
  "https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html";

export const awsAiRequestLogCapability: AiRequestLogsCapabilityDeclaration = {
  sourceKinds: [
    {
      id: "bedrock-s3",
      label: "Bedrock invocation logs (S3)",
      description:
        "Reads the gzipped invocation-log objects Bedrock delivers to S3 and splits Bedrock spend by the requestMetadata your callers attach.",
      locationLabel: "Bucket",
      maxHistoryDays: 90,
      helpUrl: LOGGING_HELP_URL,
    },
    {
      id: "bedrock-cloudwatch",
      label: "Bedrock invocation logs (CloudWatch Logs)",
      description:
        "Aggregates the invocation-log group with a Logs Insights query. Each daily query is billed to this AWS account per GB scanned.",
      locationLabel: "Log group",
      maxHistoryDays: 30,
      queriesBillable: true,
      helpUrl: LOGGING_HELP_URL,
    },
    {
      id: "jsonl-s3",
      label: "Custom request logs (JSONL in S3)",
      description:
        "Reads one JSON object per request from files under a prefix, in the documented Infrawrench request-log format.",
      locationLabel: "Bucket",
      maxHistoryDays: 90,
      acceptsPrefix: true,
    },
  ],
};

/** Objects read per day before the day is marked degraded rather than finished. */
const MAX_OBJECTS_PER_DAY = 5000;
const QUERY_POLL_MS = 2000;
const QUERY_TIMEOUT_MS = 10 * 60 * 1000;

class AiLogAuthorizationWithdrawnError extends Error {
  constructor(day: string) {
    super(`Host withdrew authorization while reading AI request logs for ${day}`);
    this.name = "AiLogAuthorizationWithdrawnError";
  }
}

interface LoggingConfig {
  s3Config?: { bucketName?: string; keyPrefix?: string };
  cloudWatchConfig?: { logGroupName?: string };
}

/** Bedrock's invocation-logging configuration for the credential's region. */
async function getLoggingConfig(creds: AwsCredentials): Promise<LoggingConfig | null> {
  const host = `bedrock.${creds.region}.amazonaws.com`;
  try {
    const res = await fetchSigned({
      method: "GET",
      url: `https://${host}/logging/modelinvocations`,
      headers: { Host: host },
      service: "bedrock",
      credentials: creds,
    });
    const body = (await res.json()) as { loggingConfig?: LoggingConfig };
    return body.loggingConfig ?? null;
  } catch {
    return null;
  }
}

async function listBuckets(
  creds: AwsCredentials,
): Promise<Array<{ name: string; region: string }>> {
  const res = await fetchSigned({
    method: "GET",
    url: "https://s3.amazonaws.com/?max-buckets=1000",
    headers: { Host: "s3.amazonaws.com" },
    service: "s3",
    credentials: { ...creds, region: "us-east-1" },
  });
  const xml = parseXml(await res.text()) as Record<string, unknown>;
  const buckets = (xml["Buckets"] ?? {}) as Record<string, unknown>;
  return (ensureArray(buckets["Bucket"]) as Record<string, unknown>[]).map((b) => ({
    name: String(b["Name"] ?? ""),
    region: String(b["BucketRegion"] ?? ""),
  }));
}

/** Location picker options for one source kind. */
export async function listAwsAiRequestLogLocations(
  creds: AwsCredentials,
  sourceKindId: string,
): Promise<AiRequestLogLocation[]> {
  const config =
    sourceKindId === "jsonl-s3" ? null : await getLoggingConfig(creds).catch(() => null);
  if (sourceKindId === "bedrock-cloudwatch") {
    const out: AiRequestLogLocation[] = [];
    const configured = config?.cloudWatchConfig?.logGroupName;
    if (configured) {
      out.push({
        id: configured,
        label: configured,
        detail: `${creds.region} · Bedrock's configured invocation-log group`,
        location: { logGroupName: configured, region: creds.region },
        recommended: true,
      });
    }
    const logs = getAwsClients(creds).cloudWatchLogs;
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await logs.send(new DescribeLogGroupsCommand({ limit: 50, nextToken: token }));
      for (const g of page.logGroups ?? []) {
        const name = g.logGroupName ?? "";
        if (!name || name === configured) continue;
        out.push({
          id: name,
          label: name,
          detail: creds.region,
          location: { logGroupName: name, region: creds.region },
        });
      }
      token = page.nextToken;
      pages++;
    } while (token && pages < 10);
    return out;
  }

  const out: AiRequestLogLocation[] = [];
  const configuredBucket = config?.s3Config?.bucketName;
  if (sourceKindId === "bedrock-s3" && configuredBucket) {
    const prefix = config?.s3Config?.keyPrefix ?? "";
    out.push({
      id: `${configuredBucket}/${prefix}`,
      label: prefix ? `${configuredBucket}/${prefix}` : configuredBucket,
      detail: `${creds.region} · Bedrock's configured invocation-log destination`,
      location: { bucket: configuredBucket, prefix, region: creds.region },
      recommended: true,
    });
  }
  for (const b of await listBuckets(creds)) {
    if (!b.name || (sourceKindId === "bedrock-s3" && b.name === configuredBucket)) continue;
    // Bedrock only delivers to a bucket in its own region.
    if (sourceKindId === "bedrock-s3" && b.region && b.region !== creds.region) continue;
    out.push({
      id: b.name,
      label: b.name,
      ...(b.region ? { detail: b.region } : {}),
      location: { bucket: b.name, prefix: "", region: b.region || creds.region },
    });
  }
  return out;
}

/** Every object key under a prefix (no delimiter), up to `limit`. */
async function listKeys(
  creds: AwsCredentials,
  bucket: string,
  prefix: string,
  limit: number,
): Promise<{ keys: string[]; truncated: boolean }> {
  const host = `${bucket}.s3.${creds.region}.amazonaws.com`;
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
    if (prefix) params.set("prefix", prefix);
    if (token) params.set("continuation-token", token);
    const res = await fetchSigned({
      method: "GET",
      url: `https://${host}/?${params}`,
      headers: { Host: host },
      service: "s3",
      credentials: creds,
    });
    const data = parseXml(await res.text()) as Record<string, unknown>;
    for (const obj of ensureArray(data["Contents"]) as Record<string, unknown>[]) {
      const key = String(obj["Key"] ?? "");
      if (key && !key.endsWith("/")) keys.push(key);
      if (keys.length >= limit) return { keys, truncated: true };
    }
    token =
      data["IsTruncated"] === "true" ? String(data["NextContinuationToken"] ?? "") : undefined;
  } while (token);
  return { keys, truncated: false };
}

async function getObjectText(creds: AwsCredentials, bucket: string, key: string): Promise<string> {
  const host = `${bucket}.s3.${creds.region}.amazonaws.com`;
  const res = await fetchSigned({
    method: "GET",
    url: `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`,
    headers: { Host: host },
    service: "s3",
    credentials: creds,
    binary: true,
  });
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Gzip magic number, so a `.json.gz` that S3 serves with
  // Content-Encoding (already decoded by fetch) is not decoded twice.
  const gzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return await readMaybeGzipText(buf, gzip);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** One Bedrock invocation-log record in the shared shape. */
export function parseBedrockInvocationRecord(raw: unknown): AiRequestRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r["schemaType"] !== undefined && r["schemaType"] !== "ModelInvocationLog") return null;
  const modelId = typeof r["modelId"] === "string" ? r["modelId"] : "";
  if (!modelId) return null;
  const input = (r["input"] ?? {}) as Record<string, unknown>;
  const output = (r["output"] ?? {}) as Record<string, unknown>;
  const metadata = r["requestMetadata"];
  return {
    ...(typeof r["timestamp"] === "string" ? { timestamp: r["timestamp"] } : {}),
    provider: "bedrock",
    // An inference-profile or application-profile ARN carries the model id as
    // its last path segment; normalization on the host strips the rest.
    model: modelId,
    inputTokens: num(input["inputTokenCount"]),
    outputTokens: num(output["outputTokenCount"]),
    cacheReadTokens: num(input["cacheReadInputTokenCount"]),
    cacheWriteTokens: num(input["cacheWriteInputTokenCount"]),
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { metadata: metadata as Record<string, unknown> }
      : {}),
  };
}

/** The day's S3 prefix Bedrock delivers under. */
export function bedrockDayPrefix(
  keyPrefix: string,
  accountNumber: string,
  region: string,
  day: string,
): string {
  const [y, m, d] = day.split("-");
  const base = keyPrefix ? `${keyPrefix.replace(/\/+$/, "")}/` : "";
  return `${base}AWSLogs/${accountNumber}/BedrockModelInvocationLogs/${region}/${y}/${m}/${d}/`;
}

async function fetchFromS3(
  creds: AwsCredentials,
  range: AiRequestLogFetchRange,
  mode: "bedrock" | "jsonl",
): Promise<AiRequestLogFetchResult> {
  const bucket = range.location["bucket"];
  if (!bucket) throw new AiRequestLogSetupError("No bucket selected for this request-log source.");
  const region = range.location["region"] || creds.region;
  const regional = { ...creds, region };
  const acc = new AiRequestAccumulator(range.day, range.metadataKeys);
  const keyPrefix = range.location["prefix"] ?? "";

  let prefix: string;
  if (mode === "bedrock") {
    const identity = await getCallerIdentity(creds);
    if (!identity.account) throw new Error("Could not resolve the AWS account number via STS");
    prefix = bedrockDayPrefix(keyPrefix, identity.account, region, range.day);
  } else {
    prefix = keyPrefix;
  }

  let listing: { keys: string[]; truncated: boolean };
  try {
    listing = await listKeys(regional, bucket, prefix, MAX_OBJECTS_PER_DAY * 4);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b403\b|AccessDenied/.test(message)) {
      throw new AiRequestLogSetupError(
        `This credential cannot list s3://${bucket}/${prefix}: grant s3:ListBucket and s3:GetObject on it.`,
        LOGGING_HELP_URL,
      );
    }
    throw err;
  }

  const keys =
    mode === "jsonl"
      ? listing.keys.filter((k) => objectKeyMatchesDay(k, range.day))
      : listing.keys.filter((k) => k.endsWith(".json.gz") || k.endsWith(".json"));
  let degraded = listing.truncated || keys.length > MAX_OBJECTS_PER_DAY;

  for (const key of keys.slice(0, MAX_OBJECTS_PER_DAY)) {
    if (range.signal?.aborted) throw new AiLogAuthorizationWithdrawnError(range.day);
    // Bedrock's large-data objects (bodies over 100 KB) live under a `data/`
    // segment and are not log records.
    if (mode === "bedrock" && /\/data\//.test(key)) continue;
    let text: string;
    try {
      text = await getObjectText(regional, bucket, key);
    } catch {
      degraded = true;
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      if (mode === "jsonl") {
        const rec = parseAiRequestJsonLine(line);
        if (rec) acc.add(rec);
        else acc.skip();
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        acc.skip();
        continue;
      }
      const rec = parseBedrockInvocationRecord(parsed);
      if (rec) acc.add(rec);
      else acc.skip();
    }
  }
  return acc.result(degraded ? { degraded: true } : {});
}

/** Logs Insights field reference, backticked so metadata keys with dots or dashes parse. */
function insightsField(path: string): string {
  return `\`${path.replace(/`/g, "")}\``;
}

/** The grouped Logs Insights query for one day. Exported for tests. */
export function bedrockInsightsQuery(metadataKeys: string[]): string {
  const aliases = metadataKeys.map((_, i) => `m${i}`);
  const fields = [
    "modelId",
    ...metadataKeys.map((k, i) => `${insightsField(`requestMetadata.${k}`)} as ${aliases[i]}`),
    "input.inputTokenCount as it",
    "output.outputTokenCount as ot",
    "input.cacheReadInputTokenCount as crt",
    "input.cacheWriteInputTokenCount as cwt",
  ];
  return [
    `fields ${fields.join(", ")}`,
    `| filter schemaType = "ModelInvocationLog"`,
    `| stats count(*) as n, sum(it) as ti, sum(ot) as tout, sum(crt) as tcr, sum(cwt) as tcw by ${["modelId", ...aliases].join(", ")}`,
    "| limit 10000",
  ].join("\n");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function fetchFromCloudWatch(
  creds: AwsCredentials,
  range: AiRequestLogFetchRange,
): Promise<AiRequestLogFetchResult> {
  const logGroupName = range.location["logGroupName"];
  if (!logGroupName) throw new AiRequestLogSetupError("No log group selected for this source.");
  if (range.signal?.aborted) throw new AiLogAuthorizationWithdrawnError(range.day);
  const logs = getAwsClients(creds).cloudWatchLogs;
  const start = Date.parse(`${range.day}T00:00:00.000Z`) / 1000;
  const started = await logs.send(
    new StartQueryCommand({
      logGroupName,
      startTime: Math.floor(start),
      endTime: Math.floor(start + 86399),
      queryString: bedrockInsightsQuery(range.metadataKeys),
    }),
  );
  const queryId = started.queryId;
  if (!queryId) throw new Error("CloudWatch Logs Insights did not return a query id");
  const stop = async () => {
    try {
      await logs.send(new StopQueryCommand({ queryId }));
    } catch {
      // Already finished or unreachable.
    }
  };
  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  for (;;) {
    if (range.signal?.aborted) {
      await stop();
      throw new AiLogAuthorizationWithdrawnError(range.day);
    }
    const result = await logs.send(new GetQueryResultsCommand({ queryId }));
    const status = result.status ?? "Running";
    if (status === "Complete") {
      return foldInsightsRows(
        range.day,
        range.metadataKeys,
        result.results ?? [],
        result.statistics?.bytesScanned ?? 0,
      );
    }
    if (status === "Failed" || status === "Cancelled" || status === "Timeout") {
      throw new Error(`CloudWatch Logs Insights query ${status.toLowerCase()} for ${logGroupName}`);
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`CloudWatch Logs Insights query for ${logGroupName} did not finish in time`);
    }
    await sleep(QUERY_POLL_MS, range.signal);
  }
}

/** Grouped Insights rows → aggregates. Exported for tests. */
export function foldInsightsRows(
  day: string,
  metadataKeys: string[],
  rows: ResultField[][],
  bytesScanned: number,
): AiRequestLogFetchResult {
  void day;
  let requests = 0;
  const aggregates: AiRequestLogFetchResult["aggregates"] = [];
  for (const row of rows) {
    const get = (f: string) => {
      const v = row.find((x) => x.field === f)?.value;
      return v === undefined || v === "" ? undefined : v;
    };
    const model = get("modelId");
    if (!model) continue;
    const n = Number(get("n") ?? 0);
    requests += n;
    const metadata: Record<string, string> = {};
    metadataKeys.forEach((k, i) => {
      const v = get(`m${i}`);
      if (v !== undefined) metadata[k] = v;
    });
    aggregates.push({
      provider: "bedrock",
      model,
      metadata,
      requests: n,
      inputTokens: Number(get("ti") ?? 0),
      outputTokens: Number(get("tout") ?? 0),
      cacheReadTokens: Number(get("tcr") ?? 0),
      cacheWriteTokens: Number(get("tcw") ?? 0),
      reasoningTokens: 0,
    });
  }
  return {
    aggregates,
    requests,
    skipped: 0,
    // A grouped query cannot enumerate keys it was not asked about.
    observedMetadataKeys: {},
    queryBytesScanned: bytesScanned,
    ...(rows.length >= 10000 ? { degraded: true } : {}),
  };
}

export async function fetchAwsAiRequestLogs(
  creds: AwsCredentials,
  range: AiRequestLogFetchRange,
): Promise<AiRequestLogFetchResult> {
  switch (range.sourceKindId) {
    case "bedrock-s3":
      return fetchFromS3(creds, range, "bedrock");
    case "jsonl-s3":
      return fetchFromS3(creds, range, "jsonl");
    case "bedrock-cloudwatch":
      return fetchFromCloudWatch(creds, range);
    default:
      throw new Error(`Unknown AWS request-log source kind "${range.sourceKindId}"`);
  }
}

/** Bedrock rows on the bill, for the normalized AI cost tags. */
export function classifyAwsCostRow(service: string | undefined): {
  provider: string;
  model?: string;
} | null {
  if (!service) return null;
  // Third-party models on Bedrock are billed as AWS Marketplace services
  // named "<Model> (Amazon Bedrock Edition)": that name is the model.
  const edition = /^(.*)\(Amazon Bedrock Edition\)\s*$/i.exec(service);
  if (edition) return { provider: "bedrock", model: edition[1]!.trim() };
  if (/bedrock/i.test(service)) return { provider: "bedrock" };
  return null;
}
