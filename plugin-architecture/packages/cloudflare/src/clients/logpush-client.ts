import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapLogpushJob(
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
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneId = String(zone["id"]);
    try {
      const jobs = await api.fetch<Array<Record<string, unknown>>>(`/zones/${zoneId}/logpush/jobs`);
      for (const job of jobs ?? []) {
        results.push(mapLogpushJob(job, accountId, zoneId));
      }
    } catch {
      // Skip zones where logpush is not available
    }
  }
  return results;
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
    destination_conf: fields["destinationConf"] ?? "",
    dataset: fields["dataset"] ?? "",
    enabled: true,
  };
  if (fields["name"]) body["name"] = fields["name"];
  const job = await api.fetch<Record<string, unknown>>(`/zones/${zoneId}/logpush/jobs`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return mapLogpushJob(job, accountId, zoneId);
}

export async function deleteLogpushJob(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, jobId] = externalId.split("/");
  if (!zoneId || !jobId) throw new Error("Invalid logpush job ID");
  await api.fetch(`/zones/${zoneId}/logpush/jobs/${jobId}`, { method: "DELETE" });
}
