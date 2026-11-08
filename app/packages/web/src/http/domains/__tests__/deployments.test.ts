import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// Deployments on HttpApi: the plan gate's 402, the change freeze on rollback,
// the trigger bodies' own sentences, and the service's refusal statuses.
class FakeDeploymentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
class FakePlanRequiredError extends Error {}

const rollbackDeployment = vi.fn();
const upsertDeployTrigger = vi.fn();
const setDeployTriggerEnabled = vi.fn();
const recordCliRun = vi.fn();
const mockActiveFreeze = vi.fn();

vi.mock("@/services/deployments", () => ({
  DeploymentError: FakeDeploymentError,
  declaredEnvs: vi.fn(),
  deleteDeployTrigger: vi.fn(),
  getDeploymentRun: vi.fn(async () => {
    throw new FakeDeploymentError("Deployment run not found.", 404);
  }),
  listDeployTriggers: vi.fn(),
  listDeployableRepos: vi.fn(),
  listDeploymentRuns: vi.fn(async () => []),
  recordCliRun: (...a: unknown[]) => recordCliRun(...a),
  resolveInfrafile: vi.fn(),
  rollbackDeployment: (...a: unknown[]) => rollbackDeployment(...a),
  runDeployment: vi.fn(),
  setDeployTriggerEnabled: (...a: unknown[]) => setDeployTriggerEnabled(...a),
  upsertDeployTrigger: (...a: unknown[]) => upsertDeployTrigger(...a),
}));
vi.mock("@/services/entitlements", () => ({ PlanRequiredError: FakePlanRequiredError }));
vi.mock("@infrawrench/server-core/cost/change-impact-load", () => ({
  loadDeploymentCostImpact: vi.fn(async () => null),
}));
vi.mock("@infrawrench/server-core/change-freezes", () => ({
  findActiveChangeFreeze: (...a: unknown[]) => mockActiveFreeze(...a),
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn(async () => undefined) }));

const { deploymentsDomain } = await import("@/http/domains/deployments/index");
const app = (permissions?: readonly string[]) =>
  buildTestApi(deploymentsDomain, {
    basePath: "/api/org/org-1/deployments",
    ...(permissions ? { permissions } : {}),
  });
const send = (method: string, body?: unknown) => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockActiveFreeze.mockResolvedValue(null);
});

describe("deployments", () => {
  it("rolls back with an optional body, deleting created resources only on an explicit true", async () => {
    rollbackDeployment.mockResolvedValue({ runId: "r2", result: { status: "success" } });
    const bare = await app().request("/runs/r1/rollback", send("POST"));
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual({ runId: "r2", result: { status: "success" } });
    expect(rollbackDeployment).toHaveBeenLastCalledWith({
      organizationId: "org-1",
      runId: "r1",
      userId: "user-1",
    });
    await app().request("/runs/r1/rollback", send("POST", { deleteCreated: "yes" }));
    expect(rollbackDeployment.mock.lastCall?.[0]).not.toHaveProperty("deleteCreated");
    await app().request("/runs/r1/rollback", send("POST", { deleteCreated: true }));
    expect(rollbackDeployment.mock.lastCall?.[0]).toMatchObject({ deleteCreated: true });
  });

  it("refuses a rollback during a change freeze, before the run is touched", async () => {
    mockActiveFreeze.mockResolvedValue({
      id: "f1",
      organizationId: "org-1",
      name: "Launch",
      reason: null,
      startsAt: new Date("2030-01-01T00:00:00.000Z"),
      endsAt: null,
      active: true,
      createdByUserId: null,
      endedByUserId: null,
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const res = await app().request("/runs/r1/rollback", send("POST"));
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe("change_freeze_active");
    expect(rollbackDeployment).not.toHaveBeenCalled();
  });

  it("answers the plan gate with 402 and a service refusal with its status", async () => {
    rollbackDeployment.mockRejectedValueOnce(new FakePlanRequiredError("Upgrade to deploy"));
    const plan = await app().request("/runs/r1/rollback", send("POST"));
    expect(plan.status).toBe(402);
    expect(await plan.json()).toEqual({ error: "Upgrade to deploy" });
    rollbackDeployment.mockRejectedValueOnce(new FakeDeploymentError("Already running", 409));
    const busy = await app().request("/runs/r1/rollback", send("POST"));
    expect(busy.status).toBe(409);
    const missing = await app().request("/runs/nope");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Deployment run not found." });
  });

  it("checks trigger bodies with the routes' sentences", async () => {
    const missing = await app().request("/triggers", send("POST", { repo: "a/b" }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "repo, branch and env are required" });
    const enable = await app().request("/triggers/t1", send("PATCH", {}));
    expect(await enable.json()).toEqual({ error: "enabled must be true or false" });
    expect(setDeployTriggerEnabled).not.toHaveBeenCalled();
    upsertDeployTrigger.mockResolvedValue({ id: "t1" });
    const armed = await app().request(
      "/triggers",
      send("POST", { repo: "a/b", branch: "main", env: "prod" }),
    );
    expect(armed.status).toBe(201);
    expect(upsertDeployTrigger).toHaveBeenCalledWith("org-1", "user-1", {
      repo: "a/b",
      branch: "main",
      env: "prod",
    });
  });

  it("records a CLI run only with env and status", async () => {
    expect((await app().request("/runs", send("POST", { env: "prod" }))).status).toBe(400);
    recordCliRun.mockResolvedValue({ id: "r9" });
    const res = await app().request("/runs", send("POST", { env: "prod", status: "success" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "r9" });
  });

  it("needs costs:read on top of deployments:read for a run's cost impact", async () => {
    const res = await app(["deployments:read"]).request("/runs/r1/cost-impact");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: costs:read" });
    const bad = await app().request("/runs/r1/cost-impact?costBasis=weird");
    expect(await bad.json()).toEqual({ error: "costBasis must be cash or amortized" });
    const missing = await app().request("/runs/r1/cost-impact");
    expect(await missing.json()).toEqual({ error: "Deployment run not found" });
  });
});
