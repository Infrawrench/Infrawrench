import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { withAuthErrorHint } from "./shared.js";
import { buildZoneSettingDescriptors, coerceZoneSettingValue } from "./zone-settings-meta.js";
import type { Zone } from "cloudflare/resources/zones/zones";

function mapZone(api: CloudflareApi, z: Zone, accountId: string): ResourceInstance {
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
  return withAuthErrorHint(
    async () => {
      const out: ResourceInstance[] = [];
      for (const z of await api.listZones()) {
        out.push(mapZone(api, z, accountId));
      }
      return out;
    },
    "zones",
    "Zone · Zone:Read",
  );
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
  // Tokens scoped to DNS-only routinely lack Zone Settings:Read (Cloudflare
  // error 9109), so surface the friendly scope hint instead of a raw 403 body.
  //
  // The host renders a settings *form* (settingsEditor capability), so we return
  // `{ settings: SettingDescriptor[] }` — labeled controls rather than raw JSON.
  const raw = await withAuthErrorHint(
    () => api.cf.get<unknown, unknown>(`/zones/${externalId}/settings`),
    "zone settings",
    "Zone · Zone Settings:Read",
  );
  // The raw helper may hand back the full envelope ({ result: [...] }) or the
  // unwrapped array depending on SDK version — accept both.
  const list = Array.isArray(raw)
    ? (raw as unknown[])
    : Array.isArray((raw as { result?: unknown })?.result)
      ? (raw as { result: unknown[] }).result
      : [];
  const settings = buildZoneSettingDescriptors(
    list as Parameters<typeof buildZoneSettingDescriptors>[0],
  );
  return JSON.stringify({ settings });
}

export async function applyZoneManifest(
  api: CloudflareApi,
  externalId: string,
  manifest: string,
): Promise<void> {
  // The settings form sends back a JSON array of changed { id, value } pairs.
  const changed = JSON.parse(manifest) as Array<{ id: string; value: string }>;
  if (!Array.isArray(changed))
    throw new Error("Zone settings must be an array of {id, value} objects");
  await withAuthErrorHint(
    async () => {
      for (const setting of changed) {
        await api.cf.zones.settings.edit(setting.id, {
          zone_id: externalId,
          // Coerce the string value back to the type CF expects per setting,
          // then cast through unknown (the SDK exposes a per-setting union).
          value: coerceZoneSettingValue(setting.id, setting.value),
        } as Parameters<typeof api.cf.zones.settings.edit>[1]);
      }
    },
    "zone settings",
    "Zone · Zone Settings:Edit",
  );
}
