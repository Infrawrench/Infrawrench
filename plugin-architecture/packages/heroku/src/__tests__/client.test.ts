import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerokuClient } from "../client.js";
import { invoiceRows, periodDay } from "../cost-data.js";
import { plugin } from "../plugin.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { parseStatusFeed } from "../status-feed.js";
import { herokuTerraformExport } from "../terraform.js";

const ACCOUNT = "acct";

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
type Route = ((c: Call) => unknown) | object;
let routes: Record<string, Route> = {};

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers });
}

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
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const h = routes[`${call.method} ${call.path}`];
      if (!h) return reply({ id: "not_found", message: "Couldn't find that." }, 404);
      const out = typeof h === "function" ? (h as (c: Call) => unknown)(call) : h;
      return out instanceof Response ? out : reply(out);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const APP = {
  id: "a1",
  name: "shop-api",
  region: { id: "r", name: "eu" },
  stack: { id: "s", name: "heroku-24" },
  team: { id: "t1", name: "acme" },
  maintenance: false,
  acm: true,
  web_url: "https://shop-api-0123456789ab.herokuapp.com/",
  slug_size: 52_000_000,
};

function client(creds: Record<string, string> = { apiKey: "HRKU-k" }) {
  return new HerokuClient(creds, RESOURCE_TYPES);
}

describe("transport", () => {
  it("sends the v3 Accept header and follows Next-Range", async () => {
    routes["GET /apps"] = (c) =>
      c.headers["Range"] === "id ..; max=1000;"
        ? reply([APP], 206, { "Next-Range": "]a1..; max=1000;" })
        : reply([{ ...APP, id: "a2", name: "two" }], 200);
    const apps = await client().listResources("app", ACCOUNT);
    expect(apps.map((a) => a.externalId)).toEqual(["a1", "a2"]);
    expect(calls[0]!.headers["Accept"]).toBe("application/vnd.heroku+json; version=3");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer HRKU-k");
    expect(calls[1]!.headers["Range"]).toBe("]a1..; max=1000;");
  });

  it("attaches the HTTP status to errors", async () => {
    routes["GET /apps/nope"] = () =>
      reply({ id: "forbidden", message: "You do not have access" }, 403);
    const err = await client()
      .getResource("app", "acct:app:nope", ACCOUNT)
      .catch((e: unknown) => e);
    expect((err as { status: number }).status).toBe(403);
    expect(String(err)).toContain("You do not have access");
  });

  it("scopes lists to the configured team", async () => {
    routes["GET /teams/acme/apps"] = [APP];
    await client({ apiKey: "k", team: "acme" }).listResources("app", ACCOUNT);
    expect(calls[0]!.path).toBe("/teams/acme/apps");
  });
});

describe("mappers", () => {
  it("maps apps with hostname output and slug size", async () => {
    routes["GET /apps"] = [APP];
    const [a] = await client().listResources("app", ACCOUNT);
    expect(a!.fields).toMatchObject({ region: "eu", team: "acme", acm: true, slugSizeMb: 52 });
    expect(a!.resolvedOutputs["hostname"]).toBe("shop-api-0123456789ab.herokuapp.com");
  });

  it("lists config var keys without values and marks add-on owned vars", async () => {
    routes["GET /apps"] = [APP];
    routes["GET /addons"] = [
      { id: "ad1", name: "postgresql-curly-1", app: { id: "a1" }, config_vars: ["DATABASE_URL"] },
    ];
    routes["GET /apps/a1/config-vars"] = {
      DATABASE_URL: "postgres://secret",
      RAILS_ENV: "production",
    };
    const vars = await client().listResources("config-var", ACCOUNT);
    expect(vars.map((v) => v.externalId)).toEqual(["a1/DATABASE_URL", "a1/RAILS_ENV"]);
    expect(vars[0]!.fields["fromAddon"]).toBe("postgresql-curly-1");
    expect(JSON.stringify(vars)).not.toContain("postgres://secret");
  });

  it("reads releases newest first", async () => {
    routes["GET /apps"] = [APP];
    routes["GET /apps/a1/releases"] = [
      { id: "r9", version: 9, status: "succeeded", current: true },
    ];
    const [r] = await client().listResources("release", ACCOUNT);
    expect(calls.find((c) => c.path.endsWith("/releases"))!.headers["Range"]).toBe(
      "version ..; order=desc, max=10;",
    );
    expect(r!.displayName).toBe("shop-api v9");
  });
});

describe("writes", () => {
  it("scales a formation and rolls back a release", async () => {
    routes["PATCH /apps/a1/formation/web"] = {};
    routes["GET /apps/a1/formation/web"] = {
      id: "f",
      app: { id: "a1" },
      type: "web",
      quantity: 3,
      size: "Standard-1X",
    };
    routes["GET /apps"] = [APP];
    routes["POST /apps/a1/releases"] = {};
    const c = client();
    const fm = await c.updateResource("formation", "acct:formation:a1/web", ACCOUNT, {
      quantity: "3",
      size: "Standard-1X",
    });
    expect(calls[0]!.body).toEqual({ quantity: 3, dyno_size: { name: "Standard-1X" } });
    expect(fm.fields["running"]).toBe(true);
    await c.invokeAction("release", "acct:release:a1/r5", "rollback", ACCOUNT);
    expect(calls.at(-1)!.body).toEqual({ release: "r5" });
  });

  it("deletes a config var by setting it to null", async () => {
    routes["PATCH /apps/a1/config-vars"] = {};
    await client().deleteResource("config-var", "acct:config-var:a1/OLD_KEY", ACCOUNT);
    expect(calls[0]!.body).toEqual({ OLD_KEY: null });
  });

  it("promotes to every app in the next stage", async () => {
    routes["GET /pipelines/p1/pipeline-couplings"] = [
      { id: "c1", app: { id: "stg" }, pipeline: { id: "p1" }, stage: "staging" },
      { id: "c2", app: { id: "prod1" }, pipeline: { id: "p1" }, stage: "production" },
      { id: "c3", app: { id: "prod2" }, pipeline: { id: "p1" }, stage: "production" },
    ];
    routes["POST /pipeline-promotions"] = {};
    await client().executeNoSqlCommand("pipeline", "acct:pipeline:p1", ACCOUNT, "promote", [
      JSON.stringify({ source: "stg" }),
    ]);
    expect(calls.at(-1)!.body).toEqual({
      pipeline: { id: "p1" },
      source: { app: { id: "stg" } },
      targets: [{ app: { id: "prod1" } }, { app: { id: "prod2" } }],
    });
  });
});

describe("logs", () => {
  it("opens a log session and reads its text", async () => {
    routes["POST /apps/a1/log-sessions"] = {
      logplex_url: "https://logs.heroku.com/sessions/x?srv=1",
    };
    routes["GET /sessions/x"] = () =>
      new Response("2026-10-06T00:00:00Z app[web.1]: hi", { status: 200 });
    const res = await client().getLogs("app", "acct:app:a1", ACCOUNT, {
      tailLines: 50,
      container: "Router logs",
    });
    expect(calls[0]!.body).toEqual({
      lines: 50,
      tail: false,
      source: "heroku",
      dyno_name: "router",
    });
    expect(res.text).toBe("2026-10-06T00:00:00Z app[web.1]: hi\n");
  });
});

describe("costs and credits", () => {
  it("converts team invoices from cents and balances them to the total", () => {
    const rows = invoiceRows(
      {
        id: "i",
        period_start: "2026-08-01",
        platform_total: 50000,
        addons_total: 25000,
        database_total: 25000,
        total: 90000,
      },
      { team: "acme" },
    );
    expect(rows.map((r) => [r.service, r.amount, r.chargeType])).toEqual([
      ["Platform", 500, "usage"],
      ["Add-ons", 250, "usage"],
      ["Data", 250, "usage"],
      ["Credits", -100, "credit"],
    ]);
  });

  it("keeps personal invoices in dollars", () => {
    const rows = invoiceRows(
      { id: "i", period_start: "08/01/2026", charges_total: 12.5, total: 12.5 },
      {},
    );
    expect(rows).toEqual([
      {
        date: "2026-08-01",
        service: "Heroku",
        currency: "USD",
        amount: 12.5,
        tags: { billing: "personal" },
        chargeType: "usage",
      },
    ]);
    expect(periodDay("2026-08-01T00:00:00Z")).toBe("2026-08-01");
  });

  it("reports unexpired credits in dollars", async () => {
    routes["GET /account/credits"] = [
      {
        id: "c1",
        title: "Startup",
        amount: 10000,
        balance: 4000,
        expires_at: "2999-01-01T00:00:00Z",
      },
      { id: "c2", title: "Old", amount: 10000, balance: 5000, expires_at: "2001-01-01T00:00:00Z" },
    ];
    const credits = await client().fetchCreditBalance(ACCOUNT);
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ remaining: 40, granted: 100, currency: "USD" });
  });
});

describe("status feed", () => {
  it("maps region tags and skips scheduled maintenance that has not started", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        incidents: [
          {
            id: 7,
            title: "Router errors",
            state: "investigating",
            created_at: "2026-10-06T10:00:00Z",
            full_url: "https://status.heroku.com/incidents/7",
            tags: ["EMEA"],
            systems: [{ name: "Apps", status: "red" }],
            updates: [{ created_at: "2026-10-06T10:05:00Z", contents: "<p>Looking</p>" }],
          },
        ],
        scheduled: [{ id: 8, title: "Maintenance", state: "upcoming", tags: ["NA"] }],
      }),
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ impact: "major", lastUpdateText: "Looking" });
    expect(incidents[0]!.regions).toContain("eu");
    expect(incidents[0]!.resourceTypes).toContain("app");
  });
});

describe("terraform", () => {
  it("maps an app with its team", async () => {
    routes["GET /apps"] = [APP];
    const [a] = await client().listResources("app", ACCOUNT);
    const out = herokuTerraformExport.mapResource(a!);
    expect(out?.resource.type).toBe("heroku_app");
    expect(out?.resource.importId).toBe("shop-api");
    expect(out?.resource.attributes["organization"]).toEqual({
      kind: "block",
      attributes: { name: { kind: "string", value: "acme" } },
    });
  });
});

describe("credential options", () => {
  it("lists teams", async () => {
    routes["GET /teams"] = [{ id: "t1", name: "acme", role: "admin" }];
    expect(await plugin.listCredentialOptions!("team", { apiKey: "k" })).toEqual([
      { id: "t1", label: "acme", description: "Your role: admin" },
    ]);
  });
});
