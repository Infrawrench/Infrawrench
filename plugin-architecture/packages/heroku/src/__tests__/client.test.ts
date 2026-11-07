import { hostClient, hostPlugin } from "@infrawrench/plugin-base/effect";
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
  return hostClient(new HerokuClient(creds, RESOURCE_TYPES));
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
    expect(await hostPlugin(plugin).listCredentialOptions!("team", { apiKey: "k" })).toEqual([
      { id: "t1", label: "acme", description: "Your role: admin" },
    ]);
  });
});

describe("list pages", () => {
  it("reads a list longer than the old 20 page cap to its end", async () => {
    let served = 0;
    routes["GET /apps"] = () => {
      served += 1;
      const row = { ...APP, id: `a${served}`, name: `app-${served}` };
      return served < 30
        ? reply([row], 206, { "Next-Range": `]a${served}..; max=1000;` })
        : reply([row], 200);
    };
    const apps = await client().listResources("app", ACCOUNT);
    expect(apps).toHaveLength(30);
    expect(calls).toHaveLength(30);
  });

  it("throws at the page cap rather than return part of a list", async () => {
    let served = 0;
    routes["GET /apps"] = () => {
      served += 1;
      return reply([{ ...APP, id: `a${served}` }], 206, {
        "Next-Range": `]a${served}..; max=1000;`,
      });
    };
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
  });

  it("throws on a first page that is not a list", async () => {
    routes["GET /apps"] = { apps: [APP] };
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("throws on a later page that is not a list", async () => {
    routes["GET /apps"] = (c) =>
      c.headers["Range"] === "id ..; max=1000;"
        ? reply([APP], 206, { "Next-Range": "]a1..; max=1000;" })
        : reply({ apps: [] });
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("throws on a 2xx with no body rather than read it as no rows", async () => {
    routes["GET /apps"] = () => new Response("", { status: 200 });
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("throws on a 206 with no way to read the rest", async () => {
    routes["GET /apps"] = () => reply([APP], 206);
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("says there is more");
  });

  it("throws on a 206 whose Next-Range repeats the page it answers", async () => {
    routes["GET /apps"] = (c) => reply([APP], 206, { "Next-Range": c.headers["Range"]! });
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow("says there is more");
    expect(calls).toHaveLength(1);
  });

  it("throws on a release window that is not a list", async () => {
    routes["GET /apps"] = [APP];
    routes["GET /apps/a1/releases"] = { releases: [] };
    await expect(client().listResources("release", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("does not follow a release window past its first page", async () => {
    routes["GET /apps"] = [APP];
    routes["GET /apps/a1/releases"] = () =>
      reply([{ id: "r9", version: 9 }], 206, { "Next-Range": "]9..; order=desc, max=10;" });
    const rows = await client().listResources("release", ACCOUNT);
    expect(rows.map((r) => r.fields["version"])).toEqual([9]);
    expect(calls.filter((c) => c.path.endsWith("/releases"))).toHaveLength(1);
  });

  it("fails the cost read rather than bill part of the invoices", async () => {
    routes["GET /teams"] = [];
    let served = 0;
    routes["GET /account/invoices"] = () =>
      reply([], 206, { "Next-Range": `]${(served += 1)}..; max=1000;` });
    await expect(
      client().fetchCostData!(ACCOUNT, { fromDate: "2026-01-01", toDate: "2026-02-01" }),
    ).rejects.toThrow("has more than Infrawrench reads");
  });
});

describe("catches around list reads", () => {
  const endless = (c: Call) => reply([], 206, { "Next-Range": `]${calls.length}${c.path}..;` });

  it("does not read a truncated add-on list as no add-ons for config vars", async () => {
    routes["GET /apps"] = [APP];
    routes["GET /addons"] = endless;
    routes["GET /apps/a1/config-vars"] = { RAILS_ENV: "production" };
    await expect(client().listResources("config-var", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("does not read a truncated app list as no names for couplings", async () => {
    routes["GET /apps"] = endless;
    routes["GET /pipelines"] = [{ id: "p1", name: "shop" }];
    routes["GET /pipelines/p1/pipeline-couplings"] = [];
    await expect(client().listResources("pipeline-coupling", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("does not store a coupling count of nought when the couplings failed to read", async () => {
    routes["GET /pipelines"] = [{ id: "p1", name: "shop" }];
    routes["GET /pipelines/p1/pipeline-couplings"] = () => reply({ id: "unavailable" }, 503);
    await expect(client().listResources("pipeline", ACCOUNT)).rejects.toThrow("503");
  });

  it("keeps the pipeline when its couplings are refused", async () => {
    routes["GET /pipelines"] = [{ id: "p1", name: "shop" }];
    routes["GET /pipelines/p1/pipeline-couplings"] = () => reply({ id: "forbidden" }, 403);
    const rows = await client().listResources("pipeline", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["p1"]);
  });

  it("fails a pipeline read whose couplings are past the cap", async () => {
    routes["GET /pipelines/p1"] = { id: "p1", name: "shop" };
    routes["GET /pipelines/p1/pipeline-couplings"] = endless;
    await expect(client().getResource("pipeline", "acct:pipeline:p1", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });
});

describe("a parent whose children are refused", () => {
  const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
  const unread = vi.fn();
  beforeEach(() => {
    unread.mockReset();
    Reflect.set(globalThis, UNREAD_HOOK, unread);
  });
  afterEach(() => Reflect.deleteProperty(globalThis, UNREAD_HOOK));

  it("names the app, so its stored rows stay, and reads the other apps", async () => {
    routes["GET /apps"] = [APP, { ...APP, id: "a2", name: "two" }];
    routes["GET /apps/a1/domains"] = () => reply({ id: "forbidden" }, 403);
    routes["GET /apps/a2/domains"] = [{ id: "d2", hostname: "two.example", kind: "custom" }];
    const rows = await client().listResources("domain", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["a2/d2"]);
    expect(unread).toHaveBeenCalledTimes(1);
    expect(unread).toHaveBeenCalledWith({ parentResourceIds: ["acct:app:a1"] });
  });

  it("names the pipeline when its review apps are refused", async () => {
    routes["GET /pipelines"] = [{ id: "p1", name: "shop" }];
    routes["GET /pipelines/p1/review-apps"] = () => reply({ id: "forbidden" }, 403);
    expect(await client().listResources("review-app", ACCOUNT)).toEqual([]);
    expect(unread).toHaveBeenCalledWith({ parentResourceIds: ["acct:pipeline:p1"] });
  });

  it("shows the refusal where the host keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    routes["GET /apps"] = [APP, { ...APP, id: "a2", name: "two" }];
    routes["GET /apps/a1/domains"] = () => reply({ id: "forbidden" }, 403);
    routes["GET /apps/a2/domains"] = [{ id: "d2", hostname: "two.example", kind: "custom" }];
    await expect(client().listResources("domain", ACCOUNT)).rejects.toThrow("403");
  });

  it("reads an app that has gone as having no children", async () => {
    routes["GET /apps"] = [APP];
    expect(await client().listResources("domain", ACCOUNT)).toEqual([]);
    expect(unread).not.toHaveBeenCalled();
  });

  it("fails the type on a throttle", async () => {
    routes["GET /apps"] = [APP];
    routes["GET /apps/a1/domains"] = () => reply({ id: "rate_limit" }, 429);
    await expect(client().listResources("domain", ACCOUNT)).rejects.toThrow("429");
    expect(unread).not.toHaveBeenCalled();
  });
});

describe("the request pool", () => {
  const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
  const unread = vi.fn();
  const left = (n: number) => ({ "RateLimit-Remaining": String(n) });
  const appsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...APP, id: `a${i}`, name: `app-${i}` }));
  const domainReads = () => calls.filter((c) => c.path.endsWith("/domains")).map((c) => c.path);
  const named = () => unread.mock.calls.flatMap(([part]) => part.parentResourceIds ?? []);
  function serveDomains(apps: { id: string }[], remaining: number) {
    for (const a of apps) {
      routes[`GET /apps/${a.id}/domains`] = () =>
        reply(
          [{ id: `d-${a.id}`, hostname: `${a.id}.example`, kind: "custom" }],
          200,
          left(remaining),
        );
    }
  }

  beforeEach(() => {
    unread.mockReset();
    Reflect.set(globalThis, UNREAD_HOOK, unread);
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    vi.restoreAllMocks();
  });

  it("reads every app with no note while the pool has room", async () => {
    const apps = appsOf(20);
    routes["GET /apps"] = () => reply(apps, 200, left(4400));
    serveDomains(apps, 4300);
    const rows = await client().listResources("domain", ACCOUNT);
    expect(rows).toHaveLength(20);
    expect(unread).not.toHaveBeenCalled();
  });

  it("reads no children and names every app when the pool is already low", async () => {
    const apps = appsOf(3);
    routes["GET /apps"] = () => reply(apps, 200, left(900));
    serveDomains(apps, 899);
    expect(await client().listResources("domain", ACCOUNT)).toEqual([]);
    expect(domainReads()).toEqual([]);
    expect(named().sort()).toEqual(["acct:app:a0", "acct:app:a1", "acct:app:a2"]);
  });

  it("stops when the pool falls low mid-read, and names exactly what it left", async () => {
    const apps = appsOf(20);
    routes["GET /apps"] = () => reply(apps, 200, left(4400));
    serveDomains(apps, 999);
    const rows = await client().listResources("domain", ACCOUNT);
    // The six workers already in flight finish, and nothing new starts.
    expect(domainReads()).toHaveLength(6);
    expect(rows).toHaveLength(6);
    expect(named()).toHaveLength(14);
    const readIds = rows.map((r) => `acct:app:${r.externalId!.split("/")[0]}`);
    expect([...readIds, ...named()].sort()).toEqual(apps.map((a) => `acct:app:${a.id}`).sort());
  });

  it("moves its start between polls, so every app is reached over time", async () => {
    const apps = appsOf(40);
    routes["GET /apps"] = () => reply(apps, 200, left(4400));
    serveDomains(apps, 999);
    const reached = new Set<string>();
    const now = vi.spyOn(Date, "now");
    for (let poll = 0; poll < 96; poll++) {
      now.mockReturnValue(1_800_000_000_000 + poll * 15 * 60_000);
      calls = [];
      await client().listResources("domain", ACCOUNT);
      for (const path of domainReads()) reached.add(path);
    }
    expect(reached.size).toBe(40);
  });

  it("keeps a pipeline row it does not reach, which has no parent to name", async () => {
    routes["GET /pipelines"] = () => reply([{ id: "p1", name: "shop" }], 200, left(900));
    expect(await client().listResources("pipeline", ACCOUNT)).toEqual([]);
    expect(calls.filter((c) => c.path.includes("couplings"))).toEqual([]);
    expect(unread).toHaveBeenCalledWith({ idPrefixes: ["acct:pipeline:p1"] });
  });

  it("names the pipeline for the children of one it does not reach", async () => {
    routes["GET /pipelines"] = () => reply([{ id: "p1", name: "shop" }], 200, left(900));
    expect(await client().listResources("review-app", ACCOUNT)).toEqual([]);
    expect(named()).toEqual(["acct:pipeline:p1"]);
  });

  it("keeps reading on a host that keeps no track, where a partial list would just look short", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const apps = appsOf(3);
    routes["GET /apps"] = () => reply(apps, 200, left(900));
    serveDomains(apps, 899);
    expect(await client().listResources("domain", ACCOUNT)).toHaveLength(3);
  });

  it("ignores a header it cannot read", async () => {
    const apps = appsOf(2);
    routes["GET /apps"] = () => reply(apps, 200, { "RateLimit-Remaining": "soon" });
    serveDomains(apps, 4000);
    expect(await client().listResources("domain", ACCOUNT)).toHaveLength(2);
  });
});
