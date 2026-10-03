import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const mockSetWorkflowSchedule = vi.fn();
const mockClearWorkflowSchedule = vi.fn();
const mockUpdateWorkflow = vi.fn();
const mockAssignWorkflowSecrets = vi.fn();
const mockGetWorkflowSecretAssignments = vi.fn();

vi.mock("@/services/workflows", () => ({
  WorkflowError: class WorkflowError extends Error {
    status = 400;
  },
  assignWorkflowSecrets: (...a: unknown[]) => mockAssignWorkflowSecrets(...a),
  checkWorkflowSource: vi.fn(),
  clearWorkflowSchedule: (...a: unknown[]) => mockClearWorkflowSchedule(...a),
  createWorkflow: vi.fn(),
  generateWorkflowTypings: vi.fn(),
  getWorkflow: vi.fn(),
  listWorkflowMetrics: vi.fn(),
  listWorkflowRuns: vi.fn(),
  listWorkflows: vi.fn(),
  redactWorkflow: (w: unknown) => w,
  setWorkflowSchedule: (...a: unknown[]) => mockSetWorkflowSchedule(...a),
  softDeleteWorkflow: vi.fn(),
  updateWorkflow: (...a: unknown[]) => mockUpdateWorkflow(...a),
  workflowScheduleView: () => ({ expression: "0 9 * * 1" }),
}));

vi.mock("@/services/workflow-runner", () => ({ runWorkflowById: vi.fn() }));
vi.mock("@/services/workflow-secrets", () => ({
  WorkflowSecretError: class WorkflowSecretError extends Error {
    status = 400;
  },
  getWorkflowSecretAssignments: (...a: unknown[]) => mockGetWorkflowSecretAssignments(...a),
  listAssignedWorkflowSecrets: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

// A real-shaped gate: a permission the test did not grant is a 403.
let granted: string[] = [];
vi.mock("@/auth/permissions", () => ({
  requirePermission: (_c: unknown, permission: string) => {
    if (!granted.includes(permission)) {
      throw new HTTPException(403, { message: `Missing permission: ${permission}` });
    }
  },
}));

const workflows = (await import("@/api/routes/workflows")).default;

const MEMBER_WITHOUT_SECRETS = ["workflows:read", "workflows:write"];

function request(method: string, path: string, body?: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("organizationId", "org1");
    c.set("session", { userId: "editor-1", email: "editor@example.com" });
    await next();
  });
  app.route("/", workflows);
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** PUT the schedule sub-resource with an arbitrary JSON body. */
function putSchedule(body: unknown) {
  return request("PUT", "/wf1/schedule", body);
}

beforeEach(() => {
  vi.clearAllMocks();
  granted = [...MEMBER_WITHOUT_SECRETS];
  mockGetWorkflowSecretAssignments.mockResolvedValue([]);
  mockSetWorkflowSchedule.mockResolvedValue({ trigger: { kind: "cron" } });
  mockClearWorkflowSchedule.mockResolvedValue({ trigger: { kind: "manual" } });
  mockUpdateWorkflow.mockResolvedValue({ id: "wf1" });
  mockAssignWorkflowSecrets.mockResolvedValue([]);
});

describe("PUT /:id/schedule body validation", () => {
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
  // `computeSchedule` reads it as enabled: a disabled workflow with a live
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

/**
 * Who may change what a workflow runs, and who it then runs as. Automated
 * runs act for the last editor, so every write path must name the editor, and
 * the schedule (which is what makes a workflow run unattended) is a workflow
 * edit rather than dashboard content.
 */
describe("workflow edit authorization", () => {
  it("gates schedule writes on workflows:write, not dashboards:write", async () => {
    granted = ["dashboards:read", "dashboards:write"];
    expect((await putSchedule({ expression: "0 9 * * 1" })).status).toBe(403);
    expect((await request("DELETE", "/wf1/schedule")).status).toBe(403);
    expect(mockSetWorkflowSchedule).not.toHaveBeenCalled();
    expect(mockClearWorkflowSchedule).not.toHaveBeenCalled();
  });

  it("passes the editor to every write so automated runs act for them", async () => {
    await request("PUT", "/wf1", { source: "x" });
    expect(mockUpdateWorkflow).toHaveBeenCalledWith("org1", "wf1", { source: "x" }, "editor-1");

    await putSchedule({ expression: "0 9 * * 1" });
    expect(mockSetWorkflowSchedule).toHaveBeenCalledWith(
      "org1",
      "wf1",
      { expression: "0 9 * * 1" },
      "editor-1",
    );

    await request("DELETE", "/wf1/schedule");
    expect(mockClearWorkflowSchedule).toHaveBeenCalledWith("org1", "wf1", "editor-1");

    granted.push("secrets:read");
    await request("PUT", "/wf1/secrets", { secretIds: ["s1"] });
    expect(mockAssignWorkflowSecrets).toHaveBeenCalledWith("org1", "wf1", ["s1"], "editor-1");
  });

  it("requires secrets:read to edit a workflow that has secrets assigned", async () => {
    mockGetWorkflowSecretAssignments.mockResolvedValue(["s1"]);
    expect((await request("PUT", "/wf1", { source: "x" })).status).toBe(403);
    expect((await putSchedule({ expression: "0 9 * * 1" })).status).toBe(403);
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
    expect(mockSetWorkflowSchedule).not.toHaveBeenCalled();

    granted.push("secrets:read");
    expect((await request("PUT", "/wf1", { source: "x" })).status).toBe(200);
  });

  it("does not require secrets:read to edit a workflow without secrets", async () => {
    expect((await request("PUT", "/wf1", { source: "x" })).status).toBe(200);
  });
});
