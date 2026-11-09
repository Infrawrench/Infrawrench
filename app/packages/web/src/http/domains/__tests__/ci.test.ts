import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The CI store reaches Postgres, the runner pool and GitHub; these tests are
// about the door: the feature gate, the permissions, the refusals and the
// audit trail of approvals.
class FakeCiInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}
const mockHasFeature = vi.fn();
vi.mock("@infrawrench/server-core/features", () => ({
  orgHasFeature: (...a: unknown[]) => mockHasFeature(...a),
}));
const mockStatus = vi.fn();
const mockSetAccount = vi.fn();
vi.mock("@infrawrench/server-core/ci/accounts", () => ({
  ciStatus: (...a: unknown[]) => mockStatus(...a),
  setCiAccount: (...a: unknown[]) => mockSetAccount(...a),
}));
vi.mock("@infrawrench/server-core/ci/billing", () => ({
  ciUsage: vi.fn(async (_org: string, month?: string) => ({
    month: month ?? "2026-11",
    runs: 3,
    vcpuSeconds: 120,
    memoryGibSeconds: 60,
    storageGibHours: 1.5,
    storageBytes: null,
  })),
}));
const mockList = vi.fn();
const mockApprove = vi.fn();
const mockReject = vi.fn();
const mockDispatch = vi.fn();
vi.mock("@infrawrench/server-core/ci/runs", () => ({
  CiInputError: FakeCiInputError,
  listRuns: (...a: unknown[]) => mockList(...a),
  getRun: vi.fn(),
  approveRun: (...a: unknown[]) => mockApprove(...a),
  rejectRun: (...a: unknown[]) => mockReject(...a),
  dispatchRun: (...a: unknown[]) => mockDispatch(...a),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { ciDomain } = await import("@/http/domains/ci/index");
const basePath = "/api/org/org-1/ci";
const app = (permissions?: string[]) =>
  buildTestApi(ciDomain, { basePath, ...(permissions ? { permissions } : {}) });
const RUN = "11111111-1111-4111-8111-111111111111";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockHasFeature.mockResolvedValue(true);
});

describe("CI routes", () => {
  it("answers the status whether or not CI is on", async () => {
    mockHasFeature.mockResolvedValue(false);
    mockStatus.mockResolvedValue({
      enabled: false,
      configured: true,
      githubConfigured: true,
      planIncludesCi: true,
      accounts: [],
    });
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false });
  });

  it("is a 404 everywhere else until CI is turned on for the org", async () => {
    mockHasFeature.mockResolvedValue(false);
    const runs = await app().request("/runs");
    expect(runs.status).toBe(404);
    const approve = await app().request(`/runs/${RUN}/approve`, { method: "POST" });
    expect(approve.status).toBe(404);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("reads the list's status and limit as sent", async () => {
    mockList.mockResolvedValue([]);
    await app().request("/runs?status=awaiting_approval&limit=5");
    expect(mockList).toHaveBeenLastCalledWith("org-1", { limit: 5, status: "awaiting_approval" });
    await app().request("/runs?status=bogus&limit=many");
    expect(mockList).toHaveBeenLastCalledWith("org-1", { limit: 50 });
    await app().request("/runs?limit=100000");
    expect(mockList).toHaveBeenLastCalledWith("org-1", { limit: 200 });
  });

  it("approves under ci:approve only, then dispatches and audits", async () => {
    const denied = await app(["ci:read", "ci:write"]).request(`/runs/${RUN}/approve`, {
      method: "POST",
    });
    expect(denied.status).toBe(403);
    expect(mockApprove).not.toHaveBeenCalled();

    mockApprove.mockResolvedValue(undefined);
    const ok = await app().request(`/runs/${RUN}/approve`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith("org-1", RUN, "user-1");
    await settle();
    expect(mockDispatch).toHaveBeenCalledWith(RUN);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ci.run.approve", entityId: RUN }),
    );
  });

  it("answers a decision on a run that is not waiting as 409", async () => {
    mockReject.mockRejectedValue(
      new FakeCiInputError("This run is not waiting for approval.", 409),
    );
    const res = await app().request(`/runs/${RUN}/reject`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This run is not waiting for approval." });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("switches an account under ci:write, refusing one that is not the org's", async () => {
    const denied = await app(["ci:read"]).request("/accounts/7", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(denied.status).toBe(403);

    mockSetAccount.mockRejectedValueOnce(new FakeCiInputError("Not connected", 404));
    const missing = await app().request("/accounts/8", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);

    mockSetAccount.mockResolvedValue({
      installationId: 7,
      accountLogin: "acme",
      accountType: "Organization",
      ciEnabled: true,
    });
    const ok = await app().request("/accounts/7", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(ok.status).toBe(200);
    expect(mockSetAccount).toHaveBeenLastCalledWith("org-1", 7, true, "user-1");
  });

  it("answers the month's usage", async () => {
    const res = await app().request("/usage?month=2026-10");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ month: "2026-10", runs: 3 });
  });
});
