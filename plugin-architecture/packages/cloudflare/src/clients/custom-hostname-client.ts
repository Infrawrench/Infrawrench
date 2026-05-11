import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapCustomHostname(
  h: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(h["id"] ?? "");
  const hostname = String(h["hostname"] ?? "");
  const ssl = h["ssl"] as Record<string, unknown> | undefined;
  return {
    id: `${accountId}:custom-hostname:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "custom-hostname",
    accountId,
    displayName: hostname || id,
    fields: {
      hostname,
      status: String(h["status"] ?? ""),
      sslStatus: String(ssl?.["status"] ?? ""),
      sslMethod: String(ssl?.["method"] ?? ""),
      sslType: String(ssl?.["type"] ?? ""),
      createdAt: String(h["created_at"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: String(h["created_at"] ?? new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
}

export async function listAllCustomHostnames(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneId = String(zone["id"]);
    try {
      const hostnames = await api.paginate<Record<string, unknown>>(
        `/zones/${zoneId}/custom_hostnames`,
      );
      for (const h of hostnames) {
        results.push(mapCustomHostname(h, accountId, zoneId));
      }
    } catch {
      // Skip zones where we can't read custom hostnames
    }
  }
  return results;
}

export async function createCustomHostname(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a custom hostname");
  const ch = await api.fetch<Record<string, unknown>>(`/zones/${zoneId}/custom_hostnames`, {
    method: "POST",
    body: JSON.stringify({
      hostname: fields["hostname"] ?? "",
      ssl: {
        method: fields["sslMethod"] ?? "http",
        type: "dv",
      },
    }),
  });
  return mapCustomHostname(ch, accountId, zoneId);
}

export async function deleteCustomHostname(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, hostnameId] = externalId.split("/");
  if (!zoneId || !hostnameId) throw new Error("Invalid custom hostname ID");
  await api.fetch(`/zones/${zoneId}/custom_hostnames/${hostnameId}`, { method: "DELETE" });
}
