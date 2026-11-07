import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalClient } from "../client.js";
import { ProtoWriter } from "../proto.js";
import { FunctionResourceType, ScheduledFunctionResourceType } from "../resource-types.js";
import type { ProtoMessage } from "../proto.js";
import type { Reply } from "./helpers.js";
import { makeHttp, withMap } from "./helpers.js";

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
    // No status anywhere: a host that cannot read trailers, and one whose
    // trailer section came back without the status.
    for (const trailers of [null, {}]) {
      const { c } = client((method) => {
        if (method === rpc) return { stream: [], trailers };
        return method === "EnvironmentList" ? environments : new ProtoWriter();
      });
      await expect(c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
    }
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

describe("functions of deployed apps", () => {
  function deployedApps(count: number) {
    return client((method, request) => {
      if (method === "EnvironmentList") {
        return new ProtoWriter().message(2, new ProtoWriter().string(1, "main"));
      }
      if (method === "AppList") {
        const res = new ProtoWriter();
        for (let i = 0; i < count; i++) {
          res.message(
            1,
            new ProtoWriter()
              .string(1, `ap-${i}`)
              .int(4, 3)
              .double(5, 1_700_000_000 + i)
              .string(10, `app-${i}`),
          );
        }
        return res;
      }
      if (method === "AppGetInfo") {
        const appId = request.string(1);
        return new ProtoWriter().message(
          1,
          withMap(new ProtoWriter().string(2, appId), 5, { run: `fu-${appId}` }),
        );
      }
      return new ProtoWriter();
    });
  }

  function recordUnread() {
    const named: string[] = [];
    Reflect.set(globalThis, UNREAD_HOOK, (part: { parentResourceIds?: string[] }) => {
      named.push(...(part.parentResourceIds ?? []));
    });
    return named;
  }

  it("hangs each function off its app, so a list can name the app as unread", async () => {
    const { c } = deployedApps(1);
    const [fn] = await c.listResources("function", ACCOUNT);
    expect(fn?.parentResourceId).toBe("acct:app:ap-0");
    const [app] = await c.listResources("app", ACCOUNT);
    expect(app?.id).toBe(fn?.parentResourceId);
    expect(FunctionResourceType.parentTypeId).toBe("app");
    expect(FunctionResourceType.showInSidebar).toBe(true);
    expect(ScheduledFunctionResourceType.parentTypeId).toBe("app");
    expect(ScheduledFunctionResourceType.showInSidebar).toBe(true);
  });

  it("reads every app up to the budget and names none as unread", async () => {
    const { c, calls } = deployedApps(1000);
    const named = recordUnread();
    const rows = await c.listResources("function", ACCOUNT);
    expect(rows).toHaveLength(1000);
    expect(calls.filter((x) => x.method === "AppGetInfo")).toHaveLength(1000);
    expect(named).toEqual([]);
  });

  it("past the budget reads a run of apps and names the rest", async () => {
    const { c, calls } = deployedApps(1100);
    const named = recordUnread();
    const rows = await c.listResources("function", ACCOUNT);
    const read = calls
      .filter((x) => x.method === "AppGetInfo")
      .map((x) => `${ACCOUNT}:app:${x.request.string(1)}`);
    expect(read).toHaveLength(1000);
    expect(rows).toHaveLength(1000);
    expect(named).toHaveLength(100);
    expect(new Set([...read, ...named]).size).toBe(1100);
  });

  it("names the unread apps for each type sharing the read", async () => {
    const { c, calls } = deployedApps(1100);
    const named = recordUnread();
    await c.listResources("function", ACCOUNT);
    await c.listResources("scheduled-function", ACCOUNT);
    expect(calls.filter((x) => x.method === "AppGetInfo")).toHaveLength(1000);
    expect(named).toHaveLength(200);
  });

  it("moves the run of apps from one poll to the next", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const unreadAt = async (at: string) => {
      vi.setSystemTime(new Date(at));
      const named = recordUnread();
      await deployedApps(1100).c.listResources("function", ACCOUNT);
      return named;
    };
    const first = await unreadAt("2026-11-07T10:00:00Z");
    const second = await unreadAt("2026-11-07T10:05:00Z");
    expect(second).not.toEqual(first);
  });
});

describe("a token refused environments", () => {
  const DENIED = { grpcStatus: 7, message: "denied" };
  const TWO_ENVIRONMENTS = new ProtoWriter()
    .message(2, new ProtoWriter().string(1, "main"))
    .message(2, new ProtoWriter().string(1, "locked"));

  function recordPrefixes() {
    const prefixes: string[] = [];
    Reflect.set(globalThis, UNREAD_HOOK, (part: { idPrefixes?: string[] }) => {
      prefixes.push(...(part.idPrefixes ?? []));
    });
    return prefixes;
  }

  const oneVolume = new ProtoWriter().message(1, volume("vo-1", 1_700_000_000));

  it("keeps the rows of environments it could not list", async () => {
    const prefixes = recordPrefixes();
    const { c, calls } = client((method) => {
      if (method === "EnvironmentList") return DENIED;
      return oneVolume;
    });
    const rows = await c.listResources("volume", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["vo-1"]);
    expect(calls.find((x) => x.method === "VolumeList")?.request.string(1)).toBe("");
    expect(prefixes).toEqual([""]);
  });

  it("says so for each type reading apps, through the cached read", async () => {
    const prefixes = recordPrefixes();
    const { c } = client((method) => (method === "EnvironmentList" ? DENIED : new ProtoWriter()));
    await c.listResources("app", ACCOUNT);
    await c.listResources("function", ACCOUNT);
    await c.listResources("scheduled-function", ACCOUNT);
    expect(prefixes).toEqual(["", "", ""]);
  });

  it("returns the environments it could read when one refuses", async () => {
    const prefixes = recordPrefixes();
    const { c } = client((method, request) => {
      if (method === "EnvironmentList") return TWO_ENVIRONMENTS;
      return request.string(1) === "locked" ? DENIED : oneVolume;
    });
    const rows = await c.listResources("volume", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["vo-1"]);
    expect(prefixes).toEqual([""]);
  });

  it("keeps the rows quietly when every environment refuses", async () => {
    const prefixes = recordPrefixes();
    const { c } = client((method) => (method === "EnvironmentList" ? TWO_ENVIRONMENTS : DENIED));
    expect(await c.listResources("volume", ACCOUNT)).toEqual([]);
    expect(prefixes).toEqual([""]);
  });

  it("shows the refusal on a host that keeps no track, when nothing could be read", async () => {
    const { c } = client((method) => (method === "EnvironmentList" ? TWO_ENVIRONMENTS : DENIED));
    await expect(c.listResources("volume", ACCOUNT)).rejects.toThrow("PERMISSION_DENIED");
  });

  it("returns the default environment on a host that keeps no track", async () => {
    const { c } = client((method) => (method === "EnvironmentList" ? DENIED : oneVolume));
    expect(await c.listResources("volume", ACCOUNT)).toHaveLength(1);
  });

  it("keeps the environment rows quietly when the list is refused", async () => {
    const prefixes = recordPrefixes();
    const { c } = client(() => DENIED);
    expect(await c.listResources("environment", ACCOUNT)).toEqual([]);
    expect(prefixes).toEqual([""]);
  });

  it("shows that refusal on a host that keeps no track", async () => {
    const { c } = client(() => DENIED);
    await expect(c.listResources("environment", ACCOUNT)).rejects.toThrow("PERMISSION_DENIED");
  });

  it.each([
    ["a throttle", 8],
    ["an outage", 14],
    ["a rejected token", 16],
  ])("fails the type on %s", async (_name, grpcStatus) => {
    const prefixes = recordPrefixes();
    const onEnvironments = client((method) =>
      method === "EnvironmentList" ? { grpcStatus } : new ProtoWriter(),
    );
    await expect(onEnvironments.c.listResources("volume", ACCOUNT)).rejects.toThrow();
    const onOneList = client((method, request) => {
      if (method === "EnvironmentList") return TWO_ENVIRONMENTS;
      return request.string(1) === "locked" ? { grpcStatus } : oneVolume;
    });
    await expect(onOneList.c.listResources("volume", ACCOUNT)).rejects.toThrow();
    expect(prefixes).toEqual([]);
  });

  it("counts no environments on the workspace only when refused", async () => {
    const workspace = (environments: Reply) =>
      client((method) => {
        if (method === "EnvironmentList") return environments;
        return new ProtoWriter().string(1, "team");
      }).c.listResources("workspace", ACCOUNT);
    const [row] = await workspace(DENIED);
    expect(row?.displayName).toBe("team");
    await expect(workspace({ grpcStatus: 14 })).rejects.toThrow("UNAVAILABLE");
  });
});
