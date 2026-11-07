/** What a list does when it cannot read everything: a sync prunes whatever a list stops returning. */
import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JfrogClient } from "../client.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";
const creds = { baseUrl: "https://acme.jfrog.io", accessToken: "tok" };
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

interface Unread {
  parentResourceIds?: string[];
  idPrefixes?: string[];
}

function client(route: (call: Call) => unknown) {
  const { http, calls } = makeHttp(route);
  return { c: hostClient(new JfrogClient(creds, { http } as never)), calls };
}

/** Stands in for a host that tracks what a list did not read, as the poller does. */
function trackUnread(): Unread[] {
  const parts: Unread[] = [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: Unread) => parts.push(part));
  return parts;
}

const names = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.restoreAllMocks();
});

describe("Access pages", () => {
  it("refuses a list that never ends, after 200 pages", async () => {
    let page = 0;
    const { c, calls } = client(() => ({
      groups: [{ group_name: `g${page}` }],
      cursor: `c${++page}`,
    }));
    await expect(c.listResources("jfrog-group", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(200);
  });

  it("reads past the 20 pages it used to stop at", async () => {
    let page = 0;
    const { c } = client((call) => {
      if (call.url.pathname !== "/access/api/v2/permissions") return { name: "x" };
      page++;
      return {
        permissions: [{ name: `p${page}` }],
        ...(page < 30 ? { cursor: `c${page}` } : {}),
      };
    });
    expect(await c.listResources("jfrog-permission", ACCOUNT)).toHaveLength(30);
  });

  it("refuses a page with its key renamed, first or later", async () => {
    const first = client(() => ({ items: [] }));
    await expect(first.c.listResources("jfrog-user", ACCOUNT)).rejects.toThrow("is not a list");
    const later = client((call) => {
      if (call.url.pathname !== "/access/api/v2/users") return {};
      return call.url.searchParams.get("cursor")
        ? { items: [] }
        : { users: [{ username: "a" }], cursor: "c" };
    });
    await expect(later.c.listResources("jfrog-user", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("refuses a cursor stuck on one page, which is not the end of the list", async () => {
    const { c } = client(() => ({ groups: [{ group_name: "a" }], cursor: "c" }));
    await expect(c.listResources("jfrog-group", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("ends on a last page that hands back its own cursor", async () => {
    const { c } = client((call) => {
      if (call.url.pathname !== "/access/api/v2/groups") return { name: "x" };
      return call.url.searchParams.get("cursor")
        ? { groups: [{ group_name: "b" }], cursor: "c" }
        : { groups: [{ group_name: "a" }], cursor: "c" };
    });
    expect(await c.listResources("jfrog-group", ACCOUNT)).toHaveLength(2);
  });

  it("gives a create form what it read in 20 pages, rather than nothing", async () => {
    let page = 0;
    const { c, calls } = client(() => ({
      groups: [{ group_name: `g${page}` }],
      cursor: `c${++page}`,
    }));
    const config = await c.getCreateConfig!("jfrog-user");
    const groups = config.fields.find((f) => f.key === "groups");
    expect(groups?.kind === "policy-picker" ? groups.policies : []).toHaveLength(20);
    expect(calls).toHaveLength(20);
  });
});

describe("answers that are not lists", () => {
  const cases: Array<[string, string, unknown]> = [
    ["jfrog-repository", "/artifactory/api/repositories", { repositories: [] }],
    ["jfrog-build", "/artifactory/api/build", { uri: "https://x/api/build" }],
    ["jfrog-xray-watch", "/xray/api/v2/watches", { watches: [] }],
    ["jfrog-xray-policy", "/xray/api/v1/policies", { policies: [] }],
    ["jfrog-xray-violation", "/xray/api/v1/violations", { total_violations: 0 }],
    ["jfrog-access-token", "/access/api/v1/tokens", { items: [] }],
  ];

  it.each(cases)("%s throws instead of reading none", async (type, path, answer) => {
    const { c } = client((call) => (call.url.pathname === path ? answer : {}));
    await expect(c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("does not read a build's renamed runs as none", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/artifactory/api/build"
        ? { builds: [{ uri: "/app" }] }
        : { runs: [{ uri: "/1" }] },
    );
    await expect(c.listResources("jfrog-build-run", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads Xray's null for an empty list as none", async () => {
    const { c } = client(() => ({ text: "null" }));
    expect(await c.listResources("jfrog-xray-watch", ACCOUNT)).toEqual([]);
    expect(await c.listResources("jfrog-xray-policy", ACCOUNT)).toEqual([]);
  });

  it("still reads a platform without Xray or builds as none", async () => {
    const { c } = client(() => ({ status: 404, body: { error: "not found" } }));
    expect(await c.listResources("jfrog-xray-violation", ACCOUNT)).toEqual([]);
    expect(await c.listResources("jfrog-xray-policy", ACCOUNT)).toEqual([]);
    expect(await c.listResources("jfrog-build", ACCOUNT)).toEqual([]);
  });
});

describe("build runs", () => {
  function builds(count: number) {
    return client((call) => {
      if (call.url.pathname === "/artifactory/api/build")
        return { builds: names(count).map((n) => ({ uri: `/${n}` })) };
      return { buildsNumbers: [{ uri: "/1", started: "2026-01-01" }] };
    });
  }

  it("reads every build, not the first 50", async () => {
    const { c } = builds(120);
    expect(await c.listResources("jfrog-build-run", ACCOUNT)).toHaveLength(120);
  });

  it("names the builds a poll's budget does not reach, and rotates the start", async () => {
    const parts = trackUnread();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { c, calls } = builds(1000);
    const runs = await c.listResources("jfrog-build-run", ACCOUNT);
    expect(runs).toHaveLength(200);
    expect(calls.filter((x) => x.url.pathname !== "/artifactory/api/build")).toHaveLength(200);
    expect(runs[0]!.parentResourceId).toBe(`${ACCOUNT}:jfrog-build:n500`);

    const unread = parts.flatMap((p) => p.parentResourceIds ?? []);
    expect(unread).toHaveLength(800);
    const read = new Set(runs.map((r) => r.parentResourceId));
    for (const id of unread) expect(read.has(id)).toBe(false);
  });

  it("reads them all on a host that keeps no track, whose lists prune nothing", async () => {
    const { c } = builds(250);
    expect(await c.listResources("jfrog-build-run", ACCOUNT)).toHaveLength(250);
  });

  it("keeps the newest 25 runs of a build", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/artifactory/api/build") return { builds: [{ uri: "/app" }] };
      return {
        buildsNumbers: Array.from({ length: 40 }, (_, i) => ({
          uri: `/${i}`,
          started: `2026-01-${String(i % 28 || 28).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`,
        })),
      };
    });
    const runs = await c.listResources("jfrog-build-run", ACCOUNT);
    expect(runs).toHaveLength(25);
    expect(runs[0]!.fields["started"]).toBe("2026-01-28T04:00:00Z");
  });
});

describe("one detail request per row", () => {
  it.each([
    ["jfrog-group", "/access/api/v2/groups", "groups", "group_name"],
    ["jfrog-permission", "/access/api/v2/permissions", "permissions", "name"],
  ])("%s reads a poll's budget and names the rest", async (type, path, key, nameKey) => {
    const parts = trackUnread();
    const { c, calls } = client((call) => {
      if (call.url.pathname === path)
        return { [key]: names(500).map((name) => ({ [nameKey]: name })) };
      return { name: call.url.pathname.split("/").pop(), members: ["alice"] };
    });
    const rows = await c.listResources(type, ACCOUNT);
    expect(rows).toHaveLength(200);
    expect(calls.filter((x) => x.url.pathname !== path)).toHaveLength(200);

    const unread = parts.flatMap((p) => p.idPrefixes ?? []);
    expect(unread).toHaveLength(300);
    for (const r of rows) expect(unread).not.toContain(r.id);
    for (const prefix of unread) expect(prefix.startsWith(`${ACCOUNT}:${type}:n`)).toBe(true);
  });

  it("reads every group where the host keeps no track", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/access/api/v2/groups")
        return { groups: names(250).map((name) => ({ group_name: name })) };
      return { name: call.url.pathname.split("/").pop() };
    });
    expect(await c.listResources("jfrog-group", ACCOUNT)).toHaveLength(250);
  });

  it("does not blank a row the budget did not reach", async () => {
    trackUnread();
    const { c } = client((call) => {
      if (call.url.pathname === "/access/api/v2/groups")
        return { groups: names(300).map((name) => ({ group_name: name })) };
      return { name: call.url.pathname.split("/").pop(), members: ["alice"] };
    });
    const rows = await c.listResources("jfrog-group", ACCOUNT);
    for (const r of rows) expect(r.fields["members"]).toBe("alice");
  });
});

describe("a token refused a whole type", () => {
  const refused = () =>
    client(() => ({ status: 403, body: { errors: [{ message: "Forbidden" }] } }));

  it.each(["jfrog-user", "jfrog-group", "jfrog-permission", "jfrog-access-token"])(
    "%s keeps its rows without an error",
    async (type) => {
      const parts = trackUnread();
      expect(await refused().c.listResources(type, ACCOUNT)).toEqual([]);
      expect(parts).toEqual([{ idPrefixes: [""] }]);
    },
  );

  it("still shows a token refused even the platform, which says what is wrong with it", async () => {
    const parts = trackUnread();
    await expect(refused().c.listResources("jfrog-platform", ACCOUNT)).rejects.toThrow("Forbidden");
    expect(parts).toEqual([]);
  });

  it("still shows the refusal where the host keeps no track", async () => {
    await expect(refused().c.listResources("jfrog-user", ACCOUNT)).rejects.toThrow("Forbidden");
  });

  it.each([401, 429, 500])("still fails the type on a %i", async (status) => {
    const parts = trackUnread();
    const { c } = client(() => ({ status, body: { errors: [{ message: "nope" }] } }));
    await expect(c.listResources("jfrog-user", ACCOUNT)).rejects.toThrow("nope");
    expect(parts).toEqual([]);
  });
});
