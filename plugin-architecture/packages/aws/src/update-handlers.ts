import type { AwsCredentials } from "./auth.js";
import { hostForService, queryPostCall } from "./client-transport.js";
import { fetchSigned } from "./signed-request.js";

/**
 * Edit paths for resource types whose `updateResource` needs more than a
 * line or two. Each pair is a pure request builder (unit-tested) plus the
 * call that sends it. Only fields the user actually changed arrive here, so
 * every builder treats a missing or blank field as "leave as it is".
 */

function intField(fields: Record<string, string>, key: string): number | undefined {
  const raw = fields[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return Math.trunc(n);
}

function inRange(key: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (value < min || value > max) {
    throw new Error(
      max === Number.MAX_SAFE_INTEGER
        ? `${key} must be at least ${min}`
        : `${key} must be between ${min} and ${max}`,
    );
  }
}

/**
 * Body for Lambda `UpdateFunctionConfiguration`
 * (https://docs.aws.amazon.com/lambda/latest/api/API_UpdateFunctionConfiguration.html).
 *
 * The two log levels are only accepted alongside the JSON log format, so
 * they are sent with `LogFormat: "JSON"` whenever one of them changes; a
 * switch to Text sends the format alone, which also clears the levels.
 */
export function buildLambdaConfigurationUpdate(
  fields: Record<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const memory = intField(fields, "memorySize");
  inRange("memorySize", memory, 128, 32768);
  if (memory !== undefined) body["MemorySize"] = memory;
  const timeout = intField(fields, "timeout");
  inRange("timeout", timeout, 1, 900);
  if (timeout !== undefined) body["Timeout"] = timeout;
  const tmp = intField(fields, "ephemeralStorageMb");
  inRange("ephemeralStorageMb", tmp, 512, 10240);
  if (tmp !== undefined) body["EphemeralStorage"] = { Size: tmp };
  if (fields["runtime"]) body["Runtime"] = fields["runtime"];

  const format = fields["logFormat"];
  const appLevel = fields["applicationLogLevel"];
  const sysLevel = fields["systemLogLevel"];
  if (format === "Text") {
    body["LoggingConfig"] = { LogFormat: "Text" };
  } else if (format === "JSON" || appLevel || sysLevel) {
    body["LoggingConfig"] = {
      LogFormat: "JSON",
      ...(appLevel ? { ApplicationLogLevel: appLevel } : {}),
      ...(sysLevel ? { SystemLogLevel: sysLevel } : {}),
    };
  }
  return body;
}

export async function updateLambdaFunction(
  creds: AwsCredentials,
  functionName: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = buildLambdaConfigurationUpdate(fields);
  if (Object.keys(body).length === 0) return {};
  const host = hostForService(creds, "lambda");
  const res = await fetchSigned({
    method: "PUT",
    url: `https://${host}/2015-03-31/functions/${encodeURIComponent(functionName)}/configuration`,
    headers: { Host: host, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    service: "lambda",
    credentials: creds,
  });
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Query parameters for ElastiCache `ModifyServerlessCache`
 * (https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_ModifyServerlessCache.html).
 *
 * CacheUsageLimits is replaced as a whole, so when either ceiling changes
 * both are sent, the unchanged one from the cache's current value. A ceiling
 * of 0 (or blank on both) means "no limit" and is omitted.
 */
export function buildServerlessCacheModifyParams(
  name: string,
  fields: Record<string, string>,
  current: Record<string, unknown>,
): Record<string, string> {
  const params: Record<string, string> = { ServerlessCacheName: name };
  if (fields["description"] !== undefined) params["Description"] = fields["description"];

  const storage = intField(fields, "maxDataStorageGb");
  // AWS publishes no fixed ceiling for either limit (it is a per-engine
  // quota), so only reject what can never be valid and let the API judge
  // the rest.
  inRange("maxDataStorageGb", storage, 0, Number.MAX_SAFE_INTEGER);
  const ecpu = intField(fields, "maxEcpuPerSecond");
  inRange("maxEcpuPerSecond", ecpu, 0, Number.MAX_SAFE_INTEGER);
  if (storage !== undefined || ecpu !== undefined) {
    const s = storage ?? Number(current["maxDataStorageGb"] ?? 0);
    const e = ecpu ?? Number(current["maxEcpuPerSecond"] ?? 0);
    if (s > 0) {
      params["CacheUsageLimits.DataStorage.Maximum"] = String(s);
      params["CacheUsageLimits.DataStorage.Unit"] = "GB";
    }
    if (e > 0) params["CacheUsageLimits.ECPUPerSecond.Maximum"] = String(e);
  }

  const retention = intField(fields, "snapshotRetentionLimit");
  inRange("snapshotRetentionLimit", retention, 0, 35);
  if (retention !== undefined) params["SnapshotRetentionLimit"] = String(retention);
  if (fields["dailySnapshotTime"]) params["DailySnapshotTime"] = fields["dailySnapshotTime"];
  return params;
}

export async function modifyServerlessCache(
  creds: AwsCredentials,
  params: Record<string, string>,
): Promise<void> {
  await queryPostCall(creds, "elasticache", "ModifyServerlessCache", "2015-02-02", params);
}
