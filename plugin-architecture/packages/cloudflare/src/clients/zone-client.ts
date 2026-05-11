import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import type { Zone } from "cloudflare/resources/zones/zones";

export function mapZone(api: CloudflareApi, z: Zone, accountId: string): ResourceInstance {
  const nameservers = Array.isArray(z.name_servers) ? z.name_servers.join(", ") : "";
  // Cache account ID from zone data
  if (z.account?.id && !api.cfAccountId) {
    api.cfAccountId = z.account.id;
  }
  return {
    id: `${accountId}:zone:${z.id}`,
    pluginId: "cloudflare",
    resourceTypeId: "zone",
    accountId,
    displayName: z.name,
    fields: {
      name: z.name,
      status: String(z.status ?? ""),
      plan: String(z.plan?.name ?? "Free"),
      nameservers,
      type: String(z.type ?? "full"),
      paused: Boolean(z.paused),
    },
    resolvedOutputs: {
      zoneId: z.id,
      nameservers,
    },
    secretStates: [],
    externalId: z.id,
    createdAt: String(z.created_on ?? new Date().toISOString()),
    updatedAt: String(z.modified_on ?? new Date().toISOString()),
  };
}

export async function listZones(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const out: ResourceInstance[] = [];
  for await (const z of api.cf.zones.list()) {
    out.push(mapZone(api, z, accountId));
  }
  return out;
}

export async function getZone(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const zone = await api.cf.zones.get({ zone_id: externalId });
  return mapZone(api, zone, accountId);
}

export async function createZone(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const zone = await api.cf.zones.create({
    account: { id: cfAccountId },
    name: fields["name"] ?? "",
    type: "full",
  });
  return mapZone(api, zone, accountId);
}

export async function deleteZone(api: CloudflareApi, externalId: string): Promise<void> {
  await api.cf.zones.delete({ zone_id: externalId });
}

export async function getZoneManifest(api: CloudflareApi, externalId: string): Promise<string> {
  // The SDK only exposes per-setting `get`/`edit`. Fetching the full settings
  // collection in one call is much cheaper, so we use the generic raw helper.
  const settings = await api.cf.get<unknown, Record<string, unknown>>(
    `/zones/${externalId}/settings`,
  );
  return JSON.stringify(settings, null, 2);
}

export async function applyZoneManifest(
  api: CloudflareApi,
  externalId: string,
  manifest: string,
): Promise<void> {
  const settings = JSON.parse(manifest) as Array<{ id: string; value: unknown }>;
  if (!Array.isArray(settings))
    throw new Error("Zone settings must be an array of {id, value} objects");
  for (const setting of settings) {
    await api.cf.zones.settings.edit(setting.id, {
      zone_id: externalId,
      // SDK exposes a discriminated union per setting; cast through unknown.
      value: setting.value,
    } as Parameters<typeof api.cf.zones.settings.edit>[1]);
  }
}
