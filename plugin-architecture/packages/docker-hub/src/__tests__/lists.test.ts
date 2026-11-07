import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockerHubClient } from "../client.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";
const EVIL = "https://evil.example/v2/next?page=2";

function client(route: (call: Call) => unknown, creds: Record<string, string> = {}) {
  const { http, calls } = makeHttp((call) => {
    if (call.url.pathname === "/v2/auth/token") return { access_token: "jwt-1" };
    return route(call);
  });
  return {
    c: hostClient(
      new DockerHubClient(
        { username: "alice", token: "dckr_pat_x", namespaces: "alice, acme", ...creds },
        { http } as never,
      ),
    ),
    api: () => calls.filter((x) => x.url.pathname !== "/v2/auth/token"),
  };
}

/** A list that always has another page. */
function endless(call: Call, path: string, rows: unknown[]) {
  const page = Number(call.url.searchParams.get("page") ?? "1");
  return { results: rows, next: `https://hub.docker.com${path}?page=${page + 1}&page_size=100` };
}

const TRUNCATED = "has more than Infrawrench reads";
const REFUSED = "Refusing to send the account's credentials there";
const NOT_A_LIST = "is not a list";

// Stubbed so a fixture that reaches `fetch` fails rather than leaving the machine.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("fetch must not be called");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a list longer than the plugin reads", () => {
  it("throws for repositories after exactly 500 pages rather than cut them short", async () => {
    const path = "/v2/namespaces/alice/repositories";
    const { c, api } = client((call) => endless(call, path, [{ namespace: "alice", name: "a" }]), {
      namespaces: "alice",
    });
    await expect(c.listResources("dockerhub-repository", ACCOUNT)).rejects.toThrow(TRUNCATED);
    expect(api()).toHaveLength(500);
  });

  it("reads past the old 20 page cap", async () => {
    const { c } = client(
      (call) => {
        const page = Number(call.url.searchParams.get("page") ?? "1");
        return {
          results: [{ namespace: "alice", name: `r${page}` }],
          next:
            page < 30
              ? `https://hub.docker.com/v2/namespaces/alice/repositories?page=${page + 1}`
              : null,
        };
      },
      { namespaces: "alice" },
    );
    expect(await c.listResources("dockerhub-repository", ACCOUNT)).toHaveLength(30);
  });

  it("throws for seats after exactly 500 pages", async () => {
    const { c, api } = client(
      (call) => endless(call, "/v2/orgs/acme/members", [{ username: "bob" }]),
      { namespaces: "acme" },
    );
    await expect(c.fetchSeats(ACCOUNT, { lookbackDays: 30 })).rejects.toThrow(TRUNCATED);
    expect(api()).toHaveLength(500);
  });

  it("does not skip an organization whose member list is too long", async () => {
    const { c } = client((call) => endless(call, "/v2/orgs/acme/members", [{ username: "bob" }]), {
      namespaces: "acme",
    });
    await expect(c.listResources("dockerhub-member", ACCOUNT)).rejects.toThrow(TRUNCATED);
  });

  it("still gives a picker what it could read", async () => {
    const { c, api } = client((call) =>
      endless(call, "/v2/namespaces/acme/repositories", [{ namespace: "acme", name: "a" }]),
    );
    const config = await c.getCreateConfig(
      "dockerhub-org-access-token",
      `${ACCOUNT}:dockerhub-namespace:acme`,
    );
    const picker = config.fields.find((f) => f.key === "repositories");
    expect(picker?.policies?.filter((p) => p.label === "a")).toHaveLength(20);
    expect(api()).toHaveLength(20);
  });
});

describe("tags", () => {
  const repos = (n: number, ns = "alice") =>
    Array.from({ length: n }, (_, i) => ({ namespace: ns, name: `r${i}` }));

  it("reads every tag of a repository, not just its first page", async () => {
    const { c, api } = client(
      (call) => {
        if (call.url.pathname === "/v2/namespaces/alice/repositories")
          return { results: repos(1), next: null };
        return call.url.searchParams.get("page") === "2"
          ? { results: [{ name: "old" }], next: null }
          : {
              results: [{ name: "new" }],
              next: "https://hub.docker.com/v2/namespaces/alice/repositories/r0/tags?page=2",
            };
      },
      { namespaces: "alice" },
    );
    const tags = await c.listResources("dockerhub-tag", ACCOUNT);
    expect(tags.map((t) => t.externalId)).toEqual(["alice/r0:new", "alice/r0:old"]);
    expect(api()[1]!.url.searchParams.get("page_size")).toBe("100");
  });

  it("reads the tags of a repository past the old 100 repository cap", async () => {
    const { c } = client(
      (call) =>
        call.url.pathname === "/v2/namespaces/alice/repositories"
          ? { results: repos(150), next: null }
          : { results: [{ name: "latest" }], next: null },
      { namespaces: "alice" },
    );
    expect(await c.listResources("dockerhub-tag", ACCOUNT)).toHaveLength(150);
  });

  it("throws past 1,000 repositories, before reading a single tag", async () => {
    const { c, api } = client(
      (call) =>
        call.url.pathname === "/v2/namespaces/alice/repositories"
          ? { results: repos(1001), next: null }
          : { results: [], next: null },
      { namespaces: "alice" },
    );
    await expect(c.listResources("dockerhub-tag", ACCOUNT)).rejects.toThrow(TRUNCATED);
    expect(api()).toHaveLength(1);
  });

  it("throws after exactly 100 pages of one repository's tags", async () => {
    const tags = "/v2/namespaces/alice/repositories/r0/tags";
    const { c, api } = client(
      (call) =>
        call.url.pathname === tags
          ? endless(call, tags, [{ name: "t" }])
          : { results: repos(1), next: null },
      { namespaces: "alice" },
    );
    await expect(c.listResources("dockerhub-tag", ACCOUNT)).rejects.toThrow(TRUNCATED);
    expect(api().filter((x) => x.url.pathname === tags)).toHaveLength(100);
  });

  it("fails the list when a repository's tags fail, rather than read them as none", async () => {
    const { c } = client(
      (call) =>
        call.url.pathname === "/v2/namespaces/alice/repositories"
          ? { results: repos(1), next: null }
          : { status: 500, body: { message: "boom" } },
      { namespaces: "alice" },
    );
    await expect(c.listResources("dockerhub-tag", ACCOUNT)).rejects.toThrow(/500/);
  });

  it("reads tags it may not see, or of a repository just deleted, as none", async () => {
    for (const status of [403, 404]) {
      const { c } = client(
        (call) =>
          call.url.pathname === "/v2/namespaces/alice/repositories"
            ? { results: repos(1), next: null }
            : { status, body: { message: "no" } },
        { namespaces: "alice" },
      );
      expect(await c.listResources("dockerhub-tag", ACCOUNT)).toEqual([]);
    }
  });

  it("reaches the caller when a tag page is not a list", async () => {
    const { c } = client(
      (call) =>
        call.url.pathname === "/v2/namespaces/alice/repositories"
          ? { results: repos(1), next: null }
          : { error: "nope" },
      { namespaces: "alice" },
    );
    await expect(c.listResources("dockerhub-tag", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });
});

describe("a page that is not a list", () => {
  it("rejects on the first page", async () => {
    const { c } = client(() => ({ repositories: [] }), { namespaces: "alice" });
    await expect(c.listResources("dockerhub-repository", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("rejects on a later page", async () => {
    const { c } = client(
      (call) =>
        call.url.searchParams.get("page") === "2"
          ? { repositories: [] }
          : {
              results: [{ namespace: "alice", name: "a" }],
              next: "https://hub.docker.com/v2/namespaces/alice/repositories?page=2",
            },
      { namespaces: "alice" },
    );
    await expect(c.listResources("dockerhub-repository", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("rejects an invite answer without its list", async () => {
    const { c } = client(() => ({ invites: [] }), { namespaces: "acme" });
    await expect(c.listResources("dockerhub-invite", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
  });

  it("reads a list key set to null as empty", async () => {
    const { c } = client(() => ({ data: null }), { namespaces: "acme" });
    expect(await c.listResources("dockerhub-invite", ACCOUNT)).toEqual([]);
  });
});

describe("a next link to another host", () => {
  it("is refused, and no request reaches that host", async () => {
    const { c, api } = client(
      () => ({ results: [{ namespace: "alice", name: "a" }], next: EVIL }),
      { namespaces: "alice" },
    );
    await expect(c.listResources("dockerhub-repository", ACCOUNT)).rejects.toThrow(REFUSED);
    expect(api().map((x) => x.url.host)).toEqual(["hub.docker.com"]);
  });

  it("is refused on a plain http link to the same host", async () => {
    const { c, api } = client(
      () => ({
        results: [{ namespace: "alice", name: "a" }],
        next: "http://hub.docker.com/v2/namespaces/alice/repositories?page=2",
      }),
      { namespaces: "alice" },
    );
    await expect(c.listResources("dockerhub-repository", ACCOUNT)).rejects.toThrow(REFUSED);
    expect(api()).toHaveLength(1);
  });

  it("follows a relative link on the same host", async () => {
    const { c } = client(
      (call) =>
        call.url.searchParams.get("page") === "2"
          ? { results: [{ namespace: "alice", name: "b" }], next: null }
          : {
              results: [{ namespace: "alice", name: "a" }],
              next: "/v2/namespaces/alice/repositories?page=2",
            },
      { namespaces: "alice" },
    );
    expect(await c.listResources("dockerhub-repository", ACCOUNT)).toHaveLength(2);
  });

  it("reaches the caller through each catch in the list path", async () => {
    const foreign = { results: [{ username: "bob", name: "t" }], next: EVIL };
    const namespaces = client(() => foreign, { namespaces: "alice" });
    await expect(namespaces.c.listResources("dockerhub-namespace", ACCOUNT)).rejects.toThrow(
      REFUSED,
    );

    const members = client(() => foreign, { namespaces: "acme" });
    await expect(members.c.listResources("dockerhub-member", ACCOUNT)).rejects.toThrow(REFUSED);

    const teamMembers = client(
      (call) =>
        call.url.pathname.endsWith("/members") ? foreign : { results: [{ name: "t" }], next: null },
      { namespaces: "acme" },
    );
    await expect(teamMembers.c.listResources("dockerhub-team", ACCOUNT)).rejects.toThrow(REFUSED);

    const tags = client(
      (call) =>
        call.url.pathname.endsWith("/tags")
          ? { results: [{ name: "t" }], next: EVIL }
          : { results: [{ namespace: "alice", name: "a" }], next: null },
      { namespaces: "alice" },
    );
    await expect(tags.c.listResources("dockerhub-tag", ACCOUNT)).rejects.toThrow(REFUSED);

    const orgs = client(() => ({ results: [{ orgname: "acme" }], next: EVIL }), { namespaces: "" });
    await expect(orgs.c.listResources("dockerhub-repository", ACCOUNT)).rejects.toThrow(REFUSED);
  });
});

describe("the organization list behind every org-level list", () => {
  it("fails on an outage rather than read as no organizations", async () => {
    const { c } = client(
      (call) =>
        call.url.pathname === "/v2/user/orgs/"
          ? { status: 500, body: { message: "boom" } }
          : { results: [], next: null },
      { namespaces: "" },
    );
    await expect(c.listResources("dockerhub-repository", ACCOUNT)).rejects.toThrow(/500/);
    await expect(c.listResources("dockerhub-member", ACCOUNT)).rejects.toThrow(/500/);
  });

  it("leaves a token that may not list organizations with its own namespace", async () => {
    const { c, api } = client(
      (call) =>
        call.url.pathname === "/v2/user/orgs/"
          ? { status: 403, body: { message: "no" } }
          : { results: [{ namespace: "alice", name: "a" }], next: null },
      { namespaces: "" },
    );
    const repos = await c.listResources("dockerhub-repository", ACCOUNT);
    expect(repos.map((r) => r.externalId)).toEqual(["alice/a"]);
    expect(api().map((x) => x.url.pathname)).toContain("/v2/namespaces/alice/repositories");
  });

  it("fails seats on a token that may not list organizations, which is not zero seats", async () => {
    const { c } = client(() => ({ status: 403, body: { message: "no" } }), { namespaces: "" });
    await expect(c.fetchSeats(ACCOUNT, { lookbackDays: 30 })).rejects.toThrow(
      /cannot list the organizations/,
    );
  });

  it("reads seats from every organization the token lists", async () => {
    const { c } = client(
      (call) =>
        call.url.pathname === "/v2/user/orgs/"
          ? { results: [{ orgname: "acme" }], next: null }
          : { results: [{ username: "bob" }], next: null },
      { namespaces: "" },
    );
    const seats = await c.fetchSeats(ACCOUNT, { lookbackDays: 30 });
    expect(seats.map((s) => s.memberId)).toEqual(["acme/bob"]);
  });
});

describe("a single read that looks through a list", () => {
  it("does not read an invite as gone when the list fails", async () => {
    const { c } = client(() => ({ status: 500, body: { message: "boom" } }), {
      namespaces: "acme",
    });
    await expect(
      c.getResource("dockerhub-invite", `${ACCOUNT}:dockerhub-invite:i1`, ACCOUNT),
    ).rejects.toThrow(/500/);
  });

  it("says an invite is gone when the list does not have it", async () => {
    const { c } = client(() => ({ data: [] }), { namespaces: "acme" });
    await expect(
      c.getResource("dockerhub-invite", `${ACCOUNT}:dockerhub-invite:i1`, ACCOUNT),
    ).rejects.toThrow(/not found/);
  });
});

describe("Docker Hub's rate limit", () => {
  it("waits as long as Retry-After says, then asks again", async () => {
    let limited = true;
    const { c, api } = client(
      () => {
        if (limited) {
          limited = false;
          return { status: 429, headers: { "Retry-After": "0" }, body: { message: "slow down" } };
        }
        return { results: [{ namespace: "alice", name: "a" }], next: null };
      },
      { namespaces: "alice" },
    );
    expect(await c.listResources("dockerhub-repository", ACCOUNT)).toHaveLength(1);
    expect(api()).toHaveLength(2);
  });

  it("fails rather than sit through a long wait, and does not ask without being told when", async () => {
    for (const headers of [{ "Retry-After": "3600" }, {}]) {
      const { c, api } = client(() => ({ status: 429, headers, body: { message: "no" } }), {
        namespaces: "alice",
      });
      await expect(c.listResources("dockerhub-repository", ACCOUNT)).rejects.toThrow(/429/);
      expect(api()).toHaveLength(1);
    }
  });

  it("gives up after a few waits", async () => {
    const { c, api } = client(
      () => ({ status: 429, headers: { "Retry-After": "0" }, body: { message: "no" } }),
      { namespaces: "alice" },
    );
    await expect(c.listResources("dockerhub-repository", ACCOUNT)).rejects.toThrow(/429/);
    expect(api()).toHaveLength(4);
  });
});
