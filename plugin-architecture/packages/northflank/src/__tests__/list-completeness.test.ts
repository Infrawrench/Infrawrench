import { hostClient } from "@infrawrench/plugin-base/effect";
import type { UnreadListPart } from "@infrawrench/plugin-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NorthflankClient } from "../client.js";

type Handler = (url: URL) => unknown;

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
const ACC = "acc1";
const API = "https://api.northflank.com";

/** A fetch that answers only the routes given and throws on anything else. */
function stubFetch(routes: Record<string, Handler>) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.origin !== API) throw new Error(`unexpected host ${url.origin}`);
    calls.push(url);
    const handler = routes[url.pathname];
    if (!handler) throw new Error(`unexpected request ${url.pathname}`);
    const value = handler(url);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function trackUnread(): UnreadListPart[] {
  const parts: UnreadListPart[] = [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: UnreadListPart) => parts.push(part));
  return parts;
}

function refused(status: number): Response {
  return new Response(JSON.stringify({ error: { status, message: "Nope" } }), { status });
}

const page = (key: string, rows: unknown[], cursor?: string) => ({
  data: { [key]: rows },
  pagination: {
    hasNextPage: cursor !== undefined,
    count: rows.length,
    ...(cursor ? { cursor } : {}),
  },
});

const client = () => hostClient(new NorthflankClient({ apiToken: "tok" }));

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
});

describe("list completeness", () => {
  it("throws at the page cap instead of returning part of a list", async () => {
    const calls = stubFetch({
      "/v1/cloud-providers/clusters": (url) =>
        page("clusters", [{ id: `c${url.searchParams.get("cursor") ?? ""}` }], "c".repeat(24)),
    });
    await expect(client().listResources("nf-cluster", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
    expect(calls[0]!.searchParams.get("per_page")).toBe("100");
  });

  it("refuses a page whose list key is missing, first page or later", async () => {
    stubFetch({ "/v1/cloud-providers/clusters": () => ({ data: { items: [] } }) });
    await expect(client().listResources("nf-cluster", ACC)).rejects.toThrow("is not a list");

    stubFetch({
      "/v1/cloud-providers/clusters": (url) =>
        url.searchParams.get("cursor")
          ? { data: {}, pagination: { hasNextPage: false, count: 0 } }
          : page("clusters", [{ id: "c1" }], "c".repeat(24)),
    });
    await expect(client().listResources("nf-cluster", ACC)).rejects.toThrow("is not a list");
  });

  it("refuses a page that says there is more and gives no cursor", async () => {
    stubFetch({
      "/v1/cloud-providers/clusters": () => ({
        data: { clusters: [{ id: "c1" }] },
        pagination: { hasNextPage: true, count: 1 },
      }),
    });
    await expect(client().listResources("nf-cluster", ACC)).rejects.toThrow("no cursor");
  });

  it("reads volumes from the documented array and from a wrapped list", async () => {
    stubFetch({
      "/v1/projects": () => page("projects", [{ id: "p1" }, { id: "p2" }]),
      "/v1/projects/p1/volumes": () => ({
        data: [{ id: "v1" }],
        pagination: { hasNextPage: false, count: 1 },
      }),
      "/v1/projects/p2/volumes": () => page("volumes", [{ id: "v2" }]),
    });
    const volumes = await client().listResources("nf-volume", ACC);
    expect(volumes.map((v) => v.externalId)).toEqual(["p1/v1", "p2/v2"]);
  });

  it("keeps a type's rows quietly when the token's role refuses it", async () => {
    const parts = trackUnread();
    stubFetch({ "/v1/cloud-providers/clusters": () => refused(403) });
    await expect(client().listResources("nf-cluster", ACC)).resolves.toEqual([]);
    expect(parts).toEqual([{ idPrefixes: [""] }]);
  });

  it("still fails a type on a throttle", async () => {
    trackUnread();
    stubFetch({ "/v1/cloud-providers/clusters": () => refused(429) });
    await expect(client().listResources("nf-cluster", ACC)).rejects.toMatchObject({ status: 429 });
  });

  it("names a refused project as unread and reads the rest", async () => {
    const parts = trackUnread();
    stubFetch({
      "/v1/projects": () => page("projects", [{ id: "p1" }, { id: "p2" }]),
      "/v1/projects/p1/jobs": () => refused(403),
      "/v1/projects/p2/jobs": () => page("jobs", [{ id: "j2" }]),
    });
    const jobs = await client().listResources("nf-job", ACC);
    expect(jobs.map((j) => j.externalId)).toEqual(["p2/j2"]);
    expect(parts).toEqual([{ parentResourceIds: [`${ACC}:nf-project:p1`] }]);
  });

  it("reads children for a budget of projects a poll and names the rest", async () => {
    const parts = trackUnread();
    const ids = Array.from({ length: 45 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const calls = stubFetch({
      "/v1/projects": () =>
        page(
          "projects",
          ids.map((id) => ({ id })),
        ),
      ...Object.fromEntries(
        ids.map((id) => [`/v1/projects/${id}/addons`, () => page("addons", [{ id: "a" }])]),
      ),
    });
    const addons = await client().listResources("nf-addon", ACC);
    expect(addons).toHaveLength(40);
    expect(calls).toHaveLength(41);
    const unread = parts.flatMap((p) => p.parentResourceIds ?? []);
    expect(unread).toHaveLength(5);
    const read = new Set(
      addons.map((a) => `${ACC}:nf-project:${(a.externalId ?? "").split("/")[0]}`),
    );
    for (const id of unread) expect(read.has(id)).toBe(false);
  });

  it("reads project details for a budget a poll and keeps the rest stored", async () => {
    const parts = trackUnread();
    const ids = Array.from({ length: 45 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    stubFetch({
      "/v1/projects": () =>
        page(
          "projects",
          ids.map((id) => ({ id })),
        ),
      ...Object.fromEntries(
        ids.map((id) => [
          `/v1/projects/${id}`,
          () => ({ data: { id, deployment: { region: "eu" } } }),
        ]),
      ),
    });
    const projects = await client().listResources("nf-project", ACC);
    expect(projects).toHaveLength(40);
    expect(projects.every((p) => p.fields["region"] === "eu")).toBe(true);
    const kept = parts.flatMap((p) => p.idPrefixes ?? []);
    expect(kept).toHaveLength(5);
    expect(kept.some((id) => projects.some((p) => p.id === id))).toBe(false);
  });

  it("does not read a project's details for a child type", async () => {
    const calls = stubFetch({
      "/v1/projects": () => page("projects", [{ id: "p1" }]),
      "/v1/projects/p1/pipelines": () => page("pipelines", []),
    });
    await client().listResources("nf-pipeline", ACC);
    expect(calls.map((c) => c.pathname)).toEqual(["/v1/projects", "/v1/projects/p1/pipelines"]);
  });

  it("fails the project type on a throttled detail read instead of blanking its fields", async () => {
    stubFetch({
      "/v1/projects": () => page("projects", [{ id: "p1" }]),
      "/v1/projects/p1": () => refused(429),
    });
    await expect(client().listResources("nf-project", ACC)).rejects.toMatchObject({ status: 429 });
  });

  it("does not read a domain whose details failed as having no subdomains", async () => {
    stubFetch({
      "/v1/domains": () => page("domains", [{ name: "example.com" }]),
      "/v1/domains/example.com": () => refused(500),
    });
    await expect(client().listResources("nf-subdomain", ACC)).rejects.toMatchObject({
      status: 500,
    });
  });

  it("names a domain whose details are refused as unread for its subdomains", async () => {
    const parts = trackUnread();
    stubFetch({
      "/v1/domains": () => page("domains", [{ name: "a.com" }, { name: "b.com" }]),
      "/v1/domains/a.com": () => refused(403),
      "/v1/domains/b.com": () => ({ data: { name: "b.com", subdomains: [{ name: "www" }] } }),
      "/v1/domains/b.com/subdomains/www": () => ({ data: { name: "www", verified: true } }),
    });
    const subs = await client().listResources("nf-subdomain", ACC);
    expect(subs.map((s) => s.externalId)).toEqual(["b.com/www"]);
    expect(parts).toEqual([{ parentResourceIds: [`${ACC}:nf-domain:a.com`] }]);
  });
});

describe("cost data completeness", () => {
  const range = { fromDate: "2026-10-01", toDate: "2026-10-02" };

  it("throws at the usage page cap", async () => {
    const calls = stubFetch({
      "/v1/billing/usage": () => ({
        data: { usage: [{ timestamp: 1_790_000_000 }] },
        pagination: { hasNextPage: true, cursor: "1" },
      }),
    });
    const err = await client().fetchCostData!(ACC, range).catch((e: unknown) => e);
    expect(String(err)).toContain("has more than Infrawrench reads");
    expect(calls).toHaveLength(100);
  });

  it("refuses a usage page whose usage is not a list", async () => {
    stubFetch({
      "/v1/billing/usage": () => ({
        data: { usage: "soon" },
        pagination: { hasNextPage: false, count: 0 },
      }),
    });
    await expect(client().fetchCostData!(ACC, range)).rejects.toThrow("is not a list");
  });

  it("passes a cut-short project usage read through its catch", async () => {
    stubFetch({
      "/v1/projects": () => page("projects", [{ id: "p1", uid: "u".repeat(24) }]),
      "/v1/billing/usage": (url) =>
        url.searchParams.get("projectId")
          ? { data: { usage: [] }, pagination: { hasNextPage: true, count: 0 } }
          : { data: { usage: [] }, pagination: { hasNextPage: false, count: 0 } },
    });
    await expect(client().fetchCostData!(ACC, range)).rejects.toThrow("no cursor");
  });

  it("attributes by the project listing without reading each project", async () => {
    const calls = stubFetch({
      "/v1/projects": () => page("projects", [{ id: "p1", uid: "u".repeat(24) }]),
      "/v1/billing/usage": () => ({
        data: { usage: [] },
        pagination: { hasNextPage: false, count: 0 },
      }),
    });
    await client().fetchCostData!(ACC, range);
    expect(calls.map((c) => c.pathname)).not.toContain("/v1/projects/p1");
  });
});

describe("host transport", () => {
  it("sends through services.http without a CA, and never through fetch", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const request = vi.fn(async (_req: { url: string; caCert?: string }) => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(page("clusters", [{ id: "c1" }])),
    }));
    const hosted = hostClient(new NorthflankClient({ apiToken: "tok" }, { http: { request } }));
    await hosted.listResources("nf-cluster", ACC);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
