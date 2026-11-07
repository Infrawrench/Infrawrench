import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigitalOceanClient } from "../client.js";
import { fetchDoCostData } from "../cost-data.js";
import { fakeApi } from "./fake-api.js";

const ACC = "acc1";
const BASE = "https://api.digitalocean.com/v2";

type Route = (path: string, page: number) => object | Response;

const seen: string[] = [];

function route(answer: Route) {
  seen.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.startsWith(BASE)) throw new Error(`Unexpected host: ${url}`);
      const path = url.slice(BASE.length);
      seen.push(path);
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const body = answer(path.split("?")[0]!, page);
      return body instanceof Response ? body : new Response(JSON.stringify(body));
    }),
  );
}

const client = () => hostClient(new DigitalOceanClient({ apiToken: "tok" }));
const rows = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ id: from + i, name: `n${from + i}` }));
const failing = (status: number) => new Response('{"id":"x"}', { status });

afterEach(() => vi.unstubAllGlobals());

// Each type the sync reads, with the list key the document names.
const INVENTORY = [
  ["droplet", "/droplets", "droplets"],
  ["doks-cluster", "/kubernetes/clusters", "kubernetes_clusters"],
  ["domain", "/domains", "domains"],
  ["project", "/projects", "projects"],
  ["volume", "/volumes", "volumes"],
  ["snapshot", "/snapshots", "snapshots"],
  ["image", "/images", "images"],
  ["vpc", "/vpcs", "vpcs"],
  ["reserved-ip", "/reserved_ips", "reserved_ips"],
  ["load-balancer", "/load_balancers", "load_balancers"],
  ["firewall", "/firewalls", "firewalls"],
  ["certificate", "/certificates", "certificates"],
  ["cdn-endpoint", "/cdn/endpoints", "endpoints"],
  ["uptime-check", "/uptime/checks", "checks"],
  ["vpc-nat-gateway", "/vpc_nat_gateways", "vpc_nat_gateways"],
  ["vpc-peering", "/vpc_peerings", "vpc_peerings"],
  ["app", "/apps", "apps"],
  ["autoscale-pool", "/droplets/autoscale", "autoscale_pools"],
  ["gen-ai-knowledge-base", "/gen-ai/knowledge_bases", "knowledge_bases"],
  ["gen-ai-model-router", "/gen-ai/models/routers", "model_routers"],
  ["dedicated-inference", "/dedicated-inferences", "dedicated_inferences"],
  ["model-api-key", "/gen-ai/models/api_keys", "api_key_infos"],
] as const;

describe("a list reads to its end (#416)", () => {
  it.each(INVENTORY)("reads every page of %s", async (typeId, listPath, key) => {
    route((path, page) => {
      if (path === listPath) {
        return page === 1
          ? { [key]: rows(200), meta: { total: 201 }, links: { pages: { next: "x" } } }
          : { [key]: rows(1, 200), meta: { total: 201 }, links: {} };
      }
      return { projects: [] };
    });
    await expect(client().listResources(typeId, ACC)).resolves.toHaveLength(201);
    const secondPage = seen.filter((path) => path.startsWith(`${listPath}?`)).at(-1);
    expect(secondPage).toMatch(/per_page=200&page=2$/);
  });

  it("reads past a page a route capped below what was asked", async () => {
    route((path, page) =>
      path === "/gen-ai/models/api_keys"
        ? page === 1
          ? { api_key_infos: rows(100), links: { pages: { next: "x" } } }
          : { api_key_infos: rows(3, 100), links: {} }
        : {},
    );
    await expect(client().listResources("model-api-key", ACC)).resolves.toHaveLength(103);
  });

  it("walks a domain's records and a project's resources too", async () => {
    route((path, page) => {
      if (path === "/domains") return { domains: [{ name: "a.example" }] };
      if (path === "/domains/a.example/records") {
        return page === 1
          ? { domain_records: rows(200), meta: { total: 201 } }
          : { domain_records: rows(1, 200), meta: { total: 201 } };
      }
      return {};
    });
    await expect(client().listResources("dns-record", ACC)).resolves.toHaveLength(201);

    route((path, page) => {
      if (path === "/droplets") return { droplets: [{ id: 9, name: "d" }], meta: { total: 1 } };
      if (path === "/projects") return { projects: [{ id: "p-1" }], meta: { total: 1 } };
      if (path === "/projects/p-1/resources") {
        return page === 1
          ? { resources: rows(200).map((r) => ({ urn: `do:other:${r.id}` })), meta: { total: 201 } }
          : { resources: [{ urn: "do:droplet:9" }], meta: { total: 201 } };
      }
      return {};
    });
    const [droplet] = await client().listResources("droplet", ACC);
    expect(droplet!.parentResourceId).toBe(`${ACC}:project:p-1`);
  });

  it("fails after 250 pages, not with part of the list", async () => {
    route((path) =>
      path === "/volumes"
        ? { volumes: rows(200), links: { pages: { next: "x" } } }
        : { projects: [] },
    );
    await expect(client().listResources("volume", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(seen.filter((path) => path.startsWith("/volumes"))).toHaveLength(250);
  });

  it("refuses a renamed list key, on the first page and on a later one", async () => {
    route((path) => (path === "/firewalls" ? { fire_walls: rows(1), meta: { total: 1 } } : {}));
    await expect(client().listResources("firewall", ACC)).rejects.toThrow("is not a list");

    route((path, page) => {
      if (path !== "/firewalls") return {};
      return page === 1
        ? { firewalls: rows(200), links: { pages: { next: "x" } } }
        : { fire_walls: rows(1) };
    });
    await expect(client().listResources("firewall", ACC)).rejects.toThrow("is not a list");
  });

  it("refuses an error wrapped in a 200, and a total with no rows", async () => {
    route(() => ({ id: "server_error", message: "try later" }));
    await expect(client().listResources("firewall", ACC)).rejects.toThrow("is not a list");

    route(() => ({ meta: { total: 3 } }));
    await expect(client().listResources("firewall", ACC)).rejects.toThrow("is not a list");
  });

  it.each([
    ["an empty list", { apps: [], meta: { total: 0 } }],
    ["a left-out list", { links: {}, meta: {} }],
    ["nothing at all", {}],
    ["a null list", { apps: null }],
  ])("reads %s as an account with none", async (_name, body) => {
    route(() => body);
    await expect(client().listResources("app", ACC)).resolves.toEqual([]);
  });

  it("reads `databases: null` as none, and a renamed key as an error", async () => {
    route((path) => (path === "/databases" ? { databases: null } : { projects: [] }));
    await expect(client().listResources("managed-database", ACC)).resolves.toEqual([]);

    route((path) => (path === "/databases" ? { clusters: rows(1) } : { projects: [] }));
    await expect(client().listResources("managed-database", ACC)).rejects.toThrow("is not a list");
    await expect(client().listResources("db-user", ACC)).rejects.toThrow("is not a list");
  });
});

describe("a failed read is not an empty list (#416)", () => {
  it.each(["gen-ai-agent", "gen-ai-knowledge-base", "gen-ai-model-router", "model-api-key"])(
    "%s reads 403 and 404 as a product not enabled, and nothing else",
    async (typeId) => {
      route(() => failing(403));
      await expect(client().listResources(typeId, ACC)).resolves.toEqual([]);
      route(() => failing(404));
      await expect(client().listResources(typeId, ACC)).resolves.toEqual([]);
      route(() => failing(500));
      await expect(client().listResources(typeId, ACC)).rejects.toThrow("500");
      route(() => failing(401));
      await expect(client().listResources(typeId, ACC)).rejects.toThrow("401");
      route(() => ({ renamed: rows(1) }));
      await expect(client().listResources(typeId, ACC)).rejects.toThrow("is not a list");
    },
  );

  it("does not prune an agent's keys when one agent's read fails", async () => {
    route((path) =>
      path === "/gen-ai/agents"
        ? { agents: [{ uuid: "a-1" }, { uuid: "a-2" }] }
        : path.endsWith("/a-1/api_keys")
          ? { api_key_infos: [{ uuid: "k-1" }] }
          : failing(500),
    );
    await expect(client().listResources("agent-api-key", ACC)).rejects.toThrow("500");
  });

  it("skips only a cluster with nothing to read for its users", async () => {
    route((path) => {
      if (path === "/databases") return { databases: [{ id: "c-1" }, { id: "c-2" }] };
      return path.includes("c-1") ? { users: [{ name: "doadmin" }] } : failing(409);
    });
    await expect(client().listResources("db-user", ACC)).resolves.toHaveLength(1);

    route((path) => {
      if (path === "/databases") return { databases: [{ id: "c-1" }, { id: "c-2" }] };
      return path.includes("c-1") ? { users: [{ name: "doadmin" }] } : failing(503);
    });
    await expect(client().listResources("db-user", ACC)).rejects.toThrow("503");
  });

  it("skips only a domain with nothing to read for its records", async () => {
    route((path) => {
      if (path === "/domains") return { domains: [{ name: "a.example" }, { name: "b.example" }] };
      return path.includes("a.example") ? { domain_records: rows(1) } : failing(404);
    });
    await expect(client().listResources("dns-record", ACC)).resolves.toHaveLength(1);

    route((path) => {
      if (path === "/domains") return { domains: [{ name: "a.example" }] };
      return failing(500);
    });
    await expect(client().listResources("dns-record", ACC)).rejects.toThrow("500");
  });

  it("keeps a truncated project walk from reading as no parents", async () => {
    route((path) => {
      if (path === "/projects") return { projects: [{ id: "p-1" }] };
      if (path === "/projects/p-1/resources") {
        return {
          resources: rows(200).map((r) => ({ urn: `u${r.id}` })),
          links: { pages: { next: "x" } },
        };
      }
      return { droplets: [] };
    });
    await expect(client().listResources("droplet", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("does not read a Spaces region's outage as its buckets being gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.startsWith(BASE)) return new Response(JSON.stringify({ projects: [] }));
        if (url.includes("sgp1")) return new Response("oops", { status: 503 });
        if (url.includes("fra1")) return new Response("denied", { status: 403 });
        return new Response("<ListAllMyBucketsResult/>");
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const spaces = hostClient(
      new DigitalOceanClient({
        apiToken: "tok",
        spacesAccessKeyId: "key",
        spacesSecretAccessKey: "secret",
      }),
    );
    await expect(spaces.listResources("spaces-bucket", ACC)).rejects.toThrow("503");
    vi.restoreAllMocks();
  });

  it("reads inference batches as a rolling window, and a failure as a failure", async () => {
    const answering = (status: number, body: object) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(body), { status })),
      );
    answering(404, {});
    await expect(client().listResources("inference-batch", ACC)).resolves.toEqual([]);
    answering(500, {});
    await expect(client().listResources("inference-batch", ACC)).rejects.toThrow("500");
    answering(200, { error: "x" });
    await expect(client().listResources("inference-batch", ACC)).rejects.toThrow("is not a list");
    answering(200, { object: "list", data: [{ batch_id: "b-1" }], has_more: true });
    await expect(client().listResources("inference-batch", ACC)).resolves.toHaveLength(1);
  });
});

describe("cost data", () => {
  const range = { fromDate: "2026-01-01", toDate: "2026-01-31" };
  const account = { account: { team: { uuid: "t-1" } } };

  it("refuses a page with no data points", async () => {
    const fetch = vi.fn(async (path: string) =>
      path === "/account" ? account : { total_pages: 1 },
    );
    await expect(fetchDoCostData({ api: fakeApi(fetch) }, range)).rejects.toThrow("is not a list");
  });

  it("stops at its cap with an error, not part of the bill", async () => {
    const fetch = vi.fn(async (path: string) =>
      path === "/account" ? account : { data_points: [], total_pages: 100_000 },
    );
    await expect(fetchDoCostData({ api: fakeApi(fetch) }, range)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(fetch).toHaveBeenCalledTimes(251);
  });
});
