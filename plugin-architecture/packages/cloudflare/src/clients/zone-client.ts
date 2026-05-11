import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapZone(
  api: CloudflareApi,
  z: Record<string, unknown>,
  accountId: string,
): ResourceInstance {
  const nameservers = Array.isArray(z["name_servers"])
    ? (z["name_servers"] as string[]).join(", ")
    : "";
  const plan = z["plan"] as Record<string, unknown> | undefined;
  // Cache account ID from zone data
  const account = z["account"] as Record<string, unknown> | undefined;
  if (account?.["id"] && !api.cfAccountId) {
    api.cfAccountId = String(account["id"]);
  }
  return {
    id: `${accountId}:zone:${String(z["id"])}`,
    pluginId: "cloudflare",
    resourceTypeId: "zone",
    accountId,
    displayName: String(z["name"]),
    fields: {
      name: String(z["name"]),
      status: String(z["status"] ?? ""),
      plan: String(plan?.["name"] ?? "Free"),
      nameservers,
      type: String(z["type"] ?? "full"),
      paused: Boolean(z["paused"]),
    },
    resolvedOutputs: {
      zoneId: String(z["id"]),
      nameservers,
    },
    secretStates: [],
    externalId: String(z["id"]),
    createdAt: String(z["created_on"] ?? new Date().toISOString()),
    updatedAt: String(z["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listZones(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  return zones.map((z) => mapZone(api, z, accountId));
}

export async function getZone(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const zone = await api.fetch<Record<string, unknown>>(`/zones/${externalId}`);
  return mapZone(api, zone, accountId);
}

export async function createZone(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const zone = await api.fetch<Record<string, unknown>>("/zones", {
    method: "POST",
    body: JSON.stringify({ name: fields["name"], type: "full" }),
  });
  return mapZone(api, zone, accountId);
}

export async function deleteZone(api: CloudflareApi, externalId: string): Promise<void> {
  await api.fetch(`/zones/${externalId}`, { method: "DELETE" });
}

export async function getZoneManifest(api: CloudflareApi, externalId: string): Promise<string> {
  const settings = await api.fetch<Record<string, unknown>>(`/zones/${externalId}/settings`);
  return JSON.stringify(settings, null, 2);
}

export async function applyZoneManifest(
  api: CloudflareApi,
  externalId: string,
  manifest: string,
): Promise<void> {
  // Zone settings are applied per-setting via PATCH
  const settings = JSON.parse(manifest) as Array<{ id: string; value: unknown }>;
  if (!Array.isArray(settings))
    throw new Error("Zone settings must be an array of {id, value} objects");
  for (const setting of settings) {
    await api.fetch(`/zones/${externalId}/settings/${setting.id}`, {
      method: "PATCH",
      body: JSON.stringify({ value: setting.value }),
    });
  }
}
