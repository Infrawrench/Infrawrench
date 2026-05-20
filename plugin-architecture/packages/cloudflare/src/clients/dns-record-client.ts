import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import type { RecordResponse, RecordCreateParams } from "cloudflare/resources/dns/records";

function recordFields(r: RecordResponse, zoneId: string): ResourceInstance {
  const rec = r as unknown as Record<string, unknown>;
  const type = String(rec["type"] ?? "");
  const name = String(rec["name"] ?? "");
  const content = String(rec["content"] ?? "");
  return {
    id: `:dns-record:${zoneId}/${String(rec["id"])}`,
    pluginId: "cloudflare",
    resourceTypeId: "dns-record",
    accountId: "",
    displayName: `${type} ${name}`,
    fields: {
      type,
      name,
      content,
      ttl: Number(rec["ttl"] ?? 1),
      proxied: Boolean(rec["proxied"]),
      ...(rec["priority"] !== undefined ? { priority: Number(rec["priority"]) } : {}),
      zoneName: String(rec["zone_name"] ?? ""),
      ...(rec["comment"] ? { comment: String(rec["comment"]) } : {}),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${String(rec["id"])}`,
    createdAt: String(rec["created_on"] ?? new Date().toISOString()),
    updatedAt: String(rec["modified_on"] ?? new Date().toISOString()),
  };
}

function mapDnsRecord(r: RecordResponse, accountId: string, zoneId: string): ResourceInstance {
  const base = recordFields(r, zoneId);
  return {
    ...base,
    id: `${accountId}:dns-record:${zoneId}/${String((r as unknown as { id: string }).id)}`,
    accountId,
    parentResourceId: `${accountId}:zone:${zoneId}`,
  };
}

export async function listAllDnsRecords(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const results: ResourceInstance[] = [];
  for await (const zone of api.cf.zones.list()) {
    const zoneId = zone.id;
    for await (const r of api.cf.dns.records.list({ zone_id: zoneId })) {
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
  const results: ResourceInstance[] = [];
  for await (const r of api.cf.dns.records.list({ zone_id: zoneId })) {
    results.push(mapDnsRecord(r, accountId, zoneId));
  }
  return results;
}

export async function getDnsRecord(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const [zoneId, recordId] = externalId.split("/");
  if (!zoneId || !recordId) throw new Error("Invalid DNS record ID");
  const record = await api.cf.dns.records.get(recordId, { zone_id: zoneId });
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
  // RecordCreateParams is a large discriminated union (per-type). We assemble
  // a generic body and let the API validate type/content compatibility.
  const body: Record<string, unknown> = {
    zone_id: zoneId,
    type: fields["type"],
    name: fields["name"],
    content: fields["content"],
    ttl: Number(fields["ttl"] ?? 1),
    proxied: fields["proxied"] === "true",
  };
  if (fields["priority"]) body["priority"] = Number(fields["priority"]);
  const record = await api.cf.dns.records.create(body as unknown as RecordCreateParams);
  return mapDnsRecord(record, accountId, zoneId);
}

export async function deleteDnsRecord(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, recordId] = externalId.split("/");
  if (!zoneId || !recordId) throw new Error("Invalid DNS record ID");
  await api.cf.dns.records.delete(recordId, { zone_id: zoneId });
}
