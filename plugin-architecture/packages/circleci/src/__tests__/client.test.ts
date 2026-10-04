import { describe, expect, it } from "vitest";
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
  const c = new CircleCIClient({ apiToken: "TEST_TOKEN", organization: ORG_ID, ...credentials }, {
    http,
  } as never);
  return { c, calls };
}

describe("organization picker", () => {
  it("lists the user's organizations by id", async () => {
    const { http } = makeHttp(() => [
      GH_ORG,
      { id: "", "vcs-type": "bitbucket", name: "Beta", avatar_url: "", slug: "bb/beta" },
    ]);
    const options = await plugin.listCredentialOptions!("organization", { apiToken: "t" }, {
      http,
    } as never);
    expect(options).toEqual([
      { id: ORG_ID, label: "Acme", description: "gh/acme" },
      { id: "bb/beta", label: "Beta", description: "bb/beta" },
    ]);
  });

  it("asks for a token first", async () => {
    await expect(plugin.listCredentialOptions!("organization", {})).rejects.toThrow(/token first/);
  });

  it("explains a rejected token", async () => {
    const { http } = makeHttp(() => ({ status: 401, body: { message: "Invalid token" } }));
    await expect(
      plugin.listCredentialOptions!("organization", { apiToken: "t" }, { http } as never),
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
