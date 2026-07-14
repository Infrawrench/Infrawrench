import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone } from "./shared.js";

function mapLogpushJob(
  job: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(job["id"] ?? "");
  const name = String(job["name"] ?? "");
  const dataset = String(job["dataset"] ?? "");
  const destinationConf = String(job["destination_conf"] ?? "");
  // Extract destination type from the destination_conf URL scheme
  const destType = destinationConf.split("://")[0] ?? "";
  return {
    id: `${accountId}:logpush-job:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "logpush-job",
    accountId,
    displayName: name || `${dataset} → ${destType}`,
    fields: {
      name,
      enabled: Boolean(job["enabled"]),
      dataset,
      destinationType: destType,
      frequency: String(job["frequency"] ?? ""),
      logpullOptions: String(job["logpull_options"] ?? ""),
      lastComplete: String(job["last_complete"] ?? ""),
      lastError: String(job["last_error"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listAllLogpushJobs(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return collectPerZone(
    api,
    async (zoneId) => {
      const part: ResourceInstance[] = [];
      for await (const job of api.cf.logpush.jobs.list({ zone_id: zoneId })) {
        if (!job) continue;
        part.push(mapLogpushJob(asRecord(job), accountId, zoneId));
      }
      return part;
    },
    "logpush jobs",
    "Zone · Logs:Read",
  );
}

export async function createLogpushJob(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a logpush job");
  const body: Record<string, unknown> = {
    zone_id: zoneId,
    destination_conf: fields["destinationConf"] ?? "",
    dataset: fields["dataset"] ?? "",
    enabled: true,
  };
  if (fields["name"]) body["name"] = fields["name"];
  const job = await api.cf.logpush.jobs.create(
    body as unknown as Parameters<typeof api.cf.logpush.jobs.create>[0],
  );
  if (!job) throw new Error("Cloudflare plugin: failed to create logpush job (null response)");
  return mapLogpushJob(asRecord(job), accountId, zoneId);
}

export async function editLogpushJob(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, jobId] = externalId.split("/");
  if (!zoneId || !jobId) throw new Error("Invalid logpush job ID");
  // Logpush update is a PATCH — only send the editable settings.
  const body: Record<string, unknown> = { zone_id: zoneId };
  if (fields["enabled"] !== undefined) body["enabled"] = fields["enabled"] === "true";
  if (fields["frequency"]) body["frequency"] = fields["frequency"];
  if (fields["logpullOptions"] !== undefined) body["logpull_options"] = fields["logpullOptions"];
  if (fields["destinationConf"]) body["destination_conf"] = fields["destinationConf"];
  const job = await api.cf.logpush.jobs.update(
    jobId as unknown as number,
    body as unknown as Parameters<typeof api.cf.logpush.jobs.update>[1],
  );
  if (!job) throw new Error("Cloudflare plugin: failed to update logpush job (null response)");
  return mapLogpushJob(asRecord(job), accountId, zoneId);
}

export async function deleteLogpushJob(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, jobId] = externalId.split("/");
  if (!zoneId || !jobId) throw new Error("Invalid logpush job ID");
  // The SDK types JobDelete as taking `jobId: number` but the v4 API accepts
  // both. Cast through unknown to preserve the existing string-id contract.
  await api.cf.logpush.jobs.delete(jobId as unknown as number, { zone_id: zoneId });
}
