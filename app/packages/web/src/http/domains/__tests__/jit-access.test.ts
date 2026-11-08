import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

class FakeJitAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const mockCreatePolicy = vi.fn();
const mockCreateRequest = vi.fn();
const mockDecide = vi.fn();
vi.mock("@infrawrench/server-core/jit-access/service", () => ({
  JitAccessError: FakeJitAccessError,
  loadJitCaller: vi.fn(async (_org: string, userId: string) => ({
    userId,
    name: null,
    email: null,
  })),
  createJitPolicy: (...a: unknown[]) => mockCreatePolicy(...a),
  updateJitPolicy: vi.fn(),
  createJitRequest: (...a: unknown[]) => mockCreateRequest(...a),
  decideJitRequest: (...a: unknown[]) => mockDecide(...a),
  cancelJitRequest: vi.fn(),
  deleteJitPolicy: vi.fn(),
  extendJitRequest: vi.fn(),
  getJitPolicy: vi.fn(),
  getJitRequest: vi.fn(),
  listJitAccounts: vi.fn(async () => []),
  listJitPolicies: vi.fn(async () => []),
  listJitPrincipalsForPolicy: vi.fn(),
  listJitRequests: vi.fn(async () => []),
  listJitRoleOptions: vi.fn(),
  listJitScopeOptions: vi.fn(),
  resolveJitPrincipalForCaller: vi.fn(),
  revokeJitRequest: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const { jitAccessDomain } = await import("@/http/domains/jit-access/index");
const buildApp = () => buildTestApi(jitAccessDomain, { basePath: "/api/org/org-1/jit-access" });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  buildApp().request(path, { method: "POST", headers, body: JSON.stringify(body) });

const policyBody = {
  name: "  Prod admin  ",
  accountId: "acc-1",
  targets: [{ scopeId: "s", scopeName: "S", roleId: "r", roleName: "R" }],
  maxDurationMinutes: 60,
  approverUserIds: ["user-2"],
};

beforeEach(() => vi.clearAllMocks());

describe("just-in-time access routes", () => {
  it("trims the policy name and answers 201", async () => {
    mockCreatePolicy.mockResolvedValue({ id: "p1", name: "Prod admin", targets: [] });
    const res = await post("/policies", policyBody);
    expect(res.status).toBe(201);
    expect(mockCreatePolicy.mock.calls[0]![1]).toMatchObject({ name: "Prod admin" });
  });

  it("refuses a blank name, an unknown key and a nested unknown key", async () => {
    for (const body of [
      { ...policyBody, name: "   " },
      { ...policyBody, colour: "red" },
      { ...policyBody, targets: [{ ...policyBody.targets[0], extra: true }] },
      { ...policyBody, maxDurationMinutes: 721 },
    ]) {
      const res = await post("/policies", body);
      expect(res.status).toBe(400);
      expect(Object.keys(await res.json())).toEqual(["error"]);
    }
    expect(mockCreatePolicy).not.toHaveBeenCalled();
  });

  it("passes the service's refusal through with its status and code", async () => {
    mockCreateRequest.mockRejectedValue(
      new FakeJitAccessError("Already covered", 409, "duplicate"),
    );
    const res = await post("/requests", {
      policyId: "p1",
      scopeId: "s",
      roleId: "r",
      durationMinutes: 30,
      reason: "on call",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Already covered", code: "duplicate" });
  });

  it("says which app a decision came from", async () => {
    mockDecide.mockResolvedValue({ id: "q1" });
    await post("/requests/q1/approve", {}, { "x-infrawrench-client": "cli" });
    expect(mockDecide.mock.calls[0]![4]).toEqual({ note: null, via: "the CLI" });
    await post("/requests/q1/deny", { note: "no" }, { authorization: "Bearer x" });
    expect(mockDecide.mock.calls[1]![4]).toEqual({
      note: "no",
      via: "a signed-in app (desktop, mobile or the CLI)",
    });
  });

  it("requires scopeId for the role picker", async () => {
    const res = await buildApp().request("/accounts/acc-1/roles");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "scopeId is required" });
  });
});
