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
  const c = new HoneycombClient(creds, { http, secrets } as unknown as HostServices);
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
    expect(() => new HoneycombClient({})).toThrow(/configuration key/);
    expect(() => new HoneycombClient({ managementKeyId: "id" })).toThrow(
      /both its ID and its secret/,
    );
    expect(() => new HoneycombClient({ managementKeyId: "id:secret" })).not.toThrow();
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
        { details: { pagerduty_integration_key: "old" } },
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
