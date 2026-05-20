import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import type { WaitingRoomCreateParams } from "cloudflare/resources/waiting-rooms/waiting-rooms";

function mapWaitingRoom(
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
  const results: ResourceInstance[] = [];
  for await (const zone of api.cf.zones.list()) {
    const zoneId = zone.id;
    try {
      for await (const room of api.cf.waitingRooms.list({ zone_id: zoneId })) {
        results.push(mapWaitingRoom(room as unknown as Record<string, unknown>, accountId, zoneId));
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
  const params: WaitingRoomCreateParams = {
    zone_id: zoneId,
    name: fields["name"] ?? "",
    host: fields["host"] ?? "",
    total_active_users: Number(fields["totalActiveUsers"] ?? 200),
    new_users_per_minute: Number(fields["newUsersPerMinute"] ?? 200),
  } as WaitingRoomCreateParams;
  const room = await api.cf.waitingRooms.create(params);
  return mapWaitingRoom(room as unknown as Record<string, unknown>, accountId, zoneId);
}

export async function deleteWaitingRoom(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, roomId] = externalId.split("/");
  if (!zoneId || !roomId) throw new Error("Invalid waiting room ID");
  await api.cf.waitingRooms.delete(roomId, { zone_id: zoneId });
}
