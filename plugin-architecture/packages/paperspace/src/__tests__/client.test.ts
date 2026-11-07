import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperspaceClient } from "../client.js";
import { MAX_PAGES, PaperspaceApiError } from "../api.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { machineTypeOptions } from "../create-config.js";
import { timeframeFor, toSeries, METRICS } from "../metrics.js";
import { mapComponent, parseStatusFeed } from "../status-feed.js";

interface Call {
  method: string;
  url: URL;
  body: unknown;
  headers: Record<string, string>;
}
type Route = (call: Call) => unknown;
let calls: Call[] = [];
let routes: Record<string, Route> = {};

function route(method: string, path: string, handler: Route | unknown) {
  routes[`${method} ${path}`] = typeof handler === "function" ? (handler as Route) : () => handler;
}

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const call: Call = {
        method: init.method ?? "GET",
        url: u,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers as Record<string, string>,
      };
      calls.push(call);
      const handler = routes[`${call.method} ${u.pathname.replace(/^\/v1/, "")}`];
      if (!handler) {
        return new Response(JSON.stringify({ code: "NOT_FOUND", message: "Not found" }), {
          status: 404,
        });
      }
      const out = handler(call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const client = () => hostClient(new PaperspaceClient({ apiKey: "KEY" }, RESOURCE_TYPES));

const MACHINE = {
  id: "ps1",
  name: "trainer",
  state: "ready",
  os: "Ubuntu 22.04",
  machineType: "A4000",
  cpus: 8,
  ram: 48 * 1024 ** 3,
  storageTotal: 100 * 1024 ** 3,
  storageUsed: 20 * 1024 ** 3,
  accelerators: [{ name: "A4000", memory: 16, count: 1 }],
  region: "ny2",
  privateIp: "10.0.0.5",
  networkId: "net1",
  publicIp: "1.2.3.4",
  publicIpType: "dynamic",
  autoShutdownEnabled: true,
  autoShutdownTimeout: 8,
  usageRate: 0.76,
  dtCreated: "2026-09-01T00:00:00Z",
};

describe("api", () => {
  it("sends Bearer auth, follows cursors, and maps errors", async () => {
    route("GET", "/machines", (c: Call) =>
      c.url.searchParams.get("after")
        ? { items: [{ ...MACHINE, id: "ps2" }], hasMore: false, nextPage: null }
        : { items: [MACHINE], hasMore: true, nextPage: "cur" },
    );
    const list = await client().listResources("machine", "acct");
    expect(list.map((m) => m.externalId)).toEqual(["ps1", "ps2"]);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer KEY");
    expect(calls[0]!.url.searchParams.get("limit")).toBe("120");

    route(
      "GET",
      "/projects",
      () =>
        new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "You must be logged in" }), {
          status: 401,
        }),
    );
    const err = (await client()
      .listResources("project", "acct")
      .catch((e: unknown) => e)) as PaperspaceApiError;
    expect(err).toBeInstanceOf(PaperspaceApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
  });
});

describe("reading a whole list", () => {
  const row = (id: string) => ({ ...MACHINE, id });

  it("fails a list that is still going at the cap, after exactly that many requests", async () => {
    route("GET", "/machines", (c: Call) => ({
      items: [row(c.url.searchParams.get("after") ?? "first")],
      hasMore: true,
      nextPage: `cur${calls.length}`,
    }));
    await expect(client().listResources("machine", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(MAX_PAGES);
    // 50,000 rows at the document's largest page, the most a sync can prune.
    expect(MAX_PAGES).toBe(417);
    expect(calls[0]!.url.searchParams.get("limit")).toBe("120");
  });

  it("gives a create form what fits instead of failing it at the cap", async () => {
    route("GET", "/machines", () => ({
      items: [row(`m${calls.length}`)],
      hasMore: true,
      nextPage: `cur${calls.length}`,
    }));
    const config = await client().getCreateConfig("snapshot");
    const machine = config.fields.find((f) => f.key === "machineId");
    expect(machine?.options).toHaveLength(MAX_PAGES);
  });

  it("fails a first page whose list is missing or renamed", async () => {
    route("GET", "/machines", { machines: [MACHINE], hasMore: false });
    await expect(client().listResources("machine", "acct")).rejects.toThrow("is not a list");
    route("GET", "/machines", { hasMore: false });
    await expect(client().listResources("machine", "acct")).rejects.toThrow("is not a list");
  });

  it("fails a 200 with no body at all", async () => {
    route("GET", "/machines", () => new Response(null, { status: 200 }));
    await expect(client().listResources("machine", "acct")).rejects.toThrow("is not a list");
  });

  it("fails a later page whose list is missing", async () => {
    route("GET", "/machines", (c: Call) =>
      c.url.searchParams.get("after")
        ? { machines: [], hasMore: false }
        : { items: [MACHINE], hasMore: true, nextPage: "cur" },
    );
    await expect(client().listResources("machine", "acct")).rejects.toThrow("is not a list");
    expect(calls).toHaveLength(2);
  });

  it("fails a page that says there is more and gives no way to read it", async () => {
    route("GET", "/machines", { items: [MACHINE], hasMore: true });
    await expect(client().listResources("machine", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("follows a cursor on a page that leaves hasMore out", async () => {
    route("GET", "/machines", (c: Call) =>
      c.url.searchParams.get("after")
        ? { items: [row("ps2")], hasMore: false }
        : { items: [MACHINE], nextPage: "cur" },
    );
    const list = await client().listResources("machine", "acct");
    expect(list.map((m) => m.externalId)).toEqual(["ps1", "ps2"]);
  });

  it("goes on past an empty page that says there is more", async () => {
    route("GET", "/machines", (c: Call) =>
      c.url.searchParams.get("after")
        ? { items: [MACHINE], hasMore: false }
        : { items: [], hasMore: true, nextPage: "cur" },
    );
    const list = await client().listResources("machine", "acct");
    expect(list.map((m) => m.externalId)).toEqual(["ps1"]);
  });

  it("reads an empty account as empty", async () => {
    route("GET", "/machines", { items: [], hasMore: false });
    expect(await client().listResources("machine", "acct")).toEqual([]);
  });

  it("sends a list through the host's service, with no CA, and not fetch", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ items: [MACHINE], hasMore: false }),
    }));
    const hosted = hostClient(
      new PaperspaceClient({ apiKey: "KEY" }, RESOURCE_TYPES, { http: { request } }),
    );
    expect((await hosted.listResources("machine", "acct")).map((m) => m.externalId)).toEqual([
      "ps1",
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).not.toHaveProperty("0.caCert");
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});

describe("machines", () => {
  it("maps specs in GB and connection outputs", async () => {
    route("GET", "/machines/ps1", MACHINE);
    const m = await client().getResource("machine", "acct:machine:ps1", "acct");
    expect(m.fields).toMatchObject({
      ramGb: 48,
      storageTotalGb: 100,
      gpu: "A4000",
      region: "ny2",
      usageRate: 0.76,
    });
    expect(m.resolvedOutputs["sshCommand"]).toBe("ssh paperspace@1.2.3.4");
  });

  it("creates with picker values, dropping none choices", async () => {
    route("POST", "/machines", (c: Call) => ({
      data: { ...MACHINE, ...(c.body as object) },
      event: { id: "e1", state: "new" },
    }));
    await client().createResource("machine", "acct", {
      name: "m",
      region: "ca1",
      templateId: "tmpl",
      machineType: "A5000",
      diskSize: "250",
      publicIpType: "static",
      networkId: "none",
      startupScriptId: "s1",
      autoShutdownEnabled: "true",
      autoShutdownTimeout: "4",
      startOnCreate: "false",
    });
    expect(calls[0]!.body).toEqual({
      name: "m",
      region: "ca1",
      machineType: "A5000",
      templateId: "tmpl",
      diskSize: 250,
      publicIpType: "static",
      startOnCreate: false,
      autoShutdownEnabled: true,
      autoShutdownTimeout: 4,
      startupScriptId: "s1",
    });
  });

  it("starts, stops and restarts with PATCH", async () => {
    for (const a of ["start", "stop", "restart"])
      route("PATCH", `/machines/ps1/${a}`, { event: { id: "e" } });
    const c = client();
    for (const a of ["start", "stop", "restart"])
      await c.invokeAction("machine", "acct:machine:ps1", a, "acct");
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "PATCH /v1/machines/ps1/start",
      "PATCH /v1/machines/ps1/stop",
      "PATCH /v1/machines/ps1/restart",
    ]);
  });

  it("updates settings and waits for the event", async () => {
    let polls = 0;
    route("PUT", "/machines/ps1", { data: MACHINE, event: { id: "e1", state: "in progress" } });
    route("GET", "/machine-events/e1", () => ({ id: "e1", state: ++polls > 0 ? "done" : "new" }));
    route("GET", "/machines/ps1", MACHINE);
    vi.useFakeTimers();
    const p = client().updateResource("machine", "acct:machine:ps1", "acct", {
      name: "x",
      machineType: "A6000",
      autoShutdownEnabled: "false",
      autoSnapshotFrequency: "",
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await p;
    vi.useRealTimers();
    expect(calls[0]!.body).toEqual({ name: "x", machineType: "A6000", autoShutdownEnabled: false });
    expect(polls).toBe(1);
  });

  it("surfaces a failed event", async () => {
    route("POST", "/snapshots", {
      data: { id: "s1" },
      event: { id: "e9", state: "error", name: "snapshot-create", error: "disk busy" },
    });
    await expect(
      client().createResource("snapshot", "acct", { name: "s", machineId: "ps1" }),
    ).rejects.toThrow(/disk busy/);
  });
});

describe("other resources", () => {
  it("never stores the shared drive password but resolves it on demand", async () => {
    const drive = {
      id: "d1",
      name: "data",
      size: 500,
      mountPoint: "\\\\10.0.0.2\\data",
      username: "u",
      password: "pw-secret",
      networkId: "net1",
      region: "ny2",
    };
    route("GET", "/shared-drives", { items: [drive], hasMore: false });
    route("GET", "/shared-drives/d1", drive);
    const c = client();
    const [d] = await c.listResources("shared-drive", "acct");
    expect(JSON.stringify(d)).not.toContain("pw-secret");
    expect(await c.resolveOutput("shared-drive", d!.id, "password", "acct")).toBe("pw-secret");
  });

  it("creates a shared drive in its network's region", async () => {
    route("GET", "/private-networks", { items: [{ id: "net1", region: "ams1" }], hasMore: false });
    route("POST", "/shared-drives", (c: Call) => ({ id: "d", ...(c.body as object) }));
    await client().createResource("shared-drive", "acct", {
      name: "x",
      networkId: "net1",
      size: "250",
    });
    expect(calls[1]!.body).toEqual({ name: "x", size: 250, region: "ams1", networkId: "net1" });
  });

  it("says why when the networks cannot be read for a new shared drive", async () => {
    route(
      "GET",
      "/private-networks",
      () => new Response(JSON.stringify({ message: "Upstream down" }), { status: 500 }),
    );
    await expect(
      client().createResource("shared-drive", "acct", { name: "x", networkId: "net1" }),
    ).rejects.toMatchObject({ status: 500 });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("assigns public IPs and startup scripts by attaching them to a machine", async () => {
    route("PUT", "/public-ips/5.6.7.8", { ip: "5.6.7.8" });
    route("POST", "/startup-scripts/s1/assign", { id: "s1" });
    const c = client();
    await c.attachResource(
      "public-ip",
      "acct:public-ip:5.6.7.8",
      "machine",
      "acct:machine:ps1",
      "acct",
    );
    await c.attachResource(
      "startup-script",
      "acct:startup-script:s1",
      "machine",
      "acct:machine:ps1",
      "acct",
    );
    expect(calls.map((x) => x.body)).toEqual([{ machineId: "ps1" }, { machineId: "ps1" }]);
  });

  it("only sends a startup script body when one was typed", async () => {
    route("PUT", "/startup-scripts/s1", { id: "s1", name: "x" });
    await client().updateResource("startup-script", "acct:startup-script:s1", "acct", {
      name: "x",
      script: "",
      enabled: "true",
    });
    expect(calls[0]!.body).toEqual({ name: "x", isEnabled: true });
  });

  it("lists deployments under their project with the endpoint URL", async () => {
    route("GET", "/deployments", {
      items: [
        {
          id: "dep1",
          name: "api",
          projectId: "p1",
          endpoint: "abc.paperspacegradient.com",
          latestSpec: { data: { image: "img", resources: { machineType: "A4000", replicas: 2 } } },
        },
      ],
      hasMore: false,
    });
    const [d] = await client().listResources("deployment", "acct");
    expect(d!.parentResourceId).toBe("acct:project:p1");
    expect(d!.fields).toMatchObject({ machineType: "A4000", replicas: 2 });
    expect(d!.resolvedOutputs["endpointUrl"]).toBe("https://abc.paperspacegradient.com");
  });
});

describe("a private network answered with null", () => {
  it("is a not-found error carrying a 404, not a TypeError", async () => {
    route("GET", "/private-networks/net1", () => new Response("null", { status: 200 }));
    const err: unknown = await client()
      .getResource("private-network", "acct:private-network:net1", "acct")
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err).toMatchObject({
      status: 404,
      message: "Paperspace plugin: private network net1 not found",
    });
  });

  it("still reads a network that is there", async () => {
    route("GET", "/private-networks/net1", { id: "net1", name: "lan", region: "ny2" });
    const n = await client().getResource("private-network", "acct:private-network:net1", "acct");
    expect(n.fields).toMatchObject({ name: "lan", region: "ny2" });
  });
});

describe("snapshot created date", () => {
  const SNAPSHOT = { id: "s1", name: "nightly", machineId: "ps1", isAutoSnapshot: false };

  it("reads dtCreated when the API sends one, though the document lists none", async () => {
    route("GET", "/snapshots", {
      items: [{ ...SNAPSHOT, dtCreated: "2026-09-01T00:00:00Z" }],
      hasMore: false,
    });
    const [s] = await client().listResources("snapshot", "acct");
    expect(s!.fields["createdAt"]).toBe("2026-09-01T00:00:00Z");
    expect(s!.createdAt).toBe("2026-09-01T00:00:00Z");
  });

  it("takes the date from the create event, which the document does give", async () => {
    route("POST", "/snapshots", {
      data: SNAPSHOT,
      event: { id: "e1", state: "done", dtCreated: "2026-10-01T00:00:00Z" },
    });
    const s = await client().createResource("snapshot", "acct", {
      name: "nightly",
      machineId: "ps1",
    });
    expect(s.fields["createdAt"]).toBe("2026-10-01T00:00:00Z");
    expect(s.createdAt).toBe("2026-10-01T00:00:00Z");
  });

  it("leaves the field out when it has no date, so a sync keeps the stored one", async () => {
    route("GET", "/snapshots", { items: [SNAPSHOT], hasMore: false });
    const [listed] = await client().listResources("snapshot", "acct");
    expect(listed!.fields).not.toHaveProperty("createdAt");

    route("PUT", "/snapshots/s1", SNAPSHOT);
    const renamed = await client().updateResource("snapshot", "acct:snapshot:s1", "acct", {
      name: "nightly",
    });
    expect(renamed.fields).not.toHaveProperty("createdAt");
  });
});

describe("deployment port", () => {
  const portOf = async (data: object) => {
    route("GET", "/deployments/dep1", { id: "dep1", name: "api", latestSpec: { data } });
    return (await client().getResource("deployment", "acct:deployment:dep1", "acct")).fields[
      "port"
    ];
  };
  const resources = { machineType: "A4000", replicas: 1 };

  it.each(["v0alpha1", "v1", "latest"])("reads resources.ports on %s", async (apiVersion) => {
    expect(
      await portOf({ apiVersion, image: "i", resources: { ...resources, ports: [8080, 9000] } }),
    ).toBe(8080);
  });

  it("reads the top-level port on v0alpha0", async () => {
    expect(await portOf({ apiVersion: "v0alpha0", image: "i", port: 3000, resources })).toBe(3000);
  });

  it("uses the document's default on a v0alpha0 spec that names no port", async () => {
    expect(await portOf({ apiVersion: "v0alpha0", image: "i", resources })).toBe(80);
  });

  it("stays 0 on a deployment with no spec", async () => {
    route("GET", "/deployments/dep1", { id: "dep1", name: "api" });
    const d = await client().getResource("deployment", "acct:deployment:dep1", "acct");
    expect(d.fields["port"]).toBe(0);
  });
});

describe("metrics", () => {
  it("picks the smallest timeframe that covers the range", () => {
    expect(timeframeFor(30 * 60_000)).toBe("hour");
    expect(timeframeFor(20 * 3_600_000)).toBe("day");
    expect(timeframeFor(100 * 24 * 3_600_000)).toBe("2_weeks");
  });

  it("sums per-replica request series and averages resource series", () => {
    const res = [
      { instanceId: "a", values: [{ timestamp: "2026-10-01T00:00:00Z", value: "2" }] },
      { instanceId: "b", values: [{ timestamp: "2026-10-01T00:00:00Z", value: "4" }] },
    ];
    const start = Date.parse("2026-09-30T00:00:00Z");
    const end = Date.parse("2026-10-02T00:00:00Z");
    expect(toSeries(res, METRICS[0]!, start, end)!.points[0]!.value).toBe(6);
    expect(toSeries(res, METRICS[2]!, start, end)!.points[0]!.value).toBe(3);
    expect(
      toSeries({ timestamp: "2020-01-01T00:00:00Z", value: "1" }, METRICS[2]!, start, end),
    ).toBeNull();
  });
});

describe("create helpers and status", () => {
  it("collects machine types from templates", () => {
    expect(
      machineTypeOptions([
        {
          id: "a",
          availableMachineTypes: [
            { machineTypeLabel: "A4000", isAvailable: true },
            { machineTypeLabel: "C5", isAvailable: false },
          ],
        },
        {
          id: "b",
          availableMachineTypes: [{ machineTypeLabel: "A4000" }, { machineTypeLabel: "A100-80G" }],
        },
      ]).map((o) => [o.id, o.description]),
    ).toEqual([
      ["A100-80G", "1 template"],
      ["A4000", "2 templates"],
    ]);
  });

  it("maps region components to region codes", () => {
    expect(mapComponent("US (NY2)")).toEqual({ regions: ["ny2"] });
    expect(mapComponent("Europe (AMS1)")).toEqual({ regions: ["ams1"] });
    expect(mapComponent("API")?.providerWide).toBe(true);
  });

  it("parses Statuspage incidents", () => {
    const out = parseStatusFeed(
      JSON.stringify({
        page: { id: "p", name: "Paperspace", url: "https://status.paperspace.com" },
        incidents: [
          {
            id: "i1",
            name: "NY2 degraded",
            status: "investigating",
            impact: "major",
            created_at: "2026-10-05T00:00:00Z",
            updated_at: "2026-10-05T00:10:00Z",
            incident_updates: [],
            components: [{ id: "c", name: "US (NY2)" }],
          },
        ],
      }),
    );
    expect(out[0]).toMatchObject({ externalId: "i1", regions: ["ny2"] });
  });
});
