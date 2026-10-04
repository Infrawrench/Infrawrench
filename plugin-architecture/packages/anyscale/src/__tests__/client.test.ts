import { describe, expect, it } from "vitest";
import { evaluateOrphanRule } from "@infrawrench/plugin-base";
import { AnyscaleClient } from "../client.js";
import { nodeHours, toUtilizationSeries } from "../metrics.js";
import { WorkspaceResourceType } from "../resource-types.js";
import { makeHttp } from "./helpers.js";
import type { Reply } from "./helpers.js";

function clientWith(route: (url: URL, method: string, body: unknown) => Reply) {
  const { http, calls } = makeHttp(route);
  return { client: new AnyscaleClient({ apiKey: "key" }, { http }), calls };
}

describe("workspaces", () => {
  const route = (url: URL): Reply => {
    switch (url.pathname) {
      case "/api/v2/experimental_workspaces/":
        return {
          body: {
            results: [
              {
                id: "expwrk_a",
                name: "idle-one",
                state: "Running",
                cluster_id: "ses_a",
                project_id: "prj_1",
              },
              { id: "expwrk_b", name: "busy-one", state: "Running", cluster_id: "ses_b" },
              { id: "expwrk_c", name: "off", state: "Terminated", cluster_id: "ses_c" },
            ],
          },
        };
      case "/api/v2/decorated_sessions/":
        return {
          body: {
            results: [
              {
                id: "ses_a",
                idle_termination_status: "IDLE",
                idle_timeout: 120,
                idle_timeout_last_activity_at: "2026-10-04T08:00:00Z",
              },
              { id: "ses_b", idle_termination_status: "ACTIVE_RAY" },
              { id: "ses_sys", is_system_cluster: true },
            ],
          },
        };
      case "/api/v2/projects/":
        return { body: { results: [{ id: "prj_1", name: "research" }] } };
      default:
        return { status: 404 };
    }
  };

  it("joins clusters and flags only running idle workspaces as orphans", async () => {
    const { client } = clientWith(route);
    const list = await client.listResources("workspace", "acc");
    const byName = Object.fromEntries(list.map((w) => [w.displayName, w]));
    expect(byName["idle-one"]!.fields).toMatchObject({
      idle: "yes",
      activity: "Idle",
      idleTerminationMinutes: 120,
      projectName: "research",
    });
    expect(byName["busy-one"]!.fields["idle"]).toBe("no");
    expect(byName["off"]!.fields["idle"]).toBeUndefined();
    const flagged = list.filter((w) =>
      evaluateOrphanRule(WorkspaceResourceType.orphanRule, w.fields),
    );
    expect(flagged.map((w) => w.displayName)).toEqual(["idle-one"]);
  });

  it("terminates through the workspace's cluster with terminate: true", async () => {
    const { client, calls } = clientWith((url) => {
      if (url.pathname === "/api/v2/experimental_workspaces/expwrk_a") {
        return {
          body: { result: { id: "expwrk_a", name: "w", state: "Running", cluster_id: "ses_a" } },
        };
      }
      if (url.pathname === "/api/v2/decorated_sessions/ses_a")
        return { body: { result: { id: "ses_a" } } };
      if (url.pathname === "/api/v2/sessions/ses_a/stop") return { body: {} };
      return { status: 404 };
    });
    await client.invokeAction("workspace", "acc:workspace:expwrk_a", "terminate", "acc");
    const stop = calls.find((c) => c.url.pathname === "/api/v2/sessions/ses_a/stop");
    expect(stop?.method).toBe("POST");
    expect(stop?.body).toMatchObject({
      terminate: true,
      workers_only: false,
      keep_min_workers: false,
    });
  });
});

describe("jobs and services", () => {
  it("lists batch jobs only and terminates by id", async () => {
    const { client, calls } = clientWith((url) => {
      if (url.pathname === "/api/v2/decorated_ha_jobs/") {
        return {
          body: {
            results: [
              {
                id: "prodjob_1",
                name: "train",
                state: { current_state: "RUNNING", goal_state: "SUCCESS" },
                last_job_run: { status: "RUNNING" },
                config: { entrypoint: "python train.py", max_retries: 2 },
              },
            ],
          },
        };
      }
      return { body: {} };
    });
    const [job] = await client.listResources("job", "acc");
    expect(job!.fields).toMatchObject({
      state: "RUNNING",
      entrypoint: "python train.py",
      maxRetries: 2,
    });
    expect(calls[0]!.url.searchParams.get("type_filter")).toBe("BATCH_JOB");
    await client.invokeAction("job", job!.id, "terminate", "acc");
    expect(calls.at(-1)!.url.pathname).toBe("/api/v2/decorated_ha_jobs/prodjob_1/terminate");
  });

  it("summarises a rollout from the canary's weights", async () => {
    const { client } = clientWith(() => ({
      body: {
        results: [
          {
            id: "service2_1",
            name: "llm",
            current_state: "ROLLING_OUT",
            primary_version: { version: "v1", current_weight: 75 },
            canary_version: { version: "v2", current_weight: 25, target_weight: 100 },
          },
        ],
      },
    }));
    const [svc] = await client.listResources("service", "acc");
    expect(svc!.fields).toMatchObject({
      rollout: "Rolling out v2: 25% of traffic, target 100%",
      primaryWeight: 75,
      canaryWeight: 25,
    });
    const schema = client.renderDetail(svc!);
    expect(schema.headerActions?.map((a) => a.label)).toEqual([
      "Roll back",
      "Terminate",
      "Open in Anyscale",
    ]);
  });
});

describe("budgets", () => {
  it("creates a project-scoped budget from the scope picker", async () => {
    const { client, calls } = clientWith((url, method) => {
      if (url.pathname === "/api/v2/instance_usage_budgets/" && method === "POST") {
        return {
          body: {
            result: { id: "bud_1", name: "cap", budget_amount: 500, evaluation_period: "MONTHLY" },
          },
        };
      }
      return { status: 404 };
    });
    const created = await client.createResource("budget", "acc", {
      name: "cap",
      scope: "project:cld_1:prj_1",
      budgetAmount: "500",
      budgetUnit: "DOLLARS",
      evaluationPeriod: "MONTHLY",
    });
    expect(created.externalId).toBe("bud_1");
    expect(calls[0]!.body).toEqual({
      name: "cap",
      budget_amount: 500,
      budget_unit: "DOLLARS",
      evaluation_period: "MONTHLY",
      cloud_id: "cld_1",
      project_id: "prj_1",
    });
  });

  it("updates amount and period through query parameters", async () => {
    const { client, calls } = clientWith(() => ({
      body: { result: { id: "bud_1", budget_amount: 900, evaluation_period: "DAILY" } },
    }));
    await client.updateResource("budget", "acc:budget:bud_1", "acc", {
      budgetAmount: "900",
      evaluationPeriod: "DAILY",
    });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.searchParams.get("budget_amount")).toBe("900");
    expect(calls[0]!.url.searchParams.get("evaluation_period")).toBe("DAILY");
  });
});

describe("metrics", () => {
  it("labels utilization series, scales fractions and integrates node hours", () => {
    const series = toUtilizationSeries({
      result: {
        series: [
          {
            name: "ON_DEMAND",
            points: [
              { timestamp: 0, value: 2 },
              { timestamp: 3600, value: 2 },
            ],
          },
          {
            name: "SPOT",
            points: [
              { timestamp: 0, value: 0 },
              { timestamp: 3600, value: 4 },
            ],
          },
          { name: "cpu_utilization", points: [{ timestamp: 0, value: 0.5 }] },
          { name: "gpu_count", points: [{ timestamp: 0, value: 8 }] },
        ],
      },
    });
    expect(series.map((s) => s.label)).toEqual([
      "Nodes (on-demand)",
      "Nodes (spot)",
      "CPU utilization",
      "GPUs",
    ]);
    expect(series[2]!.points[0]!.value).toBe(50);
    expect(series[0]!.points[1]!.timestamp).toBe(3600_000);
    expect(nodeHours(series)).toBe(4);
  });
});
