import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BasetenClient } from "../client.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { buildAutoscalingPatch } from "../autoscaling.js";
import { mapComponent, parseStatusFeed } from "../status-feed.js";
import { evaluateOrphanRule } from "@infrawrench/plugin-base";
import { DeploymentResourceType } from "../resource-types.js";
import { installFetch, route, state } from "./helpers.js";

const ACC = "acc-1";

function client() {
  return new BasetenClient({ apiKey: "b10_test.key" }, RESOURCE_TYPES);
}

const deployment = (over: Record<string, unknown> = {}) => ({
  id: "dep-1",
  name: "v3",
  model_id: "m-1",
  is_production: true,
  is_development: false,
  status: "ACTIVE",
  active_replica_count: 2,
  autoscaling_settings: { min_replica: 2, max_replica: 5, concurrency_target: 4 },
  instance_type_name: "1x H100",
  environment: "production",
  region: { slug: "us-east", display_name: "US East" },
  ...over,
});

beforeEach(() => {
  installFetch();
  route("GET", "/v1/models", {
    models: [{ id: "m-1", name: "llama", deployments_count: 2, team_name: "Core" }],
  });
  route("GET", "/v1/instance_types", {
    instance_types: [{ id: "H100", name: "1x H100", gpu_count: 1, gpu_type: "H100" }],
  });
  route("GET", "/v1/instance_type_prices", {
    instance_types: [
      {
        instance_type: { id: "H100", name: "1x H100", gpu_count: 1, gpu_type: "H100" },
        price: 0.1083,
      },
    ],
  });
  route("GET", "/v1/models/m-1/deployments", {
    deployments: [deployment(), deployment({ id: "dep-2", name: "v2", is_production: false })],
  });
  route("GET", "/v1/billing/usage_summary", {
    dedicated_usage: {
      subtotal: 10,
      credits_used: 0,
      total: 10,
      minutes: 100,
      breakdown: [
        {
          billable_resource: { id: "dep-1", kind: "MODEL_DEPLOYMENT", model_id: "m-1" },
          subtotal: "10.5",
          minutes: 100,
          inference_requests: 42,
        },
      ],
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("auth", () => {
  it("sends the key as a Bearer token", async () => {
    await client().listResources("model", ACC);
    expect(state.calls[0]!.headers["Authorization"]).toBe("Bearer b10_test.key");
  });

  it("throws without a key", () => {
    expect(() => new BasetenClient({}, RESOURCE_TYPES)).toThrow(/apiKey/);
  });
});

describe("deployments", () => {
  it("joins instance prices and billed usage, and flags idle warm replicas", async () => {
    const rows = await client().listResources("deployment", ACC);
    expect(rows).toHaveLength(2);
    const busy = rows.find((r) => r.externalId === "m-1/dep-1")!;
    expect(busy.parentResourceId).toBe(`${ACC}:model:m-1`);
    expect(busy.fields).toMatchObject({
      status: "ACTIVE",
      minReplica: 2,
      maxReplica: 5,
      gpuType: "H100",
      requests7d: 42,
      cost7d: 10.5,
      idle: "no",
    });
    expect(busy.fields["pricePerHour"]).toBeCloseTo(6.498);
    expect(busy.fields["minReplicaMonthlyCost"]).toBeCloseTo(0.1083 * 60 * 730 * 2, 1);
    expect(busy.resolvedOutputs["predictUrl"]).toBe(
      "https://model-m-1.api.baseten.co/deployment/dep-1/predict",
    );
    const idle = rows.find((r) => r.externalId === "m-1/dep-2")!;
    expect(idle.fields["idle"]).toBe("yes");
    expect(evaluateOrphanRule(DeploymentResourceType.orphanRule, idle.fields)).toMatch(/warm/);
    expect(evaluateOrphanRule(DeploymentResourceType.orphanRule, busy.fields)).toBeNull();
  });

  it("leaves usage fields unset when billing is unreadable, so nothing reads as idle", async () => {
    route("GET", "/v1/billing/usage_summary", () => new Response("{}", { status: 403 }));
    const rows = await client().listResources("deployment", ACC);
    for (const r of rows) {
      expect(r.fields["idle"]).toBeUndefined();
      expect(r.fields["requests7d"]).toBeUndefined();
    }
  });

  it("validates and patches autoscaling settings", async () => {
    route("GET", "/v1/models/m-1/deployments/dep-1", deployment());
    route("PATCH", "/v1/models/m-1/deployments/dep-1/autoscaling_settings", {
      status: "ACCEPTED",
    });
    const c = client();
    await c.updateResource("deployment", `${ACC}:deployment:m-1/dep-1`, ACC, {
      maxReplica: "8",
      concurrencyTarget: "10",
    });
    const patch = state.calls.find((x) => x.method === "PATCH");
    expect(patch!.body).toEqual({ max_replica: 8, concurrency_target: 10 });

    await expect(
      c.updateResource("deployment", `${ACC}:deployment:m-1/dep-1`, ACC, { minReplica: "9" }),
    ).rejects.toThrow(/cannot be above max replicas \(5\)/);
  });

  it("promotes, activates and scales to zero through the documented routes", async () => {
    route("GET", "/v1/models/m-1/deployments/dep-2", deployment({ id: "dep-2" }));
    route("POST", "/v1/models/m-1/deployments/dep-2/promote", deployment({ id: "dep-2" }));
    route("POST", "/v1/models/m-1/deployments/dep-2/activate", { success: true });
    route("PATCH", "/v1/models/m-1/deployments/dep-2/autoscaling_settings", {});
    const c = client();
    const id = `${ACC}:deployment:m-1/dep-2`;
    await c.invokeAction("deployment", id, "promote", ACC);
    await c.invokeAction("deployment", id, "activate", ACC);
    await c.invokeAction("deployment", id, "scale-to-zero", ACC);
    const promote = state.calls.find((x) => x.path.endsWith("/promote"));
    expect(promote!.body).toEqual({ scale_down_previous_production: true });
    const scale = state.calls.find((x) => x.method === "PATCH");
    expect(scale!.body).toEqual({ min_replica: 0 });
  });

  it("promotes into a chosen environment from the prompt form", async () => {
    route("POST", "/v1/models/m-1/environments/staging/promote", deployment());
    await client().executeNoSqlCommand(
      "deployment",
      `${ACC}:deployment:m-1/dep-2`,
      ACC,
      "promoteToEnvironment",
      [JSON.stringify({ environment: "staging", scaleDownPrevious: "false" })],
    );
    const call = state.calls.find((x) => x.path.endsWith("/staging/promote"));
    expect(call!.body).toEqual({ deployment_id: "dep-2", scale_down_previous_deployment: false });
  });
});

describe("environments", () => {
  it("maps current deployment, promotion state and settings", async () => {
    route("GET", "/v1/models/m-1/environments", {
      environments: [
        {
          name: "staging",
          model_id: "m-1",
          current_deployment: deployment({ id: "dep-2", status: "SCALED_TO_ZERO" }),
          candidate_deployment: deployment({ id: "dep-3", name: "v4" }),
          in_progress_promotion: { status: "RAMPING_UP", percent_traffic_to_new_version: 30 },
          autoscaling_settings: { min_replica: 0, max_replica: 3 },
          promotion_settings: { promotion_cleanup_strategy: "SCALE_TO_ZERO", rolling_deploy: true },
          autoscaling_schedules: { schedules: [{ id: "s1" }] },
        },
      ],
    });
    const [env] = await client().listResources("environment", ACC);
    expect(env!.externalId).toBe("m-1/staging");
    expect(env!.fields).toMatchObject({
      currentDeploymentId: "dep-2",
      status: "SCALED_TO_ZERO",
      candidateDeploymentName: "v4",
      promotionStatus: "RAMPING_UP",
      trafficToCandidate: 30,
      minReplica: 0,
      maxReplica: 3,
      promotionCleanup: "SCALE_TO_ZERO",
      rollingDeploy: true,
      scheduleCount: 1,
    });
    expect(env!.resolvedOutputs["predictUrl"]).toBe(
      "https://model-m-1.api.baseten.co/environments/staging/predict",
    );
  });

  it("creates an environment under the parent model", async () => {
    route("POST", "/v1/models/m-1/environments", (call: { body: { name: string } }) => ({
      name: call.body.name,
      model_id: "m-1",
    }));
    const env = await client().createResource(
      "environment",
      ACC,
      { name: "staging", minReplica: "0", maxReplica: "2", promotionCleanup: "DEACTIVATE" },
      `${ACC}:model:m-1`,
    );
    expect(env.externalId).toBe("m-1/staging");
    const post = state.calls.find((x) => x.method === "POST");
    expect(post!.body).toEqual({
      name: "staging",
      autoscaling_settings: { min_replica: 0, max_replica: 2 },
      promotion_settings: { promotion_cleanup_strategy: "DEACTIVATE" },
    });
  });

  it("refuses to delete production", async () => {
    await expect(
      client().deleteResource("environment", `${ACC}:environment:m-1/production`, ACC),
    ).rejects.toThrow(/production/);
  });
});

describe("secrets, training and catalog", () => {
  it("lists secrets by name only and rotates through the team upsert route", async () => {
    route("GET", "/v1/secrets", {
      secrets: [{ id: "s1", name: "hf_token", team_name: "Core", created_at: "2026-09-01" }],
    });
    route("GET", "/v1/teams", { teams: [{ id: "t1", name: "Core", default: true }] });
    route("POST", "/v1/teams/t1/secrets", { name: "hf_token", team_name: "Core" });
    const c = client();
    const [s] = await c.listResources("secret", ACC);
    expect(s!.externalId).toBe("Core/hf_token");
    expect(s!.fields["value"]).toBeUndefined();
    await c.updateResource("secret", s!.id, ACC, { value: "new" });
    const post = state.calls.find((x) => x.method === "POST");
    expect(post!.body).toEqual({ name: "hf_token", value: "new" });
  });

  it("lists training jobs with normalised status and stops them", async () => {
    route("POST", "/v1/training_jobs/search", {
      training_jobs: [
        {
          id: "j1",
          current_status: "TRAINING_JOB_RUNNING",
          training_project_id: "p1",
          training_project: { id: "p1", name: "sft" },
          instance_type: { id: "H100x8", name: "8x H100", gpu_count: 8, gpu_type: "H100" },
          node_count: 2,
          availability_model: "spot",
        },
      ],
    });
    route("POST", "/v1/training_projects/p1/jobs/j1/stop", { training_job: {} });
    const c = client();
    const [job] = await c.listResources("training-job", ACC);
    expect(job!.fields).toMatchObject({ status: "running", totalGpus: 16, availability: "spot" });
    expect(job!.parentResourceId).toBe(`${ACC}:training-project:p1`);
    await c.invokeAction("training-job", job!.id, "stop", ACC);
    expect(state.calls.some((x) => x.path === "/v1/training_projects/p1/jobs/j1/stop")).toBe(true);
  });

  it("lists instance types once each with hourly prices", async () => {
    const rows = await client().listResources("instance-type", ACC);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields["pricePerHour"]).toBeCloseTo(6.498);
  });

  it("lists only Model APIs the workspace added", async () => {
    route("GET", "/v1/model_apis", {
      items: [
        {
          name: "deepseek-v3",
          display_name: "DeepSeek V3",
          cost_per_million_input_tokens: "0.77",
          cost_per_million_output_tokens: 0.77,
          invoke_url: "https://inference.baseten.co",
          org_details: { added_at: "2026-08-01" },
        },
      ],
      pagination: { has_more: false },
    });
    const [m] = await client().listResources("model-api", ACC);
    expect(state.calls.at(-1)!.query.get("added_only")).toBe("true");
    expect(m!.fields["inputPricePerMillion"]).toBe(0.77);
    expect(m!.resolvedOutputs["invokeUrl"]).toBe("https://inference.baseten.co");
  });

  it("reports training GPU capacity as quotas", async () => {
    route("GET", "/v1/training/capacity", {
      gpu_capacities: [{ gpu_type: "H100", limit: 16, usage_count: 8, baseline: 0 }],
      team_gpu_capacities: [],
    });
    const q = await client().fetchQuotas(ACC);
    expect(q).toEqual([
      expect.objectContaining({ limit: 16, used: 8, name: "Concurrent H100 GPUs" }),
    ]);
  });
});

describe("autoscaling validation", () => {
  it("enforces documented bounds", () => {
    expect(() => buildAutoscalingPatch({ targetUtilization: "120" }, {})).toThrow(/1 and 100/);
    expect(() => buildAutoscalingPatch({ autoscalingWindow: "5" }, {})).toThrow(/10 and 3600/);
    expect(() => buildAutoscalingPatch({ maxReplica: "0" }, {})).toThrow(/at least 1/);
    expect(() => buildAutoscalingPatch({ minReplica: "1.5" }, {})).toThrow(/whole number/);
    expect(() => buildAutoscalingPatch({ maxReplica: "2" }, {}, { development: true })).toThrow(
      /development/,
    );
    expect(buildAutoscalingPatch({}, {})).toBeNull();
    expect(buildAutoscalingPatch({ scaleDownDelay: "0" }, {})).toEqual({ scale_down_delay: 0 });
  });
});

describe("status feed", () => {
  it("maps components", () => {
    expect(mapComponent("Model Management API")).toEqual({
      services: ["Model Management API"],
      providerWide: true,
    });
    expect(mapComponent("Dedicated Inference")).toEqual({ services: ["Dedicated Inference"] });
    expect(mapComponent("Homepage and Docs")).toBeNull();
    expect(parseStatusFeed(JSON.stringify({ incidents: [] }))).toEqual([]);
  });
});
