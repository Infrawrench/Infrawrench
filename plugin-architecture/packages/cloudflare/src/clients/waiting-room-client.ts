import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapWaitingRoom(
  room: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(room["id"] ?? "");
  const name = String(room["name"] ?? "");
  return {
    id: `${accountId}:waiting-room:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "waiting-room",
    accountId,
    displayName: name || id,
    fields: {
      name,
      host: String(room["host"] ?? ""),
      path: String(room["path"] ?? ""),
      totalActiveUsers: Number(room["total_active_users"] ?? 0),
      newUsersPerMinute: Number(room["new_users_per_minute"] ?? 0),
      queueingMethod: String(room["queueing_method"] ?? ""),
      sessionDuration: Number(room["session_duration"] ?? 0),
      suspended: Boolean(room["suspended"]),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: String(room["created_on"] ?? new Date().toISOString()),
    updatedAt: String(room["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listAllWaitingRooms(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneId = String(zone["id"]);
    try {
      const rooms = await api.fetch<Array<Record<string, unknown>>>(
        `/zones/${zoneId}/waiting_rooms`,
      );
      for (const room of rooms ?? []) {
        results.push(mapWaitingRoom(room, accountId, zoneId));
      }
    } catch {
      // Skip zones where waiting rooms aren't enabled
    }
  }
  return results;
}

export async function createWaitingRoom(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a waiting room");
  const room = await api.fetch<Record<string, unknown>>(`/zones/${zoneId}/waiting_rooms`, {
    method: "POST",
    body: JSON.stringify({
      name: fields["name"] ?? "",
      host: fields["host"] ?? "",
      total_active_users: Number(fields["totalActiveUsers"] ?? 200),
      new_users_per_minute: Number(fields["newUsersPerMinute"] ?? 200),
    }),
  });
  return mapWaitingRoom(room, accountId, zoneId);
}

export async function deleteWaitingRoom(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, roomId] = externalId.split("/");
  if (!zoneId || !roomId) throw new Error("Invalid waiting room ID");
  await api.fetch(`/zones/${zoneId}/waiting_rooms/${roomId}`, { method: "DELETE" });
}
