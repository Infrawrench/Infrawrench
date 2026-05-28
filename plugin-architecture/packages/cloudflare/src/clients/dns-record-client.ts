import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { collectPerZone, withAuthErrorHint } from "./shared.js";
import type { RecordResponse, RecordCreateParams } from "cloudflare/resources/dns/records";

function recordFields(r: RecordResponse, zoneId: string): ResourceInstance {
  const type = r.type ?? "";
  const name = r.name ?? "";
  // `content` and `proxied` are only present on certain record types in the
  // discriminated union (A/AAAA/CNAME etc.) — read them through a permissive
  // view so we can extract them uniformly without a giant per-type switch.
  const rec = r as unknown as Record<string, unknown>;
  const content = String(rec["content"] ?? "");
  return {
    id: `:dns-record:${zoneId}/${r.id}`,
    pluginId: "cloudflare",
    resourceTypeId: "dns-record",
    accountId: "",
    displayName: `${type} ${name}`,
    fields: {
      type,
      name,
      content,
      ttl: Number(r.ttl ?? 1),
      proxied: Boolean(rec["proxied"]),
      ...(rec["priority"] !== undefined ? { priority: Number(rec["priority"]) } : {}),
      zoneName: String(rec["zone_name"] ?? ""),
      ...(r.comment ? { comment: r.comment } : {}),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${r.id}`,
    createdAt: r.created_on ?? new Date().toISOString(),
    updatedAt: r.modified_on ?? new Date().toISOString(),
  };
}

function mapDnsRecord(r: RecordResponse, accountId: string, zoneId: string): ResourceInstance {
  const base = recordFields(r, zoneId);
  return {
    ...base,
    id: `${accountId}:dns-record:${zoneId}/${r.id}`,
    accountId,
    parentResourceId: `${accountId}:zone:${zoneId}`,
  };
}

export async function listAllDnsRecords(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return collectPerZone(
    api,
    async (zoneId) => {
      const part: ResourceInstance[] = [];
      for await (const r of api.cf.dns.records.list({ zone_id: zoneId })) {
        part.push(mapDnsRecord(r, accountId, zoneId));
      }
      return part;
    },
    "DNS records",
    "Zone · DNS:Read",
  );
}

export async function listDnsRecordsForZone(
  api: CloudflareApi,
  zoneId: string,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const results: ResourceInstance[] = [];
      for await (const r of api.cf.dns.records.list({ zone_id: zoneId })) {
        results.push(mapDnsRecord(r, accountId, zoneId));
      }
      return results;
    },
    "DNS records",
    "Zone · DNS:Read",
  );
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

export async function updateDnsRecord(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, recordId] = externalId.split("/");
  if (!zoneId || !recordId) throw new Error("Invalid DNS record ID");
  // Cloudflare's edit endpoint (PATCH) merges only the supplied keys, so the
  // reconciler can push a fresh `content` without re-sending the whole record.
  const body: Record<string, unknown> = { zone_id: zoneId };
  if (fields["type"] !== undefined) body["type"] = fields["type"];
  if (fields["name"] !== undefined) body["name"] = fields["name"];
  if (fields["content"] !== undefined) body["content"] = fields["content"];
  if (fields["ttl"] !== undefined) body["ttl"] = Number(fields["ttl"]);
  if (fields["proxied"] !== undefined) body["proxied"] = fields["proxied"] === "true";
  if (fields["priority"] !== undefined && fields["priority"] !== "")
    body["priority"] = Number(fields["priority"]);
  if (fields["comment"] !== undefined) body["comment"] = fields["comment"];
  const record = await api.cf.dns.records.edit(recordId, body as never);
  return mapDnsRecord(record, accountId, zoneId);
}

export async function deleteDnsRecord(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, recordId] = externalId.split("/");
  if (!zoneId || !recordId) throw new Error("Invalid DNS record ID");
  await api.cf.dns.records.delete(recordId, { zone_id: zoneId });
}
