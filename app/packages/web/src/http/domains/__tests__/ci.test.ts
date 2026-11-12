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
const mockOpenLogs = vi.fn();
const mockRetry = vi.fn();
const mockDownloadLink = vi.fn();
vi.mock("@infrawrench/server-core/ci/runs", () => ({
  openRunLogs: (...a: unknown[]) => mockOpenLogs(...a),
  CiInputError: FakeCiInputError,
  listRuns: (...a: unknown[]) => mockList(...a),
  getRun: vi.fn(),
  approveRun: (...a: unknown[]) => mockApprove(...a),
  rejectRun: (...a: unknown[]) => mockReject(...a),
  dispatchRun: (...a: unknown[]) => mockDispatch(...a),
  retryRun: (...a: unknown[]) => mockRetry(...a),
  getDownloadLink: (...a: unknown[]) => mockDownloadLink(...a),
}));
const mockListCaches = vi.fn();
const mockClearCache = vi.fn();
vi.mock("@infrawrench/server-core/ci/caches", () => ({
  listCiCaches: (...a: unknown[]) => mockListCaches(...a),
  clearCiCache: (...a: unknown[]) => mockClearCache(...a),
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

  it("relays a running run's live log as it comes, under ci:read", async () => {
    const frames =
      'event: pipeline-started\ndata: {"event":"pipeline-started","pipeline":"Test","jobs":[]}\n\n' +
      'event: job-started\ndata: {"event":"job-started","job":"a","name":"a"}\n\n';
    mockOpenLogs.mockResolvedValue(new Response(frames).body);
    const res = await app(["ci:read"]).request(`/runs/${RUN}/logs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // The proxy's frames, byte for byte: the clients parse the runner's framing.
    expect(await res.text()).toBe(frames);
    expect(mockOpenLogs).toHaveBeenCalledWith("org-1", RUN, expect.any(AbortSignal));

    const denied = await app([]).request(`/runs/${RUN}/logs`);
    expect(denied.status).toBe(403);

    mockOpenLogs.mockRejectedValue(
      new FakeCiInputError("The run is not running; its jobs' output is in the run.", 409),
    );
    const finished = await app().request(`/runs/${RUN}/logs`);
    expect(finished.status).toBe(409);
  });

  it("hands out a download link under ci:read, and says why it cannot", async () => {
    const link = {
      url: "https://ci-proxy.example/v1/artifacts/o/r/run/1-x?n=a.txt&e=1&s=x",
      expiresAt: "2026-11-12T10:15:00.000Z",
    };
    mockDownloadLink.mockResolvedValue(link);
    const q = new URLSearchParams({ job: "build[app/web]", path: "dist/report é.html" });
    const res = await app(["ci:read"]).request(`/runs/${RUN}/download?${q}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(link);
    expect(mockDownloadLink).toHaveBeenCalledWith(
      "org-1",
      RUN,
      "build[app/web]",
      "dist/report é.html",
    );

    expect((await app([]).request(`/runs/${RUN}/download?${q}`)).status).toBe(403);
    // Both are needed.
    expect((await app().request(`/runs/${RUN}/download?job=a`)).status).toBe(400);
    mockDownloadLink.mockRejectedValue(new FakeCiInputError("No such download in this run.", 404));
    expect((await app().request(`/runs/${RUN}/download?${q}`)).status).toBe(404);
    mockDownloadLink.mockRejectedValue(
      new FakeCiInputError("Downloads are not set up on this server.", 409),
    );
    const unset = await app().request(`/runs/${RUN}/download?${q}`);
    expect(unset.status).toBe(409);
    expect(await unset.json()).toEqual({ error: "Downloads are not set up on this server." });
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

  it("retries under ci:approve only, dispatching and auditing the new run", async () => {
    const RETRY = "33333333-3333-4333-8333-333333333333";
    const denied = await app(["ci:read", "ci:write"]).request(`/runs/${RUN}/retry`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(403);
    expect(mockRetry).not.toHaveBeenCalled();

    mockRetry.mockResolvedValue({
      id: RETRY,
      repoFullName: "acme/web",
      event: "push",
      headRef: "main",
      sha: "a".repeat(40),
      pullNumber: null,
      headRepoFullName: null,
      fromFork: false,
      actorLogin: "octo",
      status: "queued",
      statusReason: null,
      createdAt: "2026-11-12T10:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      jobs: null,
      vcpuSeconds: null,
      memoryGibSeconds: null,
      githubUrl: "https://github.com/acme/web/commit/" + "a".repeat(40),
      retryOfRunId: RUN,
      retriedAsRunId: null,
      noTaskCache: true,
    });
    const ok = await app(["ci:approve"]).request(`/runs/${RUN}/retry`, {
      method: "POST",
      body: JSON.stringify({ noTaskCache: true }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: RETRY, retryOfRunId: RUN, noTaskCache: true });
    expect(mockRetry).toHaveBeenCalledWith("org-1", RUN, "user-1", { noTaskCache: true });
    await settle();
    expect(mockDispatch).toHaveBeenCalledWith(RETRY);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ci.run.retry",
        entityId: RETRY,
        metadata: expect.objectContaining({ retryOf: RUN, noTaskCache: true }),
      }),
    );

    // A run waiting for approval is approved, not retried.
    mockRetry.mockRejectedValueOnce(
      new FakeCiInputError("This run is waiting for approval; approve it instead.", 409),
    );
    mockDispatch.mockClear();
    const waiting = await app().request(`/runs/${RUN}/retry`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(waiting.status).toBe(409);
    await settle();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("lists caches under ci:read and clears one under ci:write, audited", async () => {
    mockListCaches.mockResolvedValue({
      accounts: [
        {
          installationId: 7,
          accountLogin: "acme",
          usedBytes: 10,
          quotaBytes: null,
          repos: [{ repo: "web", bytes: 10, entries: 1 }],
          error: null,
        },
      ],
    });
    const list = await app(["ci:read"]).request("/caches");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ accounts: [{ repos: [{ repo: "web" }] }] });

    const denied = await app(["ci:read", "ci:approve"]).request("/caches/7/web", {
      method: "DELETE",
    });
    expect(denied.status).toBe(403);
    expect(mockClearCache).not.toHaveBeenCalled();

    mockClearCache.mockResolvedValue({
      installationId: 7,
      repo: "web",
      deletedEntries: 4,
      deletedBytes: 2048,
    });
    const ok = await app(["ci:write"]).request("/caches/7/Web", { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      installationId: 7,
      repo: "web",
      deletedEntries: 4,
      deletedBytes: 2048,
    });
    expect(mockClearCache).toHaveBeenCalledWith("org-1", 7, "Web");
    await settle();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ci.cache.clear",
        entityId: "7/web",
        metadata: expect.objectContaining({ repo: "web", deletedEntries: 4 }),
      }),
    );

    mockClearCache.mockRejectedValueOnce(new FakeCiInputError("Not the org's", 404));
    const missing = await app().request("/caches/8/web", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });

  it("answers the month's usage", async () => {
    const res = await app().request("/usage?month=2026-10");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ month: "2026-10", runs: 3 });
  });
});
