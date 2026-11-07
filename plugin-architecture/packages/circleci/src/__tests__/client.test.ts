import { hostClient, hostPlugin } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircleCIClient, buildParameters, buildTimetable } from "../client.js";
import { percentile, projectSeriesFrom, workflowRunSeries } from "../metrics.js";
import { plugin } from "../plugin.js";
import { mapComponent } from "../status-feed.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACC = "acc";
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const GH_ORG = { id: ORG_ID, "vcs-type": "github", name: "Acme", avatar_url: "", slug: "gh/acme" };

function client(route: (call: Call) => unknown, credentials: Record<string, string> = {}) {
  const { http, calls } = makeHttp((call) => {
    if (call.url.pathname === "/api/v2/me/collaborations") return [GH_ORG];
    return route(call);
  });
  const c = hostClient(
    new CircleCIClient({ apiToken: "TEST_TOKEN", organization: ORG_ID, ...credentials }, {
      http,
    } as never),
  );
  return { c, calls };
}

describe("organization picker", () => {
  it("lists the user's organizations by id", async () => {
    const { http } = makeHttp(() => [
      GH_ORG,
      { id: "", "vcs-type": "bitbucket", name: "Beta", avatar_url: "", slug: "bb/beta" },
    ]);
    const options = await hostPlugin(plugin).listCredentialOptions!(
      "organization",
      { apiToken: "t" },
      {
        http,
      } as never,
    );
    expect(options).toEqual([
      { id: ORG_ID, label: "Acme", description: "gh/acme" },
      { id: "bb/beta", label: "Beta", description: "bb/beta" },
    ]);
  });

  it("asks for a token first", async () => {
    await expect(hostPlugin(plugin).listCredentialOptions!("organization", {})).rejects.toThrow(
      /token first/,
    );
  });

  it("explains a rejected token", async () => {
    const { http } = makeHttp(() => ({ status: 401, body: { message: "Invalid token" } }));
    await expect(
      hostPlugin(plugin).listCredentialOptions!("organization", { apiToken: "t" }, {
        http,
      } as never),
    ).rejects.toThrow(/personal API token/);
  });
});

describe("listing", () => {
  it("lists projects from API v3 with slugs built from the org slug, and 30-day metrics", async () => {
    const { c, calls } = client((call) => {
      switch (call.url.pathname) {
        case "/api/v3/projects":
          expect(call.headers["Authorization"]).toBe("Bearer TEST_TOKEN");
          expect(call.url.searchParams.get("filter[org_id]")).toBe(ORG_ID);
          return {
            data: [
              { id: "p1", attributes: { name: "api", is_followed: true } },
              { id: "p2", attributes: { name: "web", is_followed: false } },
            ],
            page: { next: null },
          };
        case "/api/v2/pipeline":
          return {
            items: [
              { id: "x", project_slug: "gh/acme/api", number: 1, state: "created", created_at: "" },
            ],
          };
        case "/api/v2/insights/gh/acme/summary":
          return {
            org_data: { metrics: { total_credits_used: 1000, total_runs: 10, success_rate: 0.9 } },
            org_project_data: [
              {
                project_name: "api",
                metrics: {
                  total_credits_used: 1000,
                  total_runs: 10,
                  success_rate: 0.9,
                  total_duration_secs: 600,
                },
              },
            ],
            all_projects: ["api", "web"],
          };
        default:
          throw new Error(`unexpected ${call.url}`);
      }
    });
    const projects = await c.listResources("project", ACC);
    expect(projects.map((p) => p.externalId)).toEqual(["gh/acme/api", "gh/acme/web"]);
    expect(projects[0]!.fields).toMatchObject({
      credits30d: 1000,
      estimatedCost30d: 0.6,
      successRate30d: 90,
      projectId: "p1",
    });
    expect(calls.some((x) => x.url.pathname === "/api/v2/insights/gh/acme/summary")).toBe(true);
  });

  it("names contexts' variables but never asks for values", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/api/v2/context") {
        expect(call.url.searchParams.get("owner-id")).toBe(ORG_ID);
        return {
          items: [{ id: "c1", name: "aws", created_at: "2026-01-01" }],
          next_page_token: null,
        };
      }
      if (call.url.pathname === "/api/v2/context/c1/environment-variable") {
        return {
          items: [
            { variable: "AWS_KEY", context_id: "c1" },
            { variable: "AWS_SECRET", context_id: "c1" },
          ],
        };
      }
      throw new Error(`unexpected ${call.url}`);
    });
    const [ctx] = await c.listResources("context", ACC);
    expect(ctx!.fields).toMatchObject({ variableCount: 2, variables: "AWS_KEY, AWS_SECRET" });
    const vars = await c.listResources("context-variable", ACC);
    expect(vars.map((v) => v.externalId)).toEqual(["c1/AWS_KEY", "c1/AWS_SECRET"]);
    expect(vars[0]!.parentResourceId).toBe(`${ACC}:context:c1`);
  });

  it("counts runners and waiting tasks per resource class", async () => {
    const { c } = client((call) => {
      switch (`${call.url.hostname}${call.url.pathname}`) {
        case "circleci.com/api/v3/runner/resource-classes":
          return {
            data: [
              { id: "rc1", attributes: { resource_class: "acme/linux", description: "Linux" } },
            ],
            page: {},
          };
        case "circleci.com/api/v3/runner/agents":
          return {
            data: [
              {
                id: "a1",
                attributes: { name: "box-1", is_busy: true },
                references: {
                  resource_class: { id: "rc1", attributes: { resource_class: "acme/linux" } },
                },
              },
              {
                id: "a2",
                attributes: { name: "box-2" },
                references: { resource_class: { id: "rc1" } },
              },
            ],
            page: {},
          };
        case "runner.circleci.com/api/v3/runner/tasks":
          expect(call.headers["Circle-Token"]).toBe("TEST_TOKEN");
          expect(call.url.searchParams.get("resource-class")).toBe("acme/linux");
          return { unclaimed_task_count: 3 };
        case "runner.circleci.com/api/v3/runner/tasks/running":
          return { running_runner_tasks: 1 };
        default:
          throw new Error(`unexpected ${call.url}`);
      }
    });
    const [rc] = await c.listResources("runner-resource-class", ACC);
    expect(rc!.fields).toMatchObject({
      name: "acme/linux",
      runnerCount: 2,
      unclaimedTasks: 3,
      runningTasks: 1,
    });
    const runners = await c.listResources("runner", ACC);
    expect(runners[0]).toMatchObject({
      displayName: "box-1",
      parentResourceId: `${ACC}:runner-resource-class:rc1`,
    });
    expect(runners[0]!.fields["busy"]).toBe(true);
  });

  it("lists nothing for runners when the organization has none", async () => {
    const { c } = client(() => ({ status: 404, body: { error: { title: "Not found" } } }));
    expect(await c.listResources("runner-resource-class", ACC)).toEqual([]);
  });
});

describe("actions", () => {
  it("reruns, reruns from failed, cancels and approves workflows", async () => {
    const { c, calls } = client(() => ({ status: 202, body: { workflow_id: "w2" } }));
    await c.invokeAction("pipeline", `${ACC}:pipeline:p1`, "rerun:w1", ACC);
    await c.invokeAction("pipeline", `${ACC}:pipeline:p1`, "rerun-failed:w1", ACC);
    await c.invokeAction("pipeline", `${ACC}:pipeline:p1`, "cancel:w1", ACC);
    await c.invokeAction("pipeline", `${ACC}:pipeline:p1`, "approve:w1:req9", ACC);
    await c.invokeAction("workflow", `${ACC}:workflow:gh/acme/api/build`, "rerun:w7", ACC);
    expect(calls.map((x) => [x.method, x.url.pathname, x.body])).toEqual([
      ["POST", "/api/v2/workflow/w1/rerun", {}],
      ["POST", "/api/v2/workflow/w1/rerun", { from_failed: true }],
      ["POST", "/api/v2/workflow/w1/cancel", undefined],
      ["POST", "/api/v2/workflow/w1/approve/req9", undefined],
      ["POST", "/api/v2/workflow/w7/rerun", {}],
    ]);
  });

  it("enables and disables triggers", async () => {
    const { c, calls } = client(() => ({}));
    await c.invokeAction("trigger", `${ACC}:trigger:gh/acme/api/pid/tid`, "disable", ACC);
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { disabled: true } });
    expect(calls[0]!.url.pathname).toBe("/api/v2/projects/pid/triggers/tid");
  });

  it("mints a runner token for Get credentials", async () => {
    const { c, calls } = client(() => ({
      data: { id: "t1", attributes: { token: "secret-token", nickname: "n", created_at: "" } },
    }));
    const out = await c.exportCredential(
      "runner-resource-class",
      `${ACC}:runner-resource-class:rc1`,
      ACC,
      "runner-token",
    );
    expect(out.content).toBe("secret-token");
    expect(calls[0]!.url.pathname).toBe("/api/v3/runner/tokens");
    expect(calls[0]!.body).toMatchObject({
      data: { references: { resource_class: { id: "rc1" } } },
    });
  });
});

describe("create", () => {
  it("triggers a pipeline, falling back to the original endpoint", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/api/v2/project/gh/acme/api/pipeline/run") {
        return { status: 404, body: { message: "Not found" } };
      }
      if (call.url.pathname === "/api/v2/project/gh/acme/api/pipeline") {
        return { status: 201, body: { id: "p9", number: 9, state: "created", created_at: "" } };
      }
      if (call.url.pathname === "/api/v2/pipeline/p9") {
        return {
          id: "p9",
          number: 9,
          state: "created",
          created_at: "",
          project_slug: "gh/acme/api",
          vcs: { branch: "main" },
        };
      }
      if (call.url.pathname === "/api/v2/pipeline/p9/workflow") return { items: [] };
      throw new Error(`unexpected ${call.url}`);
    });
    const r = await c.createResource(
      "pipeline",
      ACC,
      { branch: "main", parameters: '{"deploy": true}' },
      `${ACC}:project:gh/acme/api`,
    );
    expect(r.externalId).toBe("p9");
    expect(calls[0]!.body).toEqual({
      config: { branch: "main" },
      checkout: { branch: "main" },
      parameters: { deploy: true },
    });
    expect(calls[1]!.body).toEqual({ branch: "main", parameters: { deploy: true } });
  });

  it("creates a context owned by the organization", async () => {
    const { c, calls } = client(() => ({ id: "c2", name: "prod", created_at: "" }));
    const r = await c.createResource("context", ACC, { name: "prod" });
    expect(r.externalId).toBe("c2");
    expect(calls.at(-1)!.body).toEqual({
      name: "prod",
      owner: { id: ORG_ID, type: "organization" },
    });
  });
});

describe("schedules", () => {
  it("builds a timetable from comma lists, defaulting to every hour and day", () => {
    expect(buildTimetable({ perHour: "2", hoursOfDay: "3, 15", daysOfWeek: "mon,fri" })).toEqual({
      "per-hour": 2,
      "hours-of-day": [3, 15],
      "days-of-week": ["MON", "FRI"],
    });
    const all = buildTimetable({});
    expect(all["hours-of-day"]).toHaveLength(24);
    expect(all["days-of-week"]).toHaveLength(7);
  });

  it("rejects days of week and month together, and out-of-range values", () => {
    expect(() => buildTimetable({ daysOfWeek: "MON", daysOfMonth: "1" })).toThrow(/not both/);
    expect(() => buildTimetable({ hoursOfDay: "24" })).toThrow(/0 to 23/);
    expect(() => buildTimetable({ perHour: "61" })).toThrow(/1 to 60/);
    expect(() => buildTimetable({ months: "FOO" })).toThrow(/Months/);
  });

  it("puts the branch into the parameters", () => {
    expect(buildParameters('{"a": 1}', "main")).toEqual({ a: 1, branch: "main" });
    expect(() => buildParameters("[1]", undefined)).toThrow(/JSON object/);
  });
});

describe("metrics", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeUndefined();
  });

  it("charts workflow duration p50/p95, success rate and credits per day", () => {
    const day = Date.parse("2026-10-01T00:00:00Z");
    const series = workflowRunSeries(
      [
        {
          id: "1",
          created_at: "2026-10-01T01:00:00Z",
          status: "success",
          duration: 60,
          credits_used: 10,
        },
        {
          id: "2",
          created_at: "2026-10-01T02:00:00Z",
          status: "failed",
          duration: 120,
          credits_used: 20,
        },
        {
          id: "3",
          created_at: "2026-10-01T03:00:00Z",
          status: "canceled",
          duration: 5,
          credits_used: 1,
        },
        { id: "4", created_at: "2026-10-01T04:00:00Z", status: "success", is_approval: true },
      ],
      86_400_000,
    );
    const get = (label: string) => series.find((s) => s.label === label)?.points[0];
    expect(get("Duration p50")).toEqual({ timestamp: day, value: 60 });
    expect(get("Duration p95")).toEqual({ timestamp: day, value: 120 });
    expect(get("Success rate")?.value).toBe(50);
    expect(get("Credits used")?.value).toBe(31);
    expect(get("Runs")?.value).toBe(3);
  });

  it("sums job time series into project credits and runs", () => {
    const series = projectSeriesFrom([
      {
        name: "a",
        timestamp: "2026-10-01T00:00:00Z",
        metrics: { total_credits_used: 5, total_runs: 2, failed_runs: 1 },
      },
      {
        name: "b",
        timestamp: "2026-10-01T00:00:00Z",
        metrics: { total_credits_used: 7, total_runs: 1, failed_runs: 0 },
      },
    ]);
    expect(series.find((s) => s.label === "Credits used")?.points[0]?.value).toBe(12);
    expect(series.find((s) => s.label === "Failed job runs")?.points[0]?.value).toBe(1);
  });
});

describe("status feed", () => {
  it("maps CircleCI's own components and ignores upstream ones", () => {
    expect(mapComponent("CircleCI API")).toEqual({
      services: ["CircleCI API"],
      providerWide: true,
    });
    expect(mapComponent("Runner")?.resourceTypes).toEqual(["runner-resource-class", "runner"]);
    expect(mapComponent("GitHub API Requests")).toBeNull();
    expect(mapComponent("AWS")).toBeNull();
  });
});

describe("project slugs in paths (#455)", () => {
  const PROJECT = { slug: "gh/acme/api", name: "api", id: "p1" };
  const gone = { status: 404, body: { message: "Not found" } };

  it("leaves a slug the API hands out exactly as it was, with its query", async () => {
    const { c, calls } = client(() => ({ items: [], next_page_token: null }));
    await c.fetchMetricSeries("workflow", `${ACC}:workflow:gh/acme/api/build`, ACC);
    expect(calls.at(-1)!.url.pathname).toBe("/api/v2/insights/gh/acme/api/workflows/build");
    expect(calls.at(-1)!.url.searchParams.get("all-branches")).toBe("true");
  });

  it("keeps a slug holding ? on its route, with the query still a query", async () => {
    const { c, calls } = client((call) =>
      call.url.pathname.startsWith("/api/v2/project/") ? PROJECT : gone,
    );
    await c.getResource("project", `${ACC}:project:gh/acme/a?b`, ACC);
    const read = calls.find((x) => x.url.pathname.startsWith("/api/v2/project/"))!;
    expect(read.url.pathname).toBe("/api/v2/project/gh/acme/a%3Fb");
    expect(read.url.search).toBe("");
  });

  it("encodes # and spaces in every route a slug goes into", async () => {
    const { c, calls } = client((call) =>
      call.method === "POST" ? { name: "A", value: "xxxx" } : { status: 204 },
    );
    await c.createResource("project-variable", ACC, {
      project: "gh/acme/my app#x",
      name: "A",
      value: "1",
    });
    await c.deleteResource("project-variable", `${ACC}:project-variable:gh/acme/a#b/NAME`, ACC);
    expect(calls.map((x) => x.url.href)).toEqual([
      "https://circleci.com/api/v2/project/gh/acme/my%20app%23x/envvar",
      "https://circleci.com/api/v2/project/gh/acme/a%23b/envvar/NAME",
    ]);
  });

  it("refuses a slug that would climb out of its route", async () => {
    const { c, calls } = client(() => ({}));
    await expect(
      c.deleteResource("project-variable", `${ACC}:project-variable:gh/../context/NAME`, ACC),
    ).rejects.toThrow(/not a CircleCI slug/);
    await expect(
      c.createResource("project-variable", ACC, { project: "gh//api", name: "A", value: "1" }),
    ).rejects.toThrow(/not a CircleCI slug/);
    expect(calls).toEqual([]);
  });

  it("refuses to run a pipeline on a slug missing its segments", async () => {
    const { c, calls } = client(() => ({}));
    await expect(c.createResource("pipeline", ACC, { project: "gh/acme" })).rejects.toThrow(
      /not a CircleCI slug/,
    );
    expect(calls).toEqual([]);
  });

  it.each([
    ["context", `${ACC}:context:`],
    ["schedule", `${ACC}:schedule:`],
    ["runner-resource-class", `${ACC}:runner-resource-class:`],
    ["context-variable", `${ACC}:context-variable:c1/`],
    ["context-variable", `${ACC}:context-variable:/NAME`],
    ["project-variable", `${ACC}:project-variable:gh/acme/api/`],
    ["trigger", `${ACC}:trigger:gh/acme/api/pid/`],
    ["trigger", `${ACC}:trigger:gh/acme/api//tid`],
  ])("refuses to delete a %s with a blank id: %s", async (type, id) => {
    const { c, calls } = client(() => ({}));
    await expect(c.deleteResource(type, id, ACC)).rejects.toThrow(/blank/);
    expect(calls).toEqual([]);
  });

  it("refuses to edit or switch a trigger with a blank id", async () => {
    const { c, calls } = client(() => ({}));
    const id = `${ACC}:trigger:gh/acme/api/pid/`;
    await expect(c.updateResource("trigger", id, ACC, { checkoutRef: "main" })).rejects.toThrow(
      /blank/,
    );
    await expect(c.invokeAction("trigger", id, "disable", ACC)).rejects.toThrow(/blank/);
    expect(calls).toEqual([]);
  });
});

describe("host transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends every call through the host's service, with no CA and no fetch", async () => {
    const fetchStub = vi.fn(() => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", fetchStub);
    const request = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ items: [], next_page_token: null }),
    }));
    await hostClient(
      new CircleCIClient({ apiToken: "TEST_TOKEN", organization: ORG_ID }, {
        http: { request },
      } as never),
    ).fetchMetricSeries("workflow", `${ACC}:workflow:gh/acme/api/build`, ACC);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).not.toHaveProperty("0.caCert");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("falls back to fetch with no host, and writes one query", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ items: [], next_page_token: null }), { status: 200 });
    });
    await hostClient(
      new CircleCIClient({ apiToken: "TEST_TOKEN", organization: ORG_ID }),
    ).fetchMetricSeries("workflow", `${ACC}:workflow:gh/acme/api/build`, ACC);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(
      /^https:\/\/circleci\.com\/api\/v2\/insights\/gh\/acme\/api\/workflows\/build\?all-branches=true&/,
    );
  });
});

describe("runner views on the answers the v3 document shows (#456)", () => {
  /** Every agent read must carry the class's id, the filter that needs no name. */
  function runnerClient(classes: unknown, agents: unknown[]) {
    return client((call) => {
      const { pathname, searchParams } = call.url;
      if (pathname === "/api/v3/runner/resource-classes") return { data: classes };
      if (pathname === "/api/v3/runner/resource-classes/rc1") return { data: { id: "rc1" } };
      if (pathname === "/api/v3/runner/agents") {
        expect(searchParams.get("filter[resource_class_id]")).toBe("rc1");
        expect(searchParams.get("filter[org_id]")).toBeNull();
        expect(searchParams.get("filter[resource_class]")).toBeNull();
        return { data: agents, page: { next: null } };
      }
      throw new Error(`unexpected ${call.url}`);
    });
  }

  it("counts a class's runners when items hold only an id", async () => {
    const { c } = runnerClient([{ id: "rc1" }], [{ id: "a1" }, { id: "a2" }]);
    const [rc] = await c.listResources("runner-resource-class", ACC);
    expect(rc!.displayName).toBe("rc1");
    expect(rc!.fields["runnerCount"]).toBe(2);
  });

  it("counts a class's runners in its detail view, with no name to filter on", async () => {
    const { c } = runnerClient([], [{ id: "a1" }]);
    const rc = await c.getResource(
      "runner-resource-class",
      `${ACC}:runner-resource-class:rc1`,
      ACC,
    );
    expect(rc.fields["runnerCount"]).toBe(1);
  });

  it("does not report zero runners when the count could not be read", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/api/v3/runner/resource-classes") return { data: [{ id: "rc1" }] };
      return { status: 500, body: { message: "boom" } };
    });
    const [rc] = await c.listResources("runner-resource-class", ACC);
    expect(rc!.fields).not.toHaveProperty("runnerCount");
  });
});

describe("list caps and bad pages (#384)", () => {
  const WORKFLOW = { name: "build", metrics: {} };
  const endless = (row: unknown) => ({ items: [row], next_page_token: "more" });
  const endlessV3 = (row: unknown) => ({ data: [row], page: { next: "more" } });
  const CONTEXTS = "/api/v2/context";

  it("throws past the cap on a v2 inventory list, after 1,000 requests", async () => {
    const { c, calls } = client(() => endless({ id: "c", name: "c" }));
    await expect(c.listResources("context", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((x) => x.url.pathname === CONTEXTS)).toHaveLength(1000);
  });

  it("throws past the cap on a v3 inventory list, after 200 requests at the largest page", async () => {
    const { c, calls } = client(() => endlessV3({ id: "a" }));
    await expect(c.listResources("runner", ACC)).rejects.toThrow("has more than Infrawrench reads");
    const agents = calls.filter((x) => x.url.pathname === "/api/v3/runner/agents");
    expect(agents).toHaveLength(200);
    expect(agents[0]!.url.searchParams.get("page[limit]")).toBe("250");
  });

  it("gets the truncation past the catch around the v3 project list", async () => {
    const { c, calls } = client((call) =>
      call.url.pathname === "/api/v3/projects"
        ? endlessV3({ id: "p", attributes: { name: "p" } })
        : { items: [], next_page_token: null, org_data: {}, all_projects: [] },
    );
    await expect(c.listResources("project", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    const listed = calls.filter((x) => x.url.pathname === "/api/v3/projects");
    expect(listed).toHaveLength(200);
    expect(listed[0]!.url.searchParams.get("page[limit]")).toBe("50");
  });

  it("gets the truncation past the catch around a context's variables", async () => {
    const { c } = client((call) =>
      call.url.pathname === CONTEXTS
        ? { items: [{ id: "c1", name: "aws" }], next_page_token: null }
        : endless({ variable: "A" }),
    );
    await expect(c.listResources("context", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    await expect(c.listResources("context-variable", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("gets the truncation past the catch around a class's runner count", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/api/v3/runner/agents"
        ? endlessV3({ id: "a" })
        : { data: [{ id: "rc1" }] },
    );
    await expect(c.listResources("runner-resource-class", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("reads a project's workflows past the old three pages", async () => {
    let page = 0;
    const { c } = client((call) => {
      if (call.url.pathname === "/api/v3/projects") {
        return { data: [{ id: "p1", attributes: { name: "api" } }], page: { next: null } };
      }
      if (call.url.pathname === "/api/v2/insights/gh/acme/api/workflows") {
        page++;
        return {
          items: [{ ...WORKFLOW, name: `w${page}` }],
          next_page_token: page < 5 ? `t${page}` : null,
        };
      }
      return { items: [], next_page_token: null };
    });
    const workflows = await c.listResources("workflow", ACC);
    expect(workflows.map((w) => w.displayName)).toEqual(["w1", "w2", "w3", "w4", "w5"]);
  });

  it.each([
    ["the first page", 0],
    ["a later page", 1],
  ])("throws on a renamed list key on %s, v2 and v3", async (_, badPage) => {
    let v2Page = 0;
    const v2 = client(() =>
      v2Page++ === badPage
        ? { results: [], next_page_token: null }
        : { items: [{ id: "c", name: "c" }], next_page_token: "more" },
    );
    await expect(v2.c.listResources("context", ACC)).rejects.toThrow("is not a list");
    let v3Page = 0;
    const v3 = client(() =>
      v3Page++ === badPage ? { rows: [] } : { data: [{ id: "a" }], page: { next: "more" } },
    );
    await expect(v3.c.listResources("runner", ACC)).rejects.toThrow("is not a list");
  });

  it("does not read a 2xx with no body as the end of a list", async () => {
    const { c } = client(() => ({ status: 200 }));
    await expect(c.listResources("context", ACC)).rejects.toThrow("is not a list");
    await expect(c.listResources("runner", ACC)).rejects.toThrow("is not a list");
  });

  it("walks past an empty page while the document's cursor is still on offer", async () => {
    let v2Page = 0;
    const v2 = client(() =>
      v2Page++ === 0
        ? { items: [], next_page_token: "more" }
        : { items: [{ id: "c", name: "c" }], next_page_token: null },
    );
    expect((await v2.c.listResources("context", ACC)).map((r) => r.externalId)).toEqual(["c"]);
    let v3Page = 0;
    const v3 = client(() =>
      v3Page++ === 0
        ? { data: [], page: { next: "more" } }
        : { data: [{ id: "a" }], page: { next: null } },
    );
    expect((await v3.c.listResources("runner", ACC)).map((r) => r.externalId)).toEqual(["a"]);
  });

  it("reads an empty account, and a list key set to null, as empty", async () => {
    const empty = client(() => ({ items: [], next_page_token: null }));
    expect(await empty.c.listResources("context", ACC)).toEqual([]);
    const nil = client(() => ({ items: null, next_page_token: null }));
    expect(await nil.c.listResources("context", ACC)).toEqual([]);
    const v3 = client(() => ({ data: [], page: { next: null } }));
    expect(await v3.c.listResources("runner", ACC)).toEqual([]);
  });

  it("keeps pipelines a rolling window of the newest, and does not throw", async () => {
    const { c, calls } = client(() => ({
      items: Array.from({ length: 20 }, (_, i) => ({
        id: `p${calls.length}-${i}`,
        number: i,
        project_slug: "gh/acme/api",
        state: "created",
        created_at: "",
      })),
      next_page_token: "more",
    }));
    const pipelines = await c.listResources("pipeline", ACC);
    expect(pipelines).toHaveLength(50);
    expect(calls.filter((x) => x.url.pathname === "/api/v2/pipeline")).toHaveLength(3);
  });

  it("charts what it could read rather than failing on a long window", async () => {
    const run = { id: "r", created_at: "2026-10-01T00:00:00Z", status: "success", duration: 1 };
    const workflow = client(() => endless(run));
    const series = await workflow.c.fetchMetricSeries(
      "workflow",
      `${ACC}:workflow:gh/acme/api/build`,
      ACC,
    );
    expect(series.length).toBeGreaterThan(0);
    expect(workflow.calls).toHaveLength(20);
    const project = client((call) =>
      call.url.pathname === "/api/v2/insights/gh/acme/api/workflows"
        ? endless(WORKFLOW)
        : { items: [] },
    );
    await project.c.fetchMetricSeries("project", `${ACC}:project:gh/acme/api`, ACC);
    const walked = project.calls.filter(
      (x) => x.url.pathname === "/api/v2/insights/gh/acme/api/workflows",
    );
    expect(walked).toHaveLength(3);
  });

  it("shows the first jobs in a detail view rather than none on a long list", async () => {
    const insights = "/api/v2/insights/gh/acme/api/workflows";
    const workflow = client((call) => {
      if (call.url.pathname === insights) return { items: [WORKFLOW], next_page_token: null };
      if (call.url.pathname === `${insights}/build/jobs`) return endless({ name: "job" });
      return { items: [], next_page_token: null };
    });
    const w = await workflow.c.getResource("workflow", `${ACC}:workflow:gh/acme/api/build`, ACC);
    expect(JSON.parse(w.resolvedOutputs["__jobs__"] ?? "[]")).toHaveLength(3);

    const pipeline = client((call) => {
      if (call.url.pathname === "/api/v2/pipeline/p1") {
        return {
          id: "p1",
          number: 1,
          project_slug: "gh/acme/api",
          state: "created",
          created_at: "",
        };
      }
      if (call.url.pathname === "/api/v2/pipeline/p1/workflow") return endless({ id: "w1" });
      return endless({ name: "job" });
    });
    await expect(
      pipeline.c.getResource("pipeline", `${ACC}:pipeline:p1`, ACC),
    ).resolves.toMatchObject({ externalId: "p1" });
    expect(
      pipeline.calls.filter((x) => x.url.pathname === "/api/v2/pipeline/p1/workflow"),
    ).toHaveLength(10);
  });
});
