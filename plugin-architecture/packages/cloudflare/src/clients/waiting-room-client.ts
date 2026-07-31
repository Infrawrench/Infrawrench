import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone, resolveZoneName } from "./shared.js";
import type {
  WaitingRoomCreateParams,
  WaitingRoomEditParams,
} from "cloudflare/resources/waiting-rooms/waiting-rooms";

/**
 * Queueing methods the API accepts (`WaitingRoomEditParams.queueing_method`).
 * The resource field is free text, so an unrecognised value is dropped from the
 * write instead of being forwarded — Cloudflare keeps the room's current method.
 */
const QUEUEING_METHODS = [
  "fifo",
  "random",
  "passthrough",
  "reject",
] as const satisfies readonly NonNullable<WaitingRoomEditParams["queueing_method"]>[];
type QueueingMethod = (typeof QUEUEING_METHODS)[number];

function isQueueingMethod(value: string): value is QueueingMethod {
  return (QUEUEING_METHODS as readonly string[]).includes(value);
}

function mapWaitingRoom(
  room: Record<string, unknown>,
  accountId: string,
  zoneId: string,
  zoneName: string,
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
      zoneName,
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
  return collectPerZone(
    api,
    async (zoneId, zoneName) => {
      const part: ResourceInstance[] = [];
      for await (const room of api.cf.waitingRooms.list({ zone_id: zoneId })) {
        part.push(mapWaitingRoom(asRecord(room), accountId, zoneId, zoneName));
      }
      return part;
    },
    "waiting rooms",
    "Zone · Waiting Rooms:Read",
  );
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
  };
  const room = await api.cf.waitingRooms.create(params);
  return mapWaitingRoom(asRecord(room), accountId, zoneId, await resolveZoneName(api, zoneId));
}

export async function editWaitingRoom(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, roomId] = externalId.split("/");
  if (!zoneId || !roomId) throw new Error("Invalid waiting room ID");
  // Cloudflare requires the core fields on every waiting-room write, so the
  // dispatcher passes a merged (current + changed) field set.
  const path = fields["path"];
  const queueingMethod = fields["queueingMethod"] ?? "";
  const sessionDuration = fields["sessionDuration"];
  const params: WaitingRoomEditParams = {
    zone_id: zoneId,
    name: fields["name"] ?? "",
    host: fields["host"] ?? "",
    total_active_users: Number(fields["totalActiveUsers"] ?? 200),
    new_users_per_minute: Number(fields["newUsersPerMinute"] ?? 200),
    ...(path ? { path } : {}),
    ...(isQueueingMethod(queueingMethod) ? { queueing_method: queueingMethod } : {}),
    ...(sessionDuration ? { session_duration: Number(sessionDuration) } : {}),
    ...(fields["suspended"] !== undefined ? { suspended: fields["suspended"] === "true" } : {}),
  };
  const room = await api.cf.waitingRooms.edit(roomId, params);
  return mapWaitingRoom(asRecord(room), accountId, zoneId, await resolveZoneName(api, zoneId));
}

export async function deleteWaitingRoom(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, roomId] = externalId.split("/");
  if (!zoneId || !roomId) throw new Error("Invalid waiting room ID");
  await api.cf.waitingRooms.delete(roomId, { zone_id: zoneId });
}
