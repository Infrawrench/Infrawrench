import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapDnsRecord(
  r: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const type = String(r["type"] ?? "");
  const name = String(r["name"] ?? "");
  const content = String(r["content"] ?? "");
  return {
    id: `${accountId}:dns-record:${zoneId}/${String(r["id"])}`,
    pluginId: "cloudflare",
    resourceTypeId: "dns-record",
    accountId,
    displayName: `${type} ${name}`,
    fields: {
      type,
      name,
      content,
      ttl: Number(r["ttl"] ?? 1),
      proxied: Boolean(r["proxied"]),
      ...(r["priority"] !== undefined ? { priority: Number(r["priority"]) } : {}),
      zoneName: String(r["zone_name"] ?? ""),
      ...(r["comment"] ? { comment: String(r["comment"]) } : {}),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${String(r["id"])}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: String(r["created_on"] ?? new Date().toISOString()),
    updatedAt: String(r["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listAllDnsRecords(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneId = String(zone["id"]);
    const records = await api.paginate<Record<string, unknown>>(`/zones/${zoneId}/dns_records`);
    for (const r of records) {
      results.push(mapDnsRecord(r, accountId, zoneId));
    }
  }
  return results;
}

export async function listDnsRecordsForZone(
  api: CloudflareApi,
  zoneId: string,
  accountId: string,
): Promise<ResourceInstance[]> {
  const records = await api.paginate<Record<string, unknown>>(`/zones/${zoneId}/dns_records`);
  return records.map((r) => mapDnsRecord(r, accountId, zoneId));
}

export async function getDnsRecord(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const [zoneId, recordId] = externalId.split("/");
  if (!zoneId || !recordId) throw new Error("Invalid DNS record ID");
  const record = await api.fetch<Record<string, unknown>>(
    `/zones/${zoneId}/dns_records/${recordId}`,
  );
  return mapDnsRecord(record, accountId, zoneId);
}

export async function createDnsRecord(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a DNS record");
  const body: Record<string, unknown> = {
    type: fields["type"],
    name: fields["name"],
    content: fields["content"],
    ttl: Number(fields["ttl"] ?? 1),
    proxied: fields["proxied"] === "true",
  };
  if (fields["priority"]) {
    body["priority"] = Number(fields["priority"]);
  }
  const record = await api.fetch<Record<string, unknown>>(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return mapDnsRecord(record, accountId, zoneId);
}

export async function deleteDnsRecord(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, recordId] = externalId.split("/");
  if (!zoneId || !recordId) throw new Error("Invalid DNS record ID");
  await api.fetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: "DELETE" });
}
