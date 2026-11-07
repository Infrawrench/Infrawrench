import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalClient } from "../client.js";
import { ProtoWriter } from "../proto.js";
import type { ProtoMessage } from "../proto.js";
import type { Reply } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

function client(route: (method: string, request: ProtoMessage) => Reply) {
  const { http, calls } = makeHttp(route);
  return {
    c: hostClient(new ModalClient({ tokenId: "ak-x", tokenSecret: "as-y" }, { http })),
    calls,
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.useRealTimers();
});

/** `VolumeListItem` with its creation time on `VolumeMetadata.creation_info`. */
function volume(id: string, createdSeconds: number): ProtoWriter {
  return new ProtoWriter()
    .string(2, id)
    .message(
      4,
      new ProtoWriter()
        .string(2, id)
        .message(3, new ProtoWriter().double(1, createdSeconds).string(2, "someone")),
    );
}

function fullPage(page: number, start = 1_700_000_000): ProtoWriter {
  const res = new ProtoWriter();
  for (let i = 0; i < 100; i++) {
    res.message(1, volume(`vo-${page}-${i}`, start - page * 1000 - i));
  }
  return res;
}

describe("named object lists", () => {
  const environments = new ProtoWriter().message(2, new ProtoWriter().string(1, "main"));

  it("reads past the old 5,000 row cap", async () => {
    let page = 0;
    const { c } = client((method) => {
      if (method === "EnvironmentList") return environments;
      return page++ < 120 ? fullPage(page) : new ProtoWriter();
    });
    const rows = await c.listResources("volume", ACCOUNT);
    expect(rows).toHaveLength(12_000);
  });

  it("throws at the cap instead of returning part of the list", async () => {
    let page = 0;
    const { c, calls } = client((method) =>
      method === "EnvironmentList" ? environments : fullPage(page++),
    );
    await expect(c.listResources("volume", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((x) => x.method === "VolumeList")).toHaveLength(500);
  });

  it("asks for the next page by the exact time of the oldest row", async () => {
    const oldest = 1_700_000_000.1234567;
    const first = new ProtoWriter();
    for (let i = 0; i < 99; i++) first.message(1, volume(`vo-${i}`, oldest + 10 + i));
    first.message(1, volume("vo-oldest", oldest));
    let page = 0;
    const { c, calls } = client((method) => {
      if (method === "EnvironmentList") return environments;
      return page++ === 0 ? first : new ProtoWriter();
    });
    await c.listResources("volume", ACCOUNT);
    const lists = calls.filter((x) => x.method === "VolumeList");
    expect(lists).toHaveLength(2);
    expect(lists[0]?.request.message(2)?.has(2)).toBe(false);
    expect(lists[1]?.request.message(2)?.double(2)).toBe(oldest);
  });

  it.each([
    ["secret", "SecretList", 2, (id: string, s: number) => secretItem(id, s)],
    ["dict", "DictList", 2, (id: string, s: number) => dictItem(id, s)],
    ["queue", "QueueList", 3, (id: string, s: number) => queueItem(id, s)],
  ] as const)("follows the %s pages by creation time", async (type, rpc, field, item) => {
    const oldest = 1_700_000_000.7654321;
    const first = new ProtoWriter();
    for (let i = 0; i < 100; i++) first.message(1, item(`id-${i}`, oldest + 99 - i));
    let page = 0;
    const { c, calls } = client((method) => {
      if (method === "EnvironmentList") return environments;
      return page++ === 0 ? first : new ProtoWriter();
    });
    await c.listResources(type, ACCOUNT);
    const lists = calls.filter((x) => x.method === rpc);
    expect(lists[1]?.request.message(field)?.double(2)).toBe(oldest);
  });

  it("refuses a full page with no creation time to go on from", async () => {
    const page = new ProtoWriter();
    for (let i = 0; i < 100; i++) page.message(1, new ProtoWriter().string(2, `vo-${i}`));
    const { c } = client((method) => (method === "EnvironmentList" ? environments : page));
    await expect(c.listResources("volume", ACCOUNT)).rejects.toThrow("no cursor");
  });

  it("refuses a page that does not move the list on", async () => {
    const { c } = client((method) => (method === "EnvironmentList" ? environments : fullPage(0)));
    await expect(c.listResources("volume", ACCOUNT)).rejects.toThrow("no cursor");
  });

  it("ends on a short page, including an empty one after a full page", async () => {
    let page = 0;
    const { c, calls } = client((method) => {
      if (method === "EnvironmentList") return environments;
      return page++ === 0 ? fullPage(0) : new ProtoWriter();
    });
    expect(await c.listResources("volume", ACCOUNT)).toHaveLength(100);
    expect(calls.filter((x) => x.method === "VolumeList")).toHaveLength(2);
  });

  it.each([
    ["app", "AppList"],
    ["environment", "EnvironmentList"],
    ["volume", "VolumeList"],
  ])("does not read an answer with no message at all as an empty %s list", async (type, rpc) => {
    const { c } = client((method) => {
      if (method === rpc) return [];
      return method === "EnvironmentList" ? environments : new ProtoWriter();
    });
    await expect(c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads an empty message and an OK status with no message as an empty list", async () => {
    const empty = client((method) =>
      method === "EnvironmentList" ? environments : new ProtoWriter(),
    );
    expect(await empty.c.listResources("volume", ACCOUNT)).toEqual([]);
    const ok = client((method) =>
      method === "EnvironmentList" ? environments : { grpcStatus: 0 },
    );
    expect(await ok.c.listResources("volume", ACCOUNT)).toEqual([]);
  });
});

function secretItem(id: string, seconds: number): ProtoWriter {
  return new ProtoWriter()
    .string(5, id)
    .message(6, new ProtoWriter().string(1, id).message(2, new ProtoWriter().double(1, seconds)));
}

function dictItem(id: string, seconds: number): ProtoWriter {
  return new ProtoWriter()
    .string(3, id)
    .message(4, new ProtoWriter().string(1, id).message(2, new ProtoWriter().double(1, seconds)));
}

function queueItem(id: string, seconds: number): ProtoWriter {
  return new ProtoWriter()
    .string(5, id)
    .message(6, new ProtoWriter().string(1, id).message(2, new ProtoWriter().double(1, seconds)));
}
