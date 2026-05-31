import { describe, it, expect, vi } from "vitest";
import {
  listAllWaitingRooms,
  createWaitingRoom,
  editWaitingRoom,
  deleteWaitingRoom,
} from "../clients/waiting-room-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const ROOM = {
  id: "wr1",
  name: "launch",
  host: "shop.a.com",
  path: "/sale",
  total_active_users: 200,
  new_users_per_minute: 100,
  queueing_method: "fifo",
  session_duration: 5,
  suspended: false,
  created_on: "2020-01-01T00:00:00Z",
  modified_on: "2020-01-02T00:00:00Z",
};

function wrApi(over: Record<string, unknown> = {}) {
  const waitingRooms = {
    list: vi.fn(() => asyncIter([ROOM])),
    create: vi.fn(async () => ROOM),
    edit: vi.fn(async () => ROOM),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { waitingRooms }, ...over });
}

describe("waiting-room-client", () => {
  it("listAllWaitingRooms maps a room", async () => {
    const api = wrApi();
    const out = await listAllWaitingRooms(api, "acct");
    expect(out[0]!.id).toBe("acct:waiting-room:z1/wr1");
    expect(out[0]!.fields.host).toBe("shop.a.com");
    expect(out[0]!.fields.totalActiveUsers).toBe(200);
  });

  it("createWaitingRoom sends core fields", async () => {
    const api = wrApi();
    await createWaitingRoom(
      api,
      "acct",
      { name: "launch", host: "shop.a.com", totalActiveUsers: "300", newUsersPerMinute: "150" },
      "z1",
    );
    expect(api.cf.waitingRooms.create).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_id: "z1",
        name: "launch",
        total_active_users: 300,
        new_users_per_minute: 150,
      }),
    );
  });

  it("createWaitingRoom throws without a zone", async () => {
    await expect(createWaitingRoom(wrApi(), "acct", {}, "")).rejects.toThrow(/zoneId is required/);
  });

  it("editWaitingRoom rebuilds the merged body", async () => {
    const api = wrApi();
    await editWaitingRoom(api, "acct", "z1/wr1", {
      name: "launch",
      host: "shop.a.com",
      totalActiveUsers: "500",
      newUsersPerMinute: "200",
      path: "/sale",
      suspended: "true",
    });
    const call = (api.cf.waitingRooms.edit as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(call.total_active_users).toBe(500);
    expect(call.path).toBe("/sale");
    expect(call.suspended).toBe(true);
  });

  it("editWaitingRoom throws on a malformed id", async () => {
    await expect(editWaitingRoom(wrApi(), "acct", "bad", {})).rejects.toThrow(
      "Invalid waiting room ID",
    );
  });

  it("deleteWaitingRoom calls delete", async () => {
    const api = wrApi();
    await deleteWaitingRoom(api, "z1/wr1");
    expect(api.cf.waitingRooms.delete).toHaveBeenCalledWith("wr1", { zone_id: "z1" });
  });

  it("deleteWaitingRoom throws on a malformed id", async () => {
    await expect(deleteWaitingRoom(wrApi(), "bad")).rejects.toThrow("Invalid waiting room ID");
  });
});
