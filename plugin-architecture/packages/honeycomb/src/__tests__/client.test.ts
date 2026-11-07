import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { HoneycombApiError } from "../api.js";
import {
  HoneycombClient,
  builderSpec,
  filterValue,
  recipientBody,
  triggerBody,
} from "../client.js";
import { describeQuery, mapSlo } from "../mappers.js";
import { columnRef } from "../metrics.js";
import { clampQueryRange, granularityFor, respec, resultSeries } from "../query.js";
import { resolveRegion } from "../regions.js";
import { EnvironmentResourceType } from "../resource-types.js";
import { mapComponent, parseStatusFeed } from "../status-feed.js";
import { honeycombTerraformExport } from "../terraform.js";
import { makeHttp, memorySecrets } from "./helpers.js";
import type { Reply } from "./helpers.js";

const ACCOUNT = "acc";

function client(
  route: Parameters<typeof makeHttp>[0],
  creds: Record<string, string> = { configurationKey: "cfg" },
  secrets = memorySecrets(),
) {
  const { http, calls } = makeHttp(route);
  const c = hostClient(new HoneycombClient(creds, { http, secrets } as unknown as HostServices));
  return { c, calls, secrets };
}

const AUTH_V1 = {
  id: "k1",
  type: "configuration",
  api_key_access: { columns: true, queries: true },
  environment: { name: "Production", slug: "production" },
  team: { name: "Acme", slug: "acme" },
};

const AUTH_V2 = {
  data: {
    id: "hcxmk_1",
    type: "api-keys",
    attributes: { name: "iw", key_type: "management", scopes: ["environments:read"] },
    relationships: { team: { data: { id: "t1", type: "teams" } } },
  },
  included: [{ id: "t1", type: "teams", attributes: { name: "Acme", slug: "acme" } }],
};

describe("regions", () => {
  it("resolves ids, labels and hosts", () => {
    expect(resolveRegion("").apiUrl).toBe("https://api.honeycomb.io");
    expect(resolveRegion("eu1").apiUrl).toBe("https://api.eu1.honeycomb.io");
    expect(resolveRegion("EU").id).toBe("eu1");
    expect(resolveRegion("https://ui.eu1.honeycomb.io/acme").id).toBe("eu1");
    expect(() => resolveRegion("mars")).toThrow(/unknown region/);
  });
});

describe("HoneycombClient construction", () => {
  it("needs at least one key and both halves of a management key", () => {
    expect(() => hostClient(new HoneycombClient({}))).toThrow(/configuration key/);
    expect(() => hostClient(new HoneycombClient({ managementKeyId: "id" }))).toThrow(
      /both its ID and its secret/,
    );
    expect(() => hostClient(new HoneycombClient({ managementKeyId: "id:secret" }))).not.toThrow();
  });
});

describe("listing", () => {
  it("lists one environment from a configuration key alone, with the key header", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname === "/1/auth") return { body: AUTH_V1 };
      return { status: 404, body: { error: "nope" } };
    });
    const envs = await c.listResources("environment", ACCOUNT);
    expect(envs).toHaveLength(1);
    expect(envs[0]?.externalId).toBe("production");
    expect(envs[0]?.fields["connected"]).toBe(true);
    expect(envs[0]?.resolvedOutputs["url"]).toBe(
      "https://ui.honeycomb.io/acme/environments/production",
    );
    expect(calls[0]?.headers["X-Honeycomb-Team"]).toBe("cfg");
  });

  it("pages v2 environments with the bearer token and uses stored keys", async () => {
    const secrets = memorySecrets({ "acc:environment:staging#configurationKey": "stored" });
    const { c, calls } = client(
      (url) => {
        if (url.pathname === "/2/auth") return { body: AUTH_V2 };
        if (url.pathname === "/2/teams/acme/environments") {
          if (!url.searchParams.get("page[after]")) {
            return {
              body: {
                data: [
                  {
                    id: "hcaen_1",
                    attributes: { name: "Staging", slug: "staging", color: "blue" },
                  },
                ],
                links: {
                  next: "/2/teams/acme/environments?page%5Bafter%5D=abc&page%5Bsize%5D=100",
                },
              },
            };
          }
          return {
            body: {
              data: [
                {
                  id: "hcaen_2",
                  attributes: { name: "Dev", slug: "dev", settings: { delete_protected: true } },
                },
              ],
              links: { next: null },
            },
          };
        }
        return { status: 404 };
      },
      { managementKeyId: "hcxmk_1", managementKeySecret: "s3cret" },
      secrets,
    );
    const envs = await c.listResources("environment", ACCOUNT);
    expect(envs.map((e) => [e.externalId, e.fields["connected"]])).toEqual([
      ["staging", true],
      ["dev", false],
    ]);
    expect(envs[1]?.fields["deleteProtected"]).toBe(true);
    const v2 = calls.find((x) => x.url.pathname === "/2/auth");
    expect(v2?.headers["Authorization"]).toBe("Bearer hcxmk_1:s3cret");
    expect(v2?.headers["Content-Type"]).toBe("application/vnd.api+json");
  });

  it("lists datasets with their definitions as fields", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/1/auth") return { body: AUTH_V1 };
      if (url.pathname === "/1/datasets") {
        return {
          body: [
            {
              name: "API",
              slug: "api",
              expand_json_depth: 2,
              last_written_at: "2026-10-01T00:00:00Z",
            },
          ],
        };
      }
      if (url.pathname === "/1/dataset_definitions/api") {
        return {
          body: { duration_ms: { name: "duration_ms" }, error: { name: "error" }, trace_id: null },
        };
      }
      return { status: 404 };
    });
    const [d] = await c.listResources("dataset", ACCOUNT);
    expect(d?.externalId).toBe("production/api");
    expect(d?.fields["def_duration_ms"]).toBe("duration_ms");
    expect(d?.fields["expandJsonDepth"]).toBe(2);
    expect(d?.parentResourceId).toBe("acc:environment:production");
  });

  it("dedupes environment-wide listings and lists a 403 type empty", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/1/auth") return { body: AUTH_V1 };
      if (url.pathname === "/1/datasets") return { body: [{ name: "API", slug: "api" }] };
      if (url.pathname.startsWith("/1/triggers/")) {
        return {
          body: [
            { id: "t1", name: "Errors", dataset_slug: "api", threshold: { op: ">", value: 5 } },
          ],
        };
      }
      if (url.pathname.startsWith("/1/boards"))
        return { status: 403, body: { error: "forbidden" } };
      return { status: 404 };
    });
    const triggers = await c.listResources("trigger", ACCOUNT);
    expect(triggers.map((t) => t.externalId)).toEqual(["production/api/t1"]);
    expect(triggers[0]?.parentResourceId).toBe("acc:environment:production");
    expect(await c.listResources("board", ACCOUNT)).toEqual([]);
  });
});

describe("errors", () => {
  it("carries the HTTP status and Honeycomb's own message", async () => {
    const { c } = client((url): Reply => {
      if (url.pathname === "/1/auth") return { body: AUTH_V1 };
      return { status: 422, body: { error: "expression is invalid" } };
    });
    const err = await c
      .getResource("derived-column", "acc:derived-column:production/api/x", ACCOUNT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoneycombApiError);
    expect((err as HoneycombApiError).status).toBe(422);
    expect((err as Error).message).toContain("expression is invalid");
  });
});

describe("writes", () => {
  it("disables a trigger by PUTting it back with only the query id", async () => {
    const { c, calls } = client((url, method) => {
      if (url.pathname === "/1/auth") return { body: AUTH_V1 };
      if (url.pathname === "/1/triggers/api/t1") {
        if (method === "GET") {
          return {
            body: {
              id: "t1",
              name: "Errors",
              dataset_slug: "api",
              triggered: true,
              query_id: "q1",
              query: { id: "q1", calculations: [{ op: "COUNT" }] },
              recipients: [{ id: "r1", type: "email", target: "a@b.c" }],
              threshold: { op: ">", value: 5 },
            },
          };
        }
        return { body: { id: "t1", name: "Errors", disabled: true } };
      }
      return { status: 404 };
    });
    await c.invokeAction("trigger", "acc:trigger:production/api/t1", "disable", ACCOUNT);
    const put = calls.find((x) => x.method === "PUT");
    expect(put?.body).toMatchObject({ disabled: true, query_id: "q1", recipients: [{ id: "r1" }] });
    expect(put?.body).not.toHaveProperty("query");
    expect(put?.body).not.toHaveProperty("triggered");
  });

  it("connects an environment by minting a configuration key and storing it", async () => {
    const secrets = memorySecrets();
    const { c, calls } = client(
      (url, method) => {
        if (url.pathname === "/2/auth") return { body: AUTH_V2 };
        if (url.pathname === "/2/teams/acme/environments") {
          return {
            body: {
              data: [{ id: "hcaen_1", attributes: { name: "Staging", slug: "staging" } }],
              links: { next: null },
            },
          };
        }
        if (url.pathname === "/2/teams/acme/api-keys" && method === "POST") {
          return {
            status: 201,
            body: { data: { id: "hcxik_new", attributes: { secret: "minted" } } },
          };
        }
        return { status: 404 };
      },
      { managementKeyId: "hcxmk_1", managementKeySecret: "s" },
      secrets,
    );
    await c.invokeAction("environment", "acc:environment:staging", "connect", ACCOUNT);
    expect(secrets.store.get("acc:environment:staging#configurationKey")).toBe("minted");
    const post = calls.find((x) => x.method === "POST");
    expect(post?.body).toMatchObject({
      data: {
        type: "api-keys",
        attributes: { key_type: "configuration" },
        relationships: { environment: { data: { id: "hcaen_1" } } },
      },
    });
  });
});

describe("query helpers", () => {
  it("builds a trigger query from the simple builder", () => {
    expect(
      builderSpec(
        {
          calcOp: "P99",
          calcColumn: "duration_ms",
          filterColumn: "status",
          filterOp: ">=",
          filterValue: "500",
          timeRange: "900",
        },
        { forTrigger: true },
      ),
    ).toEqual({
      calculations: [{ op: "P99", column: "duration_ms" }],
      time_range: 900,
      filters: [{ column: "status", op: ">=", value: 500 }],
    });
    expect(() => builderSpec({ calcOp: "AVG" }, { forTrigger: true })).toThrow(/needs a column/);
    expect(filterValue("in", "a, 2,true")).toEqual(["a", 2, true]);
    expect(filterValue("exists", "x")).toBeUndefined();
  });

  it("re-specs a stored query to an absolute window", () => {
    const r = {
      startMs: Date.parse("2026-10-01T00:00:00Z"),
      endMs: Date.parse("2026-10-02T00:00:00Z"),
    };
    const spec = respec({ id: "q", time_range: 7200, calculations: [{ op: "COUNT" }] }, r);
    expect(spec).not.toHaveProperty("id");
    expect(spec).not.toHaveProperty("time_range");
    expect(spec.end_time! - spec.start_time!).toBe(86400);
    expect(granularityFor(r)).toBe(720);
  });

  it("clamps to the 7 days the API can read", () => {
    const now = Date.parse("2026-10-07T00:00:00Z");
    const r = clampQueryRange({ startMs: now - 30 * 86400_000, endMs: now }, now);
    expect(now - r.startMs).toBeLessThanOrEqual(7 * 86400_000);
  });

  it("turns result series into chart series, per breakdown group", () => {
    const series = resultSeries(
      {
        complete: true,
        data: {
          series: [
            { time: "2026-10-01T00:00:00Z", data: { COUNT: 3, service: "a" } },
            { time: "2026-10-01T00:00:00Z", data: { COUNT: 9, service: "b" } },
            { time: "2026-10-01T00:01:00Z", data: { COUNT: 4, service: "a" } },
          ],
        },
      },
      [{ key: "COUNT", label: "COUNT" }],
      ["service"],
    );
    expect(series.map((s) => [s.label, s.points.length])).toEqual([
      ["COUNT (b)", 1],
      ["COUNT (a)", 2],
    ]);
  });

  it("quotes awkward column names in calculated fields", () => {
    expect(columnRef("error")).toBe("$error");
    expect(columnRef("http.status_code")).toBe("$http.status_code");
    expect(columnRef("my col")).toBe('$"my col"');
  });

  it("describes queries for display", () => {
    expect(
      describeQuery({
        calculations: [{ op: "COUNT" }],
        filters: [{ column: "error", op: "exists" }],
        breakdowns: ["service.name"],
        time_range: 900,
      }),
    ).toBe("COUNT WHERE error exists GROUP BY service.name over 15m");
  });
});

describe("mappers and bodies", () => {
  it("files multi-dataset SLOs under __all__ and converts the target", () => {
    const slo = mapSlo(ACCOUNT, { slug: "production", region: "us1" }, "api", {
      id: "s1",
      name: "Avail",
      sli: { alias: "sli" },
      time_period_days: 30,
      target_per_million: 999000,
      dataset_slugs: ["a", "b"],
    });
    expect(slo.externalId).toBe("production/__all__/s1");
    expect(slo.fields["targetPercent"]).toBe(99.9);
  });

  it("strips read-only trigger fields", () => {
    const body = triggerBody({
      id: "t",
      dataset_slug: "api",
      triggered: false,
      created_at: "x",
      name: "n",
      query: { id: "q", calculations: [{ op: "COUNT" }] },
    });
    expect(body).toEqual({
      name: "n",
      query: { calculations: [{ op: "COUNT" }] },
      recipients: [],
      tags: [],
    });
  });

  it("builds recipient bodies per type and keeps PagerDuty keys on edit", () => {
    expect(recipientBody("email", { target: "a@b.c" })).toEqual({
      type: "email",
      details: { email_address: "a@b.c" },
    });
    expect(
      recipientBody(
        "pagerduty",
        { target: "Ops" },
        {
          type: "pagerduty",
          details: { pagerduty_integration_name: "Old", pagerduty_integration_key: "old" },
        },
      ),
    ).toEqual({
      type: "pagerduty",
      details: { pagerduty_integration_name: "Ops", pagerduty_integration_key: "old" },
    });
    expect(() => recipientBody("pagerduty", { target: "Ops" })).toThrow(/integration key/);
  });
});

describe("status feed", () => {
  it("maps region-scoped components", () => {
    expect(mapComponent("ui.eu1.honeycomb.io - EU1 Querying")).toEqual({
      regions: ["eu1"],
      services: ["Querying"],
    });
    expect(mapComponent("www.honeycomb.io")).toBeNull();
    const incidents = parseStatusFeed(
      JSON.stringify({
        incidents: [
          {
            id: "i1",
            name: "Slow queries",
            status: "investigating",
            impact: "minor",
            created_at: "2026-10-01T00:00:00Z",
            components: [{ name: "ui.honeycomb.io - US1 Querying" }],
          },
        ],
      }),
    );
    expect(incidents[0]?.regions).toEqual(["us1"]);
  });
});

describe("terraform", () => {
  it("maps datasets and derived columns with import ids", () => {
    const base = {
      pluginId: "honeycomb",
      accountId: ACCOUNT,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const ds = honeycombTerraformExport.mapResource({
      ...base,
      id: "acc:dataset:production/api",
      resourceTypeId: "dataset",
      displayName: "API",
      externalId: "production/api",
      fields: { name: "API", description: "d", expandJsonDepth: 2 },
    });
    expect(ds?.resource.type).toBe("honeycombio_dataset");
    expect(ds?.resource.importId).toBe("api");
    const dc = honeycombTerraformExport.mapResource({
      ...base,
      id: "acc:derived-column:production/__all__/x",
      resourceTypeId: "derived-column",
      displayName: "ok",
      externalId: "production/__all__/x",
      fields: { alias: "ok", expression: "1", dataset: "" },
    });
    expect(dc?.resource.importId).toBe("ok");
    expect(dc?.resource.attributes).not.toHaveProperty("dataset");
  });
});

const API_HOST = "api.honeycomb.io";

function pathsCalled(calls: Array<{ url: URL }>, path: string) {
  return calls.filter((x) => x.url.pathname === path);
}

/** One SLO on one dataset, with `alerts` as its burn alert list. */
function burnAlertRoutes(alerts: unknown, detail: (id: string) => Reply) {
  return (url: URL): Reply => {
    if (url.pathname === "/1/auth") return { body: AUTH_V1 };
    if (url.pathname === "/1/datasets") return { body: [{ name: "API", slug: "api" }] };
    if (url.pathname === "/1/slos/api") {
      return { body: [{ id: "s1", name: "Avail", sli: { alias: "sli" } }] };
    }
    if (url.pathname === "/1/slos/__all__") return { body: [] };
    if (url.pathname === "/1/burn_alerts/api") return { body: alerts };
    const single = /^\/1\/burn_alerts\/api\/(.+)$/.exec(url.pathname);
    if (single?.[1]) return detail(single[1]);
    return { status: 404 };
  };
}

const LISTED_ALERT = {
  id: "b1",
  alert_type: "exhaustion_time",
  exhaustion_minutes: 60,
  slo: { id: "s1" },
};

describe("burn alert recipients", () => {
  it("reads an alert alone for the recipients its list row leaves out", async () => {
    const { c } = client(
      burnAlertRoutes([LISTED_ALERT], () => ({
        body: { ...LISTED_ALERT, recipients: [{ id: "r1", type: "email", target: "a@b.c" }] },
      })),
    );
    const [alert] = await c.listResources("burn-alert", ACCOUNT);
    expect(alert?.fields["recipientIds"]).toBe("r1");
    expect(alert?.fields["recipients"]).toBe("email: a@b.c");
  });

  it("does not take an empty list on a row for an answer, since an alert must have one", async () => {
    const { c } = client(
      burnAlertRoutes([{ ...LISTED_ALERT, recipients: [] }], () => ({
        body: { ...LISTED_ALERT, recipients: [{ id: "r3" }] },
      })),
    );
    const [alert] = await c.listResources("burn-alert", ACCOUNT);
    expect(alert?.fields["recipientIds"]).toBe("r3");
  });

  it("makes no extra read when the list row already has them", async () => {
    const { c, calls } = client(
      burnAlertRoutes([{ ...LISTED_ALERT, recipients: [{ id: "r2" }] }], () => {
        throw new Error("no single read expected");
      }),
    );
    const [alert] = await c.listResources("burn-alert", ACCOUNT);
    expect(alert?.fields["recipientIds"]).toBe("r2");
    expect(pathsCalled(calls, "/1/burn_alerts/api/b1")).toHaveLength(0);
  });

  it("fails the list when the single read fails for a reason that says nothing", async () => {
    const { c } = client(
      burnAlertRoutes([LISTED_ALERT], () => ({ status: 500, body: { error: "boom" } })),
    );
    await expect(c.listResources("burn-alert", ACCOUNT)).rejects.toThrow(/boom/);
  });

  it("keeps the listed alert when its single read is refused or gone", async () => {
    const { c } = client(burnAlertRoutes([LISTED_ALERT], () => ({ status: 404 })));
    const alerts = await c.listResources("burn-alert", ACCOUNT);
    expect(alerts.map((a) => a.externalId)).toEqual(["production/api/b1"]);
  });
});

describe("renaming an environment", () => {
  const routes = (url: URL, method: string): Reply => {
    if (url.pathname === "/2/auth") return { body: AUTH_V2 };
    if (url.pathname === "/2/teams/acme/environments" && method === "GET") {
      return {
        body: {
          data: [{ id: "hcaen_1", attributes: { name: "Staging", slug: "staging" } }],
          links: { next: null },
        },
      };
    }
    if (url.pathname === "/2/teams/acme/environments/hcaen_1" && method === "PATCH") {
      return { body: { data: { id: "hcaen_1", attributes: { name: "Staging" } } } };
    }
    return { status: 404 };
  };
  const creds = { managementKeyId: "hcxmk_1", managementKeySecret: "s" };

  it("is not offered, since Honeycomb has no rename", () => {
    const name = EnvironmentResourceType.fields.find((x) => x.key === "name");
    expect(name?.editable).toBe(false);
    expect(EnvironmentResourceType.description).not.toMatch(/rename/i);
  });

  it("leaves the name out of the PATCH", async () => {
    const { c, calls } = client(routes, creds);
    await c.updateResource("environment", "acc:environment:staging", ACCOUNT, {
      name: "Staging",
      description: "new",
    });
    const patch = calls.find((x) => x.method === "PATCH");
    expect(patch?.body).toEqual({
      data: { id: "hcaen_1", type: "environments", attributes: { description: "new" } },
    });
  });

  it("refuses a different name rather than appear to save it", async () => {
    const { c, calls } = client(routes, creds);
    await expect(
      c.updateResource("environment", "acc:environment:staging", ACCOUNT, {
        name: "Renamed",
        description: "new",
      }),
    ).rejects.toThrow(/cannot be renamed/);
    expect(calls.find((x) => x.method === "PATCH")).toBeUndefined();
  });
});

describe("paged lists", () => {
  const MGMT = { managementKeyId: "hcxmk_1", managementKeySecret: "s" };
  const ENVS = "/2/teams/acme/environments";
  const KEYS = "/2/teams/acme/api-keys";
  const envRow = { id: "hcaen_1", attributes: { name: "Staging", slug: "staging" } };
  const signalRow = { id: "sig1", name: "Latency" };

  /** Every paged list, with what its answer looks like and where it starts. */
  const LISTS = [
    {
      name: "environments",
      type: "environment",
      path: ENVS,
      creds: MGMT,
      page: (rows: unknown, next: string | null): unknown => ({ data: rows, links: { next } }),
      row: envRow,
      renamed: (rows: unknown): unknown => ({ items: rows, links: { next: null } }),
    },
    {
      name: "API keys",
      type: "api-key",
      path: KEYS,
      creds: MGMT,
      page: (rows: unknown, next: string | null): unknown => ({ data: rows, links: { next } }),
      row: { id: "hcxik_1", attributes: { name: "k" } },
      renamed: (rows: unknown): unknown => ({ items: rows, links: { next: null } }),
    },
    {
      name: "signals",
      type: "signal",
      path: "/1/signals",
      creds: { configurationKey: "cfg" },
      page: (rows: unknown, next: string | null): unknown => ({ signals: rows, links: { next } }),
      row: signalRow,
      renamed: (rows: unknown): unknown => ({ items: rows, links: { next: null } }),
    },
  ];

  function serve(list: (typeof LISTS)[number], answer: (url: URL) => unknown) {
    return (url: URL): Reply => {
      if (url.pathname === "/1/auth") return { body: AUTH_V1 };
      if (url.pathname === "/2/auth") return { body: AUTH_V2 };
      if (url.pathname === list.path) return { body: answer(url) };
      if (url.pathname === ENVS) return { body: { data: [envRow], links: { next: null } } };
      return { status: 404 };
    };
  }

  for (const list of LISTS) {
    it(`${list.name}: reads 10,000 rows and throws rather than stop at the cap`, async () => {
      let n = 0;
      const { c, calls } = client(
        serve(list, () => list.page([list.row], `${list.path}?page[after]=${++n}`)),
        list.creds,
      );
      await expect(c.listResources(list.type, ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(pathsCalled(calls, list.path)).toHaveLength(100);
      expect(
        calls.find((x) => x.url.pathname === list.path)?.url.searchParams.get("page[size]"),
      ).toBe("100");
    });

    it(`${list.name}: rejects a first page whose list is not one`, async () => {
      const { c } = client(
        serve(list, () => list.renamed([list.row])),
        list.creds,
      );
      await expect(c.listResources(list.type, ACCOUNT)).rejects.toThrow("is not a list");
    });

    it(`${list.name}: rejects a later page whose list is not one`, async () => {
      const { c } = client(
        serve(list, (url) =>
          url.searchParams.get("page[after]")
            ? list.renamed([list.row])
            : list.page([list.row], `${list.path}?page[after]=2`),
        ),
        list.creds,
      );
      await expect(c.listResources(list.type, ACCOUNT)).rejects.toThrow("is not a list");
    });

    it(`${list.name}: refuses a next link to another host`, async () => {
      const { c, calls } = client(
        serve(list, () => list.page([list.row], "https://evil.example/steal")),
        list.creds,
      );
      await expect(c.listResources(list.type, ACCOUNT)).rejects.toThrow(
        "Refusing to send the account's credentials there",
      );
      expect(calls.every((x) => x.url.hostname === API_HOST)).toBe(true);
    });

    it(`${list.name}: never joins a link with no leading slash onto the host name`, async () => {
      const { c, calls } = client(
        serve(list, (url) =>
          url.pathname === list.path && url.searchParams.get("page[after]")
            ? list.page([], null)
            : list.page([list.row], ".evil.example/steal?page[after]=2"),
        ),
        list.creds,
      );
      await c.listResources(list.type, ACCOUNT).catch(() => undefined);
      expect(calls.every((x) => x.url.hostname === API_HOST)).toBe(true);
    });

    it(`${list.name}: follows the relative link the document gives`, async () => {
      const { c, calls } = client(
        serve(list, (url) =>
          url.searchParams.get("page[after]")
            ? list.page([list.row], null)
            : list.page([list.row], `${list.path}?page[after]=abc&page[size]=100`),
        ),
        list.creds,
      );
      await c.listResources(list.type, ACCOUNT);
      expect(pathsCalled(calls, list.path)[1]?.url.searchParams.get("page[after]")).toBe("abc");
    });
  }
});

describe("a failed read of what the environments hang off", () => {
  const BOTH = { configurationKey: "cfg", managementKeyId: "hcxmk_1", managementKeySecret: "s" };
  const ENV_LIST = {
    data: [{ id: "hcaen_1", attributes: { name: "Production", slug: "production" } }],
    links: { next: null },
  };
  const boom = { status: 500, body: { error: "boom" } };

  it("fails the list rather than read a broken /1/auth as no environments", async () => {
    const { c } = client((): Reply => boom);
    await expect(c.listResources("environment", ACCOUNT)).rejects.toThrow(/boom/);
    await expect(c.listResources("trigger", ACCOUNT)).rejects.toThrow(/boom/);
  });

  it("fails the list when the account's only key is refused", async () => {
    const { c } = client((): Reply => ({ status: 401, body: { error: "unknown key" } }));
    await expect(c.listResources("environment", ACCOUNT)).rejects.toThrow(/unknown key/);
  });

  it("fails the list rather than drop to one environment on a broken /2/auth", async () => {
    const { c } = client((url): Reply => {
      if (url.pathname === "/1/auth") return { body: AUTH_V1 };
      return boom;
    }, BOTH);
    await expect(c.listResources("environment", ACCOUNT)).rejects.toThrow(/boom/);
  });

  it("fails the list rather than read a broken /1/auth as not connected", async () => {
    const { c } = client((url): Reply => {
      if (url.pathname === "/2/auth") return { body: AUTH_V2 };
      if (url.pathname === "/2/teams/acme/environments") return { body: ENV_LIST };
      return boom;
    }, BOTH);
    await expect(c.listResources("environment", ACCOUNT)).rejects.toThrow(/boom/);
  });

  it("still lists through the management key when only the configuration key is refused", async () => {
    const { c } = client((url): Reply => {
      if (url.pathname === "/1/auth") return { status: 401, body: { error: "unknown key" } };
      if (url.pathname === "/2/auth") return { body: AUTH_V2 };
      if (url.pathname === "/2/teams/acme/environments") return { body: ENV_LIST };
      return { status: 404 };
    }, BOTH);
    const envs = await c.listResources("environment", ACCOUNT);
    expect(envs.map((e) => [e.externalId, e.fields["connected"]])).toEqual([["production", false]]);
  });

  it("does not keep a failure for the life of the client", async () => {
    let up = false;
    const { c } = client((url): Reply => {
      if (!up) return boom;
      if (url.pathname === "/1/auth") return { body: AUTH_V1 };
      return { status: 404 };
    });
    await expect(c.listResources("environment", ACCOUNT)).rejects.toThrow(/boom/);
    up = true;
    expect(await c.listResources("environment", ACCOUNT)).toHaveLength(1);
  });

  it("does not keep a failed team read either", async () => {
    let up = false;
    const { c } = client(
      (url): Reply => {
        if (url.pathname === "/2/auth") return up ? { body: AUTH_V2 } : boom;
        if (url.pathname === "/2/teams/acme/environments") return { body: ENV_LIST };
        return { status: 404 };
      },
      { managementKeyId: "hcxmk_1", managementKeySecret: "s" },
    );
    await expect(c.listResources("environment", ACCOUNT)).rejects.toThrow(/boom/);
    up = true;
    expect(await c.listResources("environment", ACCOUNT)).toHaveLength(1);
  });

  it("fails the list rather than read a broken secret store as no stored key", async () => {
    const secrets = memorySecrets();
    secrets.getPlaintext = async () => {
      throw new Error("secret store down");
    };
    const { c } = client(
      (url): Reply => {
        if (url.pathname === "/1/auth") return { body: AUTH_V1 };
        return { status: 404 };
      },
      { configurationKey: "cfg" },
      secrets,
    );
    await expect(c.listResources("environment", ACCOUNT)).rejects.toThrow(/secret store down/);
  });

  it("does not fail a key it has already created over naming its environment", async () => {
    const { c } = client((url, method): Reply => {
      if (url.pathname === "/2/auth") return { body: AUTH_V2 };
      if (url.pathname === "/2/teams/acme/api-keys" && method === "POST") {
        return {
          status: 201,
          body: {
            data: {
              id: "hcxik_new",
              attributes: { name: "k", key_type: "ingest", secret: "minted" },
              relationships: { environment: { data: { id: "hcaen_1" } } },
            },
          },
        };
      }
      return boom;
    }, BOTH);
    const created = await c.createResource!("api-key", ACCOUNT, {
      name: "k",
      keyType: "ingest",
      environment: "hcaen_1",
    });
    expect(JSON.stringify(created)).toContain("hcxik_new");
  });
});

describe("board views", () => {
  const routes =
    (views: Reply) =>
    (url: URL): Reply => {
      if (url.pathname === "/1/auth") return { body: AUTH_V1 };
      if (url.pathname === "/1/boards") return { body: [{ id: "b1", name: "Ops" }] };
      if (url.pathname === "/1/boards/b1/views") return views;
      return { status: 404 };
    };

  it("fails the list rather than read a failed read as a board with no views", async () => {
    const { c } = client(routes({ status: 500, body: { error: "boom" } }));
    await expect(c.listResources("board-view", ACCOUNT)).rejects.toThrow(/boom/);
  });

  it("lists a board that has gone since as having none", async () => {
    const { c } = client(routes({ status: 404 }));
    expect(await c.listResources("board-view", ACCOUNT)).toEqual([]);
  });

  it("rejects an answer that is not a list", async () => {
    const { c } = client(routes({ body: { views: [] } }));
    await expect(c.listResources("board-view", ACCOUNT)).rejects.toThrow();
  });
});
