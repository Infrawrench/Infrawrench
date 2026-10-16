import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockList = vi.fn();
const mockCancel = vi.fn();
const mockOpen = vi.fn();
const mockKick = vi.fn();

class MockCostExportJobError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

vi.mock("../../../services/cost-export-jobs", () => ({
  CostExportJobError: MockCostExportJobError,
  createCostExportJob: (...args: unknown[]) => mockCreate(...args),
  getCostExportJob: (...args: unknown[]) => mockGet(...args),
  listCostExportJobs: (...args: unknown[]) => mockList(...args),
  cancelCostExportJob: (...args: unknown[]) => mockCancel(...args),
  openCostExportJobFile: (...args: unknown[]) => mockOpen(...args),
}));
vi.mock("../../../services/cost-export-job-loop", () => ({
  kickCostExportJobLoop: () => mockKick(),
}));
vi.mock("../../../auth/cost-visibility", () => ({
  contextPrincipal: (c: { get(key: "session"): { userId: string } }) => ({
    userId: c.get("session").userId,
    apiKeyId: null,
    agentRegistrationId: null,
  }),
}));

const { costExportJobRoutes } = await import("@/api/routes/cost-export-jobs");

const job = {
  id: "job-1",
  status: "queued",
  format: "csv",
  focusVersion: null,
  from: "2026-01-01",
  to: "2026-03-31",
  source: { kind: "report", reportId: "r1", reportName: "Prod", unitCostMetric: null },
  progress: 0,
  rowCount: 0,
  byteCount: 0,
  error: null,
  fileName: "costs-prod-2026-01-01-to-2026-03-31.csv",
  contentType: "text/csv; charset=utf-8",
  createdAt: "2026-04-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  expiresAt: null,
  downloadUrl: null,
};

const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(job);
  mockGet.mockResolvedValue(job);
  mockList.mockResolvedValue([job]);
  mockCancel.mockResolvedValue({ ...job, status: "cancelled" });
});

describe("POST /costs/exports/jobs", () => {
  it("rejects without costs:read", async () => {
    const app = buildTestApp(costExportJobRoutes, ["dashboards:read"]);
    const res = await app.request("/exports/jobs", post({ reportId: "r1", format: "csv" }));
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("queues the job as the caller, answers 202 and kicks the loop", async () => {
    const res = await buildTestApp(costExportJobRoutes).request(
      "/exports/jobs",
      post({ reportId: "r1", format: "focus", focusVersion: "1.4" }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ id: "job-1", status: "queued" });
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ userId: "user-1" }),
      { reportId: "r1", format: "focus", focusVersion: "1.4" },
    );
    expect(mockKick).toHaveBeenCalledOnce();
  });

  it("refuses an unknown format before reaching the service", async () => {
    const res = await buildTestApp(costExportJobRoutes).request(
      "/exports/jobs",
      post({ reportId: "r1", format: "xlsx" }),
    );
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps the service's refusals to their status", async () => {
    mockCreate.mockRejectedValueOnce(new MockCostExportJobError("three running", 409));
    const res = await buildTestApp(costExportJobRoutes).request(
      "/exports/jobs",
      post({ reportId: "r1", format: "csv" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "three running" });
  });
});

describe("GET /costs/exports/jobs…", () => {
  it("lists the caller's jobs", async () => {
    const res = await buildTestApp(costExportJobRoutes).request("/exports/jobs");
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("org-1", "user-1");
    expect((await res.json()).jobs).toHaveLength(1);
  });

  it("reads one job, and someone else's as not found", async () => {
    const ok = await buildTestApp(costExportJobRoutes).request("/exports/jobs/job-1");
    expect(ok.status).toBe(200);
    expect(mockGet).toHaveBeenCalledWith("org-1", "user-1", "job-1");
    mockGet.mockResolvedValueOnce(null);
    const missing = await buildTestApp(costExportJobRoutes).request("/exports/jobs/job-2");
    expect(missing.status).toBe(404);
  });

  it("streams a finished file with its name and type", async () => {
    const encoder = new TextEncoder();
    mockOpen.mockResolvedValue({
      job: { ...job, status: "succeeded", byteCount: 12 },
      chunks: (async function* () {
        yield encoder.encode("day,amount\n");
        yield encoder.encode("x\n");
      })(),
    });
    const res = await buildTestApp(costExportJobRoutes).request("/exports/jobs/job-1/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(job.fileName);
    expect(await res.text()).toBe("day,amount\nx\n");
  });

  it("answers 409 while a job is running and 410 once its file is gone", async () => {
    mockOpen.mockResolvedValue(null);
    mockGet.mockResolvedValueOnce({ ...job, status: "running" });
    const running = await buildTestApp(costExportJobRoutes).request("/exports/jobs/job-1/download");
    expect(running.status).toBe(409);
    mockGet.mockResolvedValueOnce({ ...job, status: "expired" });
    const gone = await buildTestApp(costExportJobRoutes).request("/exports/jobs/job-1/download");
    expect(gone.status).toBe(410);
  });
});

describe("DELETE /costs/exports/jobs/:jobId", () => {
  it("cancels the caller's job", async () => {
    const res = await buildTestApp(costExportJobRoutes).request("/exports/jobs/job-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(mockCancel).toHaveBeenCalledWith("org-1", "user-1", "job-1");
    expect((await res.json()).status).toBe("cancelled");
  });
});
