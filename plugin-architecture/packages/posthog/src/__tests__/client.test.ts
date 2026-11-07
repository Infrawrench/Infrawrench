import { hostClient, hostPlugin } from "@infrawrench/plugin-base/effect";
import { describe, expect, it, vi } from "vitest";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { resolveHost, statusOf } from "../api.js";
import { PostHogClient, withRollout } from "../client.js";
import { seriesKey } from "../cost-data.js";
import { mapProjectObject } from "../mappers.js";
import { plugin } from "../plugin.js";
import { hogqlString } from "../query.js";
import { parseStatusFeed } from "../status-feed.js";
import { posthogTerraformExport } from "../terraform.js";
import { CREDS, makeHttp, type Recorded } from "./helpers.js";

// These tests read many pages or wait on timers, which runs far slower on CI than locally.
vi.setConfig({ testTimeout: 60_000 });

const PROJECTS = {
  results: [{ id: 7, name: "Web", api_token: "phc_x", timezone: "UTC" }],
  next: null,
};

describe("resolveHost", () => {
  it("maps regions, app links and self-hosted URLs", () => {
    expect(resolveHost("eu", "")).toEqual({ baseUrl: "https://eu.posthog.com", region: "eu" });
    expect(resolveHost("us", "https://app.posthog.com/")).toEqual({
      baseUrl: "https://us.posthog.com",
      region: "us",
    });
    expect(resolveHost("us", "posthog.example.com")).toEqual({
      baseUrl: "https://posthog.example.com",
      region: "self-hosted",
    });
  });
});

describe("PostHogClient", () => {
  it("lists flags in every project with Bearer auth and offset paging", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname === "/api/organizations/org-1/projects/") return { body: PROJECTS };
      if (url.pathname === "/api/projects/7/feature_flags/") {
        const offset = Number(url.searchParams.get("offset"));
        return offset === 0
          ? {
              body: {
                results: [
                  {
                    id: 1,
                    key: "a",
                    active: true,
                    filters: { groups: [{ rollout_percentage: 30 }] },
                  },
                  { id: 2, key: "gone", deleted: true },
                ],
                next: "https://eu.posthog.com/api/projects/7/feature_flags/?offset=200",
              },
            }
          : {
              body: {
                results: [{ id: 3, key: "b", active: false, filters: { groups: [] } }],
                next: null,
              },
            };
      }
      return undefined;
    });
    const flags = await hostClient(new PostHogClient(CREDS, { http })).listResources(
      "feature-flag",
      "acct",
    );
    expect(flags.map((f) => f.externalId)).toEqual(["7/1", "7/3"]);
    expect(flags[0]?.fields["rolloutPercentage"]).toBe(30);
    expect(flags[0]?.parentResourceId).toBe("acct:project:7");
    expect(calls[0]?.url.origin).toBe("https://eu.posthog.com");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer phx_test");
  });

  it("maps DRF errors to a status", async () => {
    const { http } = makeHttp(() => ({
      status: 429,
      body: { type: "throttled_error", detail: "Request was throttled." },
    }));
    const err = await hostClient(new PostHogClient(CREDS, { http }))
      .listResources("project", "acct")
      .catch((e: unknown) => e);
    expect(statusOf(err)).toBe(429);
    expect(String(err)).toContain("throttled");
  });

  it("edits a flag's rollout by rewriting its first release condition", async () => {
    const { http, calls } = makeHttp((url, method) => {
      if (url.pathname === "/api/projects/7/feature_flags/1/" && method === "GET") {
        return {
          body: {
            id: 1,
            key: "a",
            filters: {
              groups: [
                { properties: [{ key: "email" }], rollout_percentage: 10 },
                { rollout_percentage: 5 },
              ],
            },
          },
        };
      }
      if (method === "PATCH") return { body: { id: 1 } };
      return undefined;
    });
    await hostClient(new PostHogClient(CREDS, { http })).updateResource(
      "feature-flag",
      "acct:feature-flag:7/1",
      "acct",
      { rolloutPercentage: "50" },
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({
      filters: {
        groups: [
          { properties: [{ key: "email" }], rollout_percentage: 50 },
          { rollout_percentage: 5 },
        ],
      },
    });
  });

  it("soft-deletes everything but batch exports", async () => {
    const { http, calls } = makeHttp(() => ({ status: 204 }));
    const client = hostClient(new PostHogClient(CREDS, { http }));
    await client.deleteResource("dashboard", "acct:dashboard:7/9");
    await client.deleteResource("batch-export", "acct:batch-export:7/abc");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ deleted: true });
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url.pathname).toBe("/api/projects/7/batch_exports/abc/");
  });

  it("runs HogQL and charts flag evaluations", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname === "/api/projects/7/query/") {
        return { body: { columns: ["t", "c"], results: [["2026-10-06T10:00:00Z", 4]] } };
      }
      if (url.pathname === "/api/projects/7/feature_flags/1/")
        return { body: { id: 1, key: "it's" } };
      return undefined;
    });
    const client = hostClient(new PostHogClient(CREDS, { http }));
    const q = await client.executeQuery("acct:project:7", "acct", "SELECT 1");
    expect(q.rows).toEqual([{ t: "2026-10-06T10:00:00Z", c: 4 }]);
    const series = await client.fetchMetricSeries("feature-flag", "acct:feature-flag:7/1", "acct", {
      startMs: 0,
      endMs: 3600_000,
    });
    expect(series[0]?.points).toEqual([
      { timestamp: Date.parse("2026-10-06T10:00:00Z"), value: 4 },
    ]);
    const body = calls.at(-1)?.body as { query: { query: string } };
    expect(body.query.query).toContain("properties.$feature_flag = 'it\\'s'");
  });

  it("turns spend into daily cost rows by product and project", async () => {
    const { http } = makeHttp((url) => {
      if (url.pathname === "/api/organizations/org-1/projects/") return { body: PROJECTS };
      if (url.pathname === "/api/billing/spend/") {
        expect(url.searchParams.get("breakdowns")).toBe('["type","team"]');
        return {
          body: {
            results: [
              {
                label: "7::Product analytics",
                dates: ["2026-10-01", "2026-10-02"],
                data: [1.5, 0],
                breakdown_type: "multiple",
                breakdown_value: ["product_analytics", "7"],
              },
            ],
            next: null,
          },
        };
      }
      return undefined;
    });
    const rows = await hostClient(new PostHogClient(CREDS, { http })).fetchCostData("acct", {
      fromDate: "2026-10-01",
      toDate: "2026-10-02",
    });
    expect(rows).toEqual([
      {
        date: "2026-10-01",
        service: "Product analytics",
        currency: "USD",
        amount: 1.5,
        resourceId: "7",
        tags: { project: "Web" },
      },
    ]);
  });

  it("lists organizations for the credential picker", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/api/organizations/"
        ? { body: { results: [{ id: "o1", name: "Acme", slug: "acme" }], next: null } }
        : undefined,
    );
    const opts = await hostPlugin(plugin).listCredentialOptions?.(
      "organizationId",
      { region: "us", apiKey: "phx" },
      { http },
    );
    expect(opts).toEqual([{ id: "o1", label: "Acme", description: "acme" }]);
  });
});

describe("reading a whole list", () => {
  const client = (route: Parameters<typeof makeHttp>[0]) => {
    const { http, calls } = makeHttp((url, method, body) =>
      url.pathname === "/api/organizations/org-1/projects/"
        ? { body: PROJECTS }
        : route(url, method, body),
    );
    return { client: hostClient(new PostHogClient(CREDS, { http })), calls };
  };
  const listCalls = (calls: Recorded[], route: string) =>
    calls.filter((c) => c.url.pathname === `/api/projects/7/${route}/`);

  it("walks actions by count, because that route answers no next", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, name: `a${i}` }));
    const { client: c, calls } = client((url) => {
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return url.pathname === "/api/projects/7/actions/"
        ? { body: { count: rows.length, results: rows.slice(offset, offset + limit) } }
        : undefined;
    });
    const actions = await c.listResources("action", "acct");
    expect(actions).toHaveLength(450);
    expect(listCalls(calls, "actions").map((r) => r.url.searchParams.get("offset"))).toEqual([
      "0",
      "200",
      "400",
    ]);
  });

  it("asks for the row after the last one read, where a page is shorter than asked for", async () => {
    const { client: c, calls } = client((url) => {
      const offset = Number(url.searchParams.get("offset"));
      if (url.pathname !== "/api/projects/7/dashboards/") return undefined;
      return offset === 0
        ? { body: { count: 2, results: [{ id: 1 }], next: "https://eu.posthog.com/more" } }
        : { body: { count: 2, results: [{ id: 2 }], next: null } };
    });
    await c.listResources("dashboard", "acct");
    expect(listCalls(calls, "dashboards")[1]?.url.searchParams.get("offset")).toBe("1");
  });

  it("ends on next: null even where count says otherwise", async () => {
    const { client: c, calls } = client((url) =>
      url.pathname === "/api/projects/7/cohorts/"
        ? { body: { count: 5, results: [{ id: 1 }], next: null } }
        : undefined,
    );
    await c.listResources("cohort", "acct");
    expect(listCalls(calls, "cohorts")).toHaveLength(1);
  });

  it("throws at the page cap rather than answer part of the list", async () => {
    const { client: c, calls } = client((url) =>
      url.pathname === "/api/projects/7/feature_flags/"
        ? {
            body: {
              count: 1_000_000,
              results: [{ id: Number(url.searchParams.get("offset")) + 1 }],
              next: "https://eu.posthog.com/api/projects/7/feature_flags/?offset=1",
            },
          }
        : undefined,
    );
    await expect(c.listResources("feature-flag", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(listCalls(calls, "feature_flags")).toHaveLength(250);
  });

  it("reads 50,000 rows before it gives up", async () => {
    const page = Array.from({ length: 200 }, (_, i) => ({ id: i + 1 }));
    const { client: c } = client((url) =>
      url.pathname === "/api/projects/7/insights/"
        ? {
            body: {
              count: 50_000,
              results: page,
              next: Number(url.searchParams.get("offset")) < 49_800 ? "more" : null,
            },
          }
        : undefined,
    );
    await expect(c.listResources("insight", "acct")).resolves.toHaveLength(50_000);
  });

  it("throws on a page whose list is not a list, first or later", async () => {
    const first = client((url) =>
      url.pathname === "/api/projects/7/annotations/" ? { body: { rows: [] } } : undefined,
    );
    await expect(first.client.listResources("annotation", "acct")).rejects.toThrow("is not a list");
    const later = client((url) => {
      if (url.pathname !== "/api/projects/7/annotations/") return undefined;
      return url.searchParams.get("offset") === "0"
        ? { body: { results: [{ id: 1 }], next: "more" } }
        : { body: { rows: [] } };
    });
    await expect(later.client.listResources("annotation", "acct")).rejects.toThrow("is not a list");
  });

  it("throws where a list of projects cannot be read", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/api/organizations/org-1/projects/" ? { body: { rows: [] } } : undefined,
    );
    await expect(
      hostClient(new PostHogClient(CREDS, { http })).listResources("project", "acct"),
    ).rejects.toThrow("is not a list");
  });

  it("never sends a request to the host a next link names", async () => {
    const { client: c, calls } = client((url) => {
      if (url.pathname !== "/api/projects/7/experiments/") return undefined;
      return url.searchParams.get("offset") === "0"
        ? { body: { results: [{ id: 1 }], next: "https://evil.example/steal" } }
        : { body: { results: [], next: null } };
    });
    await c.listResources("experiment", "acct");
    expect(calls.every((r) => r.url.origin === "https://eu.posthog.com")).toBe(true);
  });

  it("still reads a project with no access to a type as having none", async () => {
    const { client: c } = client((url) =>
      url.pathname === "/api/projects/7/hog_functions/"
        ? { status: 403, body: { detail: "scope" } }
        : undefined,
    );
    await expect(c.listResources("hog-function", "acct")).resolves.toEqual([]);
  });
});

describe("reading all of the spend", () => {
  const RANGE = { fromDate: "2026-10-01", toDate: "2026-10-02" };
  const spendClient = (
    spend: (url: URL) => object,
    projects: object = PROJECTS,
  ): { read: () => Promise<unknown>; calls: Recorded[] } => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname === "/api/organizations/org-1/projects/") return { body: projects };
      if (url.pathname === "/api/billing/spend/") return { body: spend(url) };
      return undefined;
    });
    const client = hostClient(new PostHogClient(CREDS, { http }));
    return { read: () => client.fetchCostData("acct", RANGE), calls };
  };
  const spendCalls = (calls: Recorded[]) =>
    calls.filter((c) => c.url.pathname === "/api/billing/spend/");

  it("asks for the largest page the document allows and follows the cursor", async () => {
    const { read, calls } = spendClient((url) =>
      url.searchParams.get("after")
        ? { results: [] }
        : { results: [], next: "https://eu.posthog.com/api/billing/spend/?after=abc" },
    );
    await read();
    expect(spendCalls(calls).map((c) => c.url.searchParams.get("page_size"))).toEqual([
      "1000",
      "1000",
    ]);
    expect(spendCalls(calls)[1]?.url.searchParams.get("after")).toBe("abc");
  });

  it("throws at the page cap rather than answer part of the spend", async () => {
    const { read, calls } = spendClient(() => ({ results: [], next: "more" }));
    await expect(read()).rejects.toThrow("has more than Infrawrench reads");
    expect(spendCalls(calls)).toHaveLength(20);
  });

  it("throws on a page whose list is not a list, first or later", async () => {
    await expect(spendClient(() => ({ rows: [] })).read()).rejects.toThrow("is not a list");
    await expect(
      spendClient((url) =>
        url.searchParams.get("after") ? { rows: [] } : { results: [], next: "more" },
      ).read(),
    ).rejects.toThrow("is not a list");
  });

  it("does not take a project list it could not read as no projects", async () => {
    await expect(spendClient(() => ({ results: [] }), { rows: [] }).read()).rejects.toThrow(
      "is not a list",
    );
  });

  it("still costs an account whose key cannot list projects, by project id", async () => {
    const { http } = makeHttp((url) => {
      if (url.pathname === "/api/organizations/org-1/projects/") {
        return { status: 403, body: { detail: "scope" } };
      }
      if (url.pathname !== "/api/billing/spend/") return undefined;
      return {
        body: {
          results: [
            {
              label: "7::Events",
              dates: ["2026-10-01"],
              data: [2],
              breakdown_value: ["events", "7"],
            },
          ],
        },
      };
    });
    const rows = await hostClient(new PostHogClient(CREDS, { http })).fetchCostData("acct", RANGE);
    expect(rows[0]?.tags).toEqual({ project: "7" });
  });
});

describe("rolling a flag out to everyone", () => {
  const FLAG = "/api/projects/7/feature_flags/1/";
  const ROLL_OUT = `${FLAG}roll_out_to_everyone/`;
  const flagClient = (flag: object) => {
    const { http, calls } = makeHttp((url, method) => {
      if (url.pathname === FLAG && method === "GET") return { body: { id: 1, ...flag } };
      if (url.pathname === ROLL_OUT && method === "POST") return { body: { id: 1 } };
      return undefined;
    });
    return { client: hostClient(new PostHogClient(CREDS, { http })), calls };
  };
  const MULTIVARIATE = {
    version: 3,
    filters: {
      multivariate: {
        variants: [
          { key: "control", rollout_percentage: 50 },
          { key: "test", rollout_percentage: 50 },
        ],
      },
    },
  };
  const invoke = (client: ReturnType<typeof flagClient>["client"], actionId: string) =>
    client.invokeAction?.("feature-flag", "acct:feature-flag:7/1", actionId);
  const rollOuts = (calls: Recorded[]) => calls.filter((c) => c.url.pathname === ROLL_OUT);

  it("sends the version it has just read", async () => {
    const { client, calls } = flagClient({ version: 12, filters: { groups: [] } });
    await invoke(client, "rollout-all");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(rollOuts(calls)[0]?.body).toEqual({ version: 12 });
  });

  it("sends back the null a flag from before versioning reads as", async () => {
    const { client, calls } = flagClient({ version: null });
    await invoke(client, "rollout-all");
    expect(rollOuts(calls)[0]?.body).toEqual({ version: null });
  });

  it("names the variant of a multivariate flag", async () => {
    const { client, calls } = flagClient(MULTIVARIATE);
    await invoke(client, "rollout-all:test");
    expect(rollOuts(calls)[0]?.body).toEqual({ version: 3, variant_key: "test" });
  });

  it("refuses a multivariate flag with no variant, sending nothing", async () => {
    const { client, calls } = flagClient(MULTIVARIATE);
    await expect(invoke(client, "rollout-all")).rejects.toThrow("Pick the variant");
    expect(rollOuts(calls)).toEqual([]);
  });

  it("refuses a variant the flag does not have, sending nothing", async () => {
    const multivariate = flagClient(MULTIVARIATE);
    await expect(invoke(multivariate.client, "rollout-all:gone")).rejects.toThrow("gone");
    expect(rollOuts(multivariate.calls)).toEqual([]);
    const boolean = flagClient({ version: 1, filters: { groups: [] } });
    await expect(invoke(boolean.client, "rollout-all:test")).rejects.toThrow("test");
    expect(rollOuts(boolean.calls)).toEqual([]);
  });

  it("offers one rollout per variant on a multivariate flag, and one on any other", () => {
    const client = new PostHogClient(CREDS, { http: makeHttp(() => undefined).http });
    const scope = { baseUrl: "https://eu.posthog.com", region: "eu" };
    const rollouts = (flag: object) =>
      JSON.stringify(
        client.renderDetail(mapProjectObject("a", "feature-flag", "7", { id: 1, ...flag }, scope)),
      ).match(/rollout-all[^"]*/g);
    expect(rollouts(MULTIVARIATE)).toEqual(["rollout-all:control", "rollout-all:test"]);
    expect(rollouts({ filters: { groups: [] } })).toEqual(["rollout-all"]);
  });
});

describe("writing to a versioned flag", () => {
  const FLAG = "/api/projects/7/feature_flags/1/";
  const flagClient = (flag: object) => {
    const { http, calls } = makeHttp((url, method) => {
      if (url.pathname === FLAG && method === "GET") return { body: { id: 1, ...flag } };
      if (method !== "GET") return { body: { id: 1 } };
      return undefined;
    });
    const writes = () => calls.filter((c) => c.method !== "GET");
    return { client: hostClient(new PostHogClient(CREDS, { http })), calls, writes };
  };
  const RESOURCE = "acct:feature-flag:7/1";

  it("sends the version it has just read when turning a flag on or off", async () => {
    for (const action of ["enable", "disable"]) {
      const { client, writes } = flagClient({ version: 4, filters: { version: 2 } });
      await client.invokeAction?.("feature-flag", RESOURCE, action);
      expect(writes()[0]?.url.pathname).toBe(`${FLAG}${action}/`);
      expect(writes()[0]?.body).toEqual({ version: 4 });
    }
  });

  it("sends the version with an edit, reading the flag once", async () => {
    const { client, calls, writes } = flagClient({ version: 4, filters: { groups: [] } });
    await client.updateResource("feature-flag", RESOURCE, "acct", {
      name: "New",
      rolloutPercentage: "30",
    });
    expect(writes()[0]?.body).toEqual({
      name: "New",
      filters: { groups: [{ properties: [], rollout_percentage: 30 }] },
      version: 4,
    });
    // One read before the write, one after it for the answer.
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET"]);
  });

  it("sends nothing for an edit with nothing in it", async () => {
    const { client, writes } = flagClient({ version: 4 });
    await client.updateResource("feature-flag", RESOURCE, "acct", {});
    expect(writes()).toEqual([]);
  });

  it("sends the version when deleting", async () => {
    const { client, writes } = flagClient({ version: 4 });
    await client.deleteResource("feature-flag", RESOURCE);
    expect(writes()[0]?.body).toEqual({ deleted: true, version: 4 });
  });

  it("leaves it out of a PATCH for a flag from before versioning, which reads as null", async () => {
    const { client, writes } = flagClient({ version: null });
    await client.deleteResource("feature-flag", RESOURCE);
    expect(writes()[0]?.body).toEqual({ deleted: true });
  });
});

describe("a resource id with a blank part", () => {
  const client = () => {
    const { http, calls } = makeHttp(() => ({ body: { results: [] } }));
    return { client: hostClient(new PostHogClient(CREDS, { http })), calls };
  };

  it.each(["acct:dashboard:7/", "acct:dashboard:/9", "acct:dashboard:9"])(
    "refuses %s, sending nothing",
    async (id) => {
      const { client: c, calls } = client();
      await expect(c.deleteResource("dashboard", id)).rejects.toThrow("not a PostHog");
      await expect(c.updateResource("dashboard", id, "acct", { name: "x" })).rejects.toThrow(
        "not a PostHog",
      );
      await expect(c.getResource("dashboard", id, "acct")).rejects.toThrow("not a PostHog");
      await expect(c.invokeAction?.("feature-flag", id, "enable")).rejects.toThrow("not a PostHog");
      await expect(c.invokeAction?.("feature-flag", id, "rollout-all")).rejects.toThrow(
        "not a PostHog",
      );
      await expect(c.deleteResource("batch-export", id)).rejects.toThrow("not a PostHog");
      expect(calls).toEqual([]);
    },
  );
});

describe("helpers", () => {
  it("builds rollouts, escapes HogQL and reads spend keys", () => {
    expect(withRollout({}, 20)).toEqual({ groups: [{ properties: [], rollout_percentage: 20 }] });
    expect(hogqlString("a'b")).toBe("'a\\'b'");
    expect(
      seriesKey({ label: "Events", breakdown_type: "type", breakdown_value: "product_analytics" }),
    ).toEqual({ product: "Events" });
  });
});

describe("status feed", () => {
  it("keeps open incidents and scopes regions", () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>PostHog status</title>
      <item><title><![CDATA[EU ingestion delayed]]></title><link>https://www.posthogstatus.com/incidents/1</link><guid>g1</guid>
      <pubDate>Tue, 06 Oct 2026 16:58:25 GMT</pubDate><description><![CDATA[<b>Status: Investigating</b><br/>Events are delayed<br/><b>Affected components</b><ul><li>Event ingestion EU (Degraded performance)</li></ul>]]></description></item>
      <item><title><![CDATA[Old]]></title><guid>g2</guid><description><![CDATA[<b>Status: Resolved</b>]]></description></item>
      </channel></rss>`;
    const incidents = parseStatusFeed(rss);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      externalId: "g1",
      state: "investigating",
      regions: ["eu"],
      services: ["Event ingestion EU"],
    });
    expect(() => parseStatusFeed("{}")).toThrow();
  });
});

describe("terraform", () => {
  it("exports flags with their project and import id", () => {
    const r = mapProjectObject(
      "a",
      "feature-flag",
      "7",
      { id: 3, key: "beta", active: true, filters: { groups: [] } },
      { baseUrl: "https://us.posthog.com", region: "us" },
    );
    const out = JSON.stringify(exportResourcesToTerraform([r], () => posthogTerraformExport));
    expect(out).toContain("posthog_feature_flag");
    expect(out).toContain("7/3");
  });
});
