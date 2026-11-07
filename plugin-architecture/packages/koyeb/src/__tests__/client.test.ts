import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KoyebClient,
  applyServiceEdits,
  buildDefinition,
  connectionUrl,
  memoryMb,
  pinDefinition,
  quotasFrom,
} from "../client.js";
import { invoiceRows } from "../cost-data.js";
import { combine } from "../metrics.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { parseStatusFeed } from "../status-feed.js";
import { koyebTerraformExport } from "../terraform.js";

const ACCOUNT = "acct";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
let routes: Record<string, ((c: Call) => unknown) | object> = {};

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const call = {
        method: init.method ?? "GET",
        path: u.pathname,
        query: u.searchParams,
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const h = routes[`${call.method} ${call.path}`];
      if (!h)
        return new Response(
          JSON.stringify({ status: 404, code: "not_found", message: "Not found" }),
          { status: 404 },
        );
      const out = typeof h === "function" ? (h as (c: Call) => unknown)(call) : h;
      return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const client = () => hostClient(new KoyebClient({ apiToken: "tok" }, RESOURCE_TYPES));

const APP = {
  id: "app1",
  name: "shop",
  status: "HEALTHY",
  domains: [{ id: "d1", name: "shop-acme.koyeb.app", type: "AUTOASSIGNED", status: "ACTIVE" }],
};
const SERVICE = {
  id: "svc1",
  name: "api",
  type: "WEB",
  app_id: "app1",
  status: "HEALTHY",
  latest_deployment_id: "dep2",
  active_deployment_id: "dep2",
};
const DEP = {
  id: "dep2",
  service_id: "svc1",
  status: "HEALTHY",
  definition: {
    name: "api",
    type: "WEB",
    regions: ["fra"],
    instance_types: [{ type: "small" }],
    scalings: [{ min: 1, max: 3 }],
    ports: [{ port: 8000, protocol: "http" }],
    routes: [{ port: 8000, path: "/" }],
    git: {
      repository: "github.com/acme/api",
      branch: "main",
      buildpack: { run_command: "npm start" },
    },
    env: [{ key: "A", value: "1" }],
  },
  provisioning_info: { sha: "abcdef1234" },
  metadata: { trigger: { type: "GIT", git: { message: "Ship it\nbody" } } },
};

describe("transport", () => {
  it("sends the bearer token and pages with limit/offset until count is reached", async () => {
    routes["GET /v1/apps"] = (c: Call) =>
      c.query.get("offset") === "0"
        ? { apps: Array.from({ length: 100 }, (_, i) => ({ ...APP, id: `a${i}` })), count: "101" }
        : { apps: [APP], count: "101" };
    const apps = await client().listResources("app", ACCOUNT);
    expect(apps).toHaveLength(101);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect(calls[1]!.query.get("offset")).toBe("100");
  });

  it("attaches the HTTP status to errors", async () => {
    routes["GET /v1/apps/x"] = () =>
      new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
    const err = await client()
      .getResource("app", "acct:app:x", ACCOUNT)
      .catch((e: unknown) => e);
    expect((err as { status: number }).status).toBe(403);
  });
});

describe("services", () => {
  it("reads live configuration from the latest deployment in one batch", async () => {
    routes["GET /v1/services"] = { services: [SERVICE], has_next: false };
    routes["GET /v1/apps"] = { apps: [APP], has_next: false };
    routes["GET /v1/deployments"] = { deployments: [DEP], has_next: false };
    const [s] = await client().listResources("service", ACCOUNT);
    expect(calls.find((c) => c.path === "/v1/deployments")!.query.getAll("ids")).toEqual(["dep2"]);
    expect(s!.parentResourceId).toBe("acct:app:app1");
    expect(s!.fields).toMatchObject({
      region: "fra",
      instanceType: "small",
      minScale: 1,
      maxScale: 3,
      runCommand: "npm start",
      envCount: 1,
    });
    expect(s!.resolvedOutputs).toMatchObject({
      url: "https://shop-acme.koyeb.app",
      privateHost: "api.shop.internal",
    });
  });

  it("edits only the changed parts of the definition", () => {
    const next = applyServiceEdits(DEP.definition, {
      maxScale: "5",
      instanceType: "medium",
      branch: "",
    });
    expect(next?.scalings).toEqual([{ min: 1, max: 5 }]);
    expect(next?.instance_types).toEqual([{ type: "medium" }]);
    expect(next?.git?.branch).toBe("main");
    expect(applyServiceEdits(DEP.definition, {})).toBeNull();
    expect(() => applyServiceEdits(DEP.definition, { minScale: "9" })).toThrow(/at least/);
  });

  it("pins a rollback to the commit the deployment built", () => {
    expect(pinDefinition(DEP as never).git?.sha).toBe("abcdef1234");
  });

  it("builds web, git and database definitions", () => {
    const web = buildDefinition({
      name: "api",
      type: "WEB",
      source: "docker",
      image: "nginx",
      region: "was",
      instanceType: "nano",
      port: "80",
    });
    expect(web).toMatchObject({
      regions: ["was"],
      ports: [{ port: 80 }],
      routes: [{ path: "/" }],
      docker: { image: "nginx" },
    });
    const git = buildDefinition({
      name: "w",
      type: "WORKER",
      source: "git",
      repository: "acme/jobs",
      region: "fra",
    });
    expect(git.git?.repository).toBe("github.com/acme/jobs");
    expect(git.ports).toBeUndefined();
    const db = buildDefinition({ name: "db", type: "DATABASE", dbRegion: "fra", pgVersion: "16" });
    expect(db.database?.neon_postgres).toMatchObject({
      pg_version: 16,
      instance_type: "free",
      roles: [{ name: "koyeb-adm" }],
    });
  });

  it("assembles a database URL", () => {
    expect(
      connectionUrl(
        {
          id: "d",
          database_info: { neon_postgres: { server_host: "ep-x.koyeb.app", server_port: 5432 } },
          definition: { database: { neon_postgres: { databases: [{ name: "app" }] } } },
        },
        { name: "koyeb-adm", password: "p@ss" },
      ),
    ).toBe("postgres://koyeb-adm:p%40ss@ep-x.koyeb.app:5432/app?sslmode=require");
  });

  it("scales through the scale endpoint", async () => {
    routes["PUT /v1/services/svc1/scale"] = {};
    await client().executeNoSqlCommand("service", "acct:service:svc1", ACCOUNT, "scale", [
      JSON.stringify({ instances: "2" }),
    ]);
    expect(calls[0]!.body).toEqual({ scalings: [{ instances: 2 }] });
  });
});

describe("costs, quotas and metrics", () => {
  it("turns the open invoice into period rows with a discount credit", () => {
    const rows = invoiceRows(
      {
        stripe_invoice: { subtotal_excluding_tax: 3000, total_excluding_tax: 2500 },
        lines: [
          {
            plan_nickname: "Pro",
            amount_excluding_tax: 2900,
            period: { start: "2026-10-01T00:00:00Z" },
          },
          {
            plan_nickname: "Small instance",
            amount_excluding_tax: 100,
            quantity: 3600,
            period: { start: "2026-10-01T00:00:00Z" },
          },
          {
            plan_nickname: "Nano instance",
            amount_excluding_tax: 0,
            period: { start: "2026-10-01T00:00:00Z" },
          },
        ],
      },
      { fromDate: "2026-10-01", toDate: "2026-10-06" },
    );
    expect(rows.map((r) => [r.service, r.amount, r.chargeType])).toEqual([
      ["Pro plan", 29, "other"],
      ["Small instance", 1, "usage"],
      ["Discounts", -5, "credit"],
    ]);
  });

  it("reports quota pairs and skips unlimited ones", () => {
    const q = quotasFrom({
      apps_used: 2,
      apps_limit: 10,
      services_used: "3" as unknown as number,
      services_limit: "0" as unknown as number,
      persistent_volumes_by_region: [
        { region: "fra", total_size_gb_used: 5, total_size_gb_limit: 100 },
      ],
    });
    expect(q.map((x) => [x.id, x.used, x.limit])).toEqual([
      ["apps", 2, 10],
      ["volumes/fra", 5, 100],
    ]);
  });

  it("averages or sums per-instance metric samples", () => {
    const raw = {
      metrics: [
        { samples: [{ timestamp: "2026-10-06T00:00:00Z", value: 10 }] },
        { samples: [{ timestamp: "2026-10-06T00:00:00Z", value: 30 }] },
      ],
    };
    expect(combine(raw, false)[0]!.value).toBe(20);
    expect(combine(raw, true)[0]!.value).toBe(40);
  });

  it("parses memory strings", () => {
    expect(memoryMb("512MB")).toBe(512);
    expect(memoryMb("2GB")).toBe(2048);
  });
});

describe("status feed", () => {
  const rss = (desc: string) =>
    `<rss><channel><item><title>Low availability</title><description>${desc}</description><pubDate>Tue, 06 Oct 2026 09:00:00 +0000</pubDate><link>https://status.koyeb.com/incident/x</link><guid>https://status.koyeb.com/incident/x</guid></item></channel></rss>`;

  it("maps region components, including Washington's comma, and takes the newest update", () => {
    const [inc] = parseStatusFeed(
      rss(
        "Type: Incident Affected Components: Washington, D.C. - WAS, Europe Oct 6, 09:30:00 GMT+0 - Monitoring - Recovering. Oct 6, 09:00:00 GMT+0 - Identified - Capacity issue.",
      ),
      Date.parse("2026-10-06T10:00:00Z"),
    );
    expect(inc!.state).toBe("monitoring");
    expect(inc!.regions.sort()).toEqual(["fra", "par", "was"]);
    expect(inc!.services).toContain("Washington D.C. - WAS");
    expect(inc!.providerWide).toBeUndefined();
  });

  it("escalates API incidents to provider-wide", () => {
    const [inc] = parseStatusFeed(
      rss(
        "Type: Incident Affected Components: API Oct 6, 09:00:00 GMT+0 - Investigating - Errors.",
      ),
      Date.parse("2026-10-06T10:00:00Z"),
    );
    expect(inc!.providerWide).toBe(true);
    expect(inc!.impact).toBe("major");
  });
});

describe("terraform", () => {
  it("writes simple secrets with a sensitive variable", () => {
    const out = koyebTerraformExport.mapResource({
      id: "acct:secret:s1",
      pluginId: "koyeb",
      resourceTypeId: "secret",
      accountId: ACCOUNT,
      displayName: "DB_PASS",
      fields: { name: "DB_PASS", type: "SIMPLE" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "s1",
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.attributes["value"]).toEqual({
      kind: "ref",
      expr: "var.koyeb_secret_db_pass",
    });
    expect(out?.variables?.[0]?.sensitive).toBe(true);
  });
});

describe("lists", () => {
  const full = (from: number) =>
    Array.from({ length: 100 }, (_, i) => ({ ...APP, id: `a${from + i}` }));

  it("throws at the page cap instead of returning part of the list", async () => {
    routes["GET /v1/apps"] = (c: Call) => ({
      apps: full(Number(c.query.get("offset"))),
      has_next: true,
    });
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(1000);
  });

  it("reads a list far past the old cap of 3,000 rows", async () => {
    routes["GET /v1/apps"] = (c: Call) => {
      const offset = Number(c.query.get("offset"));
      return { apps: full(offset), has_next: offset < 4900 };
    };
    await expect(client().listResources("app", ACCOUNT)).resolves.toHaveLength(5000);
  });

  it("rejects a renamed key on the first page", async () => {
    routes["GET /v1/apps"] = { applications: [APP], has_next: false };
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("rejects a renamed key on a later page", async () => {
    routes["GET /v1/apps"] = (c: Call) =>
      c.query.get("offset") === "0"
        ? { apps: full(0), has_next: true }
        : { applications: [APP], has_next: false };
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("rejects a list that is not an array, an empty body and an error wrapped in a 200", async () => {
    routes["GET /v1/apps"] = { apps: "none" };
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("is not a list");
    routes["GET /v1/apps"] = () => new Response("", { status: 200 });
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("is not a list");
    routes["GET /v1/apps"] = { status: 500, code: "internal", message: "try again" };
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("rejects a missing list on a page that says it has rows", async () => {
    routes["GET /v1/apps"] = { count: "5", limit: "100", offset: "0" };
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("is not a list");
    routes["GET /v1/apps"] = { limit: "100", offset: "0", has_next: true };
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads the empty answers a gRPC gateway can give as no rows", async () => {
    for (const empty of [
      { apps: [], count: "0", has_next: false },
      { apps: null },
      { count: 0, limit: "100", offset: "0", has_next: false },
      {},
    ]) {
      routes["GET /v1/apps"] = empty;
      await expect(client().listResources("app", ACCOUNT)).resolves.toEqual([]);
    }
  });

  it("ends a full last page on a next page with the list left out", async () => {
    routes["GET /v1/projects"] = (c: Call) =>
      c.query.get("offset") === "0"
        ? { projects: Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `p${i}` })) }
        : { limit: "100", offset: "100" };
    await expect(client().listResources("project", ACCOUNT)).resolves.toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it("rejects an empty page that says there is more", async () => {
    routes["GET /v1/apps"] = { apps: [], has_next: true };
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("that says there is more");
  });

  it("skips nothing when the server answers fewer rows than asked for", async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({ ...APP, id: `a${i}` }));
    routes["GET /v1/apps"] = (c: Call) => {
      const offset = Number(c.query.get("offset"));
      return { apps: all.slice(offset, offset + 50), count: "120" };
    };
    const apps = await client().listResources("app", ACCOUNT);
    expect(apps.map((a) => a.externalId)).toEqual(all.map((a) => a.id));
  });

  it("does not hide a bad apps list behind the domain list's catch", async () => {
    routes["GET /v1/domains"] = {
      domains: [{ id: "d1", name: "shop.example.com", app_id: "app1" }],
      count: "1",
    };
    routes["GET /v1/apps"] = { applications: [APP] };
    await expect(client().listResources("domain", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("still lists domains when the apps read merely fails", async () => {
    routes["GET /v1/domains"] = {
      domains: [{ id: "d1", name: "shop.example.com", app_id: "app1" }],
      count: "1",
    };
    routes["GET /v1/apps"] = () => new Response("{}", { status: 500 });
    await expect(client().listResources("domain", ACCOUNT)).resolves.toHaveLength(1);
  });
});

describe("deployments", () => {
  it("reads the newest few of each service", async () => {
    routes["GET /v1/services"] = { services: [SERVICE], has_next: false };
    routes["GET /v1/deployments"] = { deployments: [DEP], has_next: true };
    await expect(client().listResources("deployment", ACCOUNT)).resolves.toHaveLength(1);
    const read = calls.find((c) => c.path === "/v1/deployments")!;
    expect(read.query.get("service_id")).toBe("svc1");
    expect(read.query.get("limit")).toBe("10");
  });

  it("rejects a page that is not a list, rather than reading the service as having none", async () => {
    routes["GET /v1/services"] = { services: [SERVICE], has_next: false };
    routes["GET /v1/deployments"] = { items: [DEP] };
    await expect(client().listResources("deployment", ACCOUNT)).rejects.toThrow("is not a list");
    routes["GET /v1/deployments"] = () => new Response("", { status: 200 });
    await expect(client().listResources("deployment", ACCOUNT)).rejects.toThrow("is not a list");
  });
});
