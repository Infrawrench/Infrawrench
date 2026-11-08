import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

/** The runbook routes' wire: hand checks' sentences, the optional run body, the store's statuses. */
class RunbookInputError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  start: vi.fn(),
  list: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@infrawrench/server-core/runbooks/store", () => ({
  RunbookInputError,
  createRunbook: (...a: unknown[]) => mocks.create(...a),
  deleteRunbook: vi.fn(),
  getRunbook: vi.fn(),
  listRunbooks: vi.fn(async () => []),
  updateRunbook: vi.fn(),
}));
vi.mock("@infrawrench/server-core/runbooks/runs", () => ({
  closeRunbookRun: vi.fn(),
  getRunbookRun: vi.fn(),
  listRunbookRuns: (...a: unknown[]) => mocks.list(...a),
  startRunbookRun: (...a: unknown[]) => mocks.start(...a),
  updateRunbookRunStep: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mocks.audit(...a) }));

const { runbooksDomain } = await import("@/http/domains/runbooks/index");
const app = (permissions?: string[]) =>
  buildTestApi(runbooksDomain, {
    basePath: "/api/org/org-1/runbooks",
    ...(permissions ? { permissions } : {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /runbooks", () => {
  it("needs a name, then names a malformed step", async () => {
    const noName = await app().request("/", { method: "POST", body: "{}" });
    expect(await noName.json()).toEqual({ error: "name is required" });
    const badStep = await app().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "Failover", steps: [{ kind: "shell", title: "x" }] }),
    });
    expect(badStep.status).toBe(400);
    expect(await badStep.json()).toEqual({
      error: "Each step's kind must be manual, workflow or link",
    });
  });

  it("answers a duplicate name with the store's 409", async () => {
    mocks.create.mockRejectedValue(new RunbookInputError("Name taken", 409));
    const res = await app().request("/", { method: "POST", body: JSON.stringify({ name: "F" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Name taken" });
  });
});

describe("POST /runbooks/:runbookId/runs", () => {
  it("starts with resources:read and no body at all", async () => {
    mocks.start.mockResolvedValue({ id: "r1", runbookName: "F", incidentId: null });
    const res = await app(["resources:read"]).request("/rb1/runs", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ runbookId: "rb1", incidentId: null }),
    );
  });

  it("attaches the run to the incident named in the body", async () => {
    mocks.start.mockResolvedValue({ id: "r1", runbookName: "F", incidentId: "i1" });
    await app().request("/rb1/runs", {
      method: "POST",
      body: JSON.stringify({ incidentId: "i1" }),
    });
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ incidentId: "i1" }));
  });
});

describe("GET /runbooks/runs", () => {
  it("is not read as a runbook id, and passes the limit through", async () => {
    mocks.list.mockResolvedValue([]);
    const res = await app().request("/runs?limit=5&runbookId=rb1");
    expect(res.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("org-1", { runbookId: "rb1", limit: 5 });
  });

  it("refuses a limit out of range with the route's sentence", async () => {
    const res = await app().request("/runs?limit=500");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("limit must be a whole number between 1 and 200");
  });
});
