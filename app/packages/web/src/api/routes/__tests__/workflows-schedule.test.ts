import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mockSetWorkflowSchedule = vi.fn();

vi.mock("@/services/workflows", () => ({
  WorkflowError: class WorkflowError extends Error {
    status = 400;
  },
  checkWorkflowSource: vi.fn(),
  clearWorkflowSchedule: vi.fn(),
  createWorkflow: vi.fn(),
  generateWorkflowTypings: vi.fn(),
  getWorkflow: vi.fn(),
  listWorkflowMetrics: vi.fn(),
  listWorkflowRuns: vi.fn(),
  listWorkflows: vi.fn(),
  redactWorkflow: (w: unknown) => w,
  setWorkflowSchedule: (...a: unknown[]) => mockSetWorkflowSchedule(...a),
  softDeleteWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  workflowScheduleView: () => ({ expression: "0 9 * * 1" }),
}));

vi.mock("@/services/workflow-runner", () => ({ runWorkflowById: vi.fn() }));
vi.mock("@/services/workflow-secrets", () => ({
  WorkflowSecretError: class WorkflowSecretError extends Error {
    status = 400;
  },
  getWorkflowSecretAssignments: vi.fn(),
  listAssignedWorkflowSecrets: vi.fn(),
  setWorkflowSecretAssignments: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/auth/permissions", () => ({ requirePermission: vi.fn() }));

const workflows = (await import("@/api/routes/workflows")).default;

/** PUT the schedule sub-resource with an arbitrary JSON body. */
function putSchedule(body: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("organizationId", "org1");
    await next();
  });
  app.route("/", workflows);
  return app.request("/wf1/schedule", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /:id/schedule body validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetWorkflowSchedule.mockResolvedValue({ trigger: { kind: "cron" } });
  });

  it("accepts a well-formed body", async () => {
    const res = await putSchedule({ expression: "0 9 * * 1", timezone: "Europe/London" });
    expect(res.status).toBe(200);
    expect(mockSetWorkflowSchedule).toHaveBeenCalled();
  });

  it("accepts an omitted timezone and enabled", async () => {
    const res = await putSchedule({ expression: "0 9 * * 1" });
    expect(res.status).toBe(200);
  });

  it("accepts a null timezone", async () => {
    const res = await putSchedule({ expression: "0 9 * * 1", timezone: null });
    expect(res.status).toBe(200);
  });

  it("rejects a missing expression", async () => {
    const res = await putSchedule({ timezone: "UTC" });
    expect(res.status).toBe(400);
    expect(mockSetWorkflowSchedule).not.toHaveBeenCalled();
  });

  // A truthy non-boolean would otherwise be stored as `enabled` while
  // `computeSchedule` reads it as enabled — a disabled workflow with a live
  // next_run_at.
  it.each([["false"], [0], [1], [null]])("rejects a non-boolean enabled: %o", async (enabled) => {
    const res = await putSchedule({ expression: "0 9 * * 1", enabled });
    expect(res.status).toBe(400);
    expect(mockSetWorkflowSchedule).not.toHaveBeenCalled();
  });

  it.each([[5], [{}], [["UTC"]]])("rejects a non-string timezone: %o", async (timezone) => {
    const res = await putSchedule({ expression: "0 9 * * 1", timezone });
    expect(res.status).toBe(400);
    expect(mockSetWorkflowSchedule).not.toHaveBeenCalled();
  });
});
