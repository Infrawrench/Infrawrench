import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The loaders, settings and recorder reach Postgres; these tests are about
// the transport: the hand-read query, the picked bodies and their sentences.
class FakeDoraQueryError extends Error {}
class FakeDoraSettingsError extends Error {}
class FakeDoraInputError extends Error {}
const mockReport = vi.fn();
const mockChanges = vi.fn();
vi.mock("@infrawrench/server-core/dora/load", () => ({
  DoraQueryError: FakeDoraQueryError,
  getDoraReport: (...a: unknown[]) => mockReport(...a),
  listDoraChanges: (...a: unknown[]) => mockChanges(...a),
  listDoraRestores: vi.fn(async () => []),
}));
const mockUpdateSettings = vi.fn();
vi.mock("@infrawrench/server-core/dora/settings", () => ({
  DoraSettingsError: FakeDoraSettingsError,
  getDoraSettings: vi.fn(),
  updateDoraSettings: (...a: unknown[]) => mockUpdateSettings(...a),
}));
const mockRecord = vi.fn();
vi.mock("@infrawrench/server-core/dora/record", () => ({
  DoraInputError: FakeDoraInputError,
  recordApiDeployEvent: (...a: unknown[]) => mockRecord(...a),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { doraDomain } = await import("@/http/domains/dora/index");
const basePath = "/api/org/org-1/dora";
const app = (permissions?: string[]) =>
  buildTestApi(doraDomain, { basePath, ...(permissions ? { permissions } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DORA routes", () => {
  it("reads the window, bucket, scope and breakdown from the query", async () => {
    mockReport.mockResolvedValue({});
    const res = await app().request(
      "/?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&bucket=week&dimension=owner&groupBy=repository",
    );
    expect(res.status).toBe(200);
    expect(mockReport).toHaveBeenCalledWith("org-1", {
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-11-01T00:00:00Z"),
      bucket: "week",
      filter: { dimension: "owner", value: null },
      groupBy: "repository",
    });
  });

  it("refuses a bad window or bucket in the route's words", async () => {
    const to = await app().request("/?to=yesterday");
    expect(to.status).toBe(400);
    expect(await to.json()).toEqual({ error: "to must be an ISO 8601 timestamp" });
    const bucket = await app().request("/?bucket=month");
    expect(await bucket.json()).toEqual({ error: "bucket must be day or week" });
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("treats any failedOnly but true as every change", async () => {
    mockChanges.mockResolvedValue({ changes: [], truncated: false });
    await app().request("/changes?failedOnly=1");
    expect(mockChanges.mock.calls[0]![1]).toMatchObject({ failedOnly: false });
  });

  it("answers a loader refusal as 400 and anything else as the route's 500", async () => {
    mockReport.mockRejectedValueOnce(new FakeDoraQueryError("The window is too long"));
    const refused = await app().request("/");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "The window is too long" });
    mockReport.mockRejectedValueOnce(new Error("boom"));
    const failed = await app().request("/");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Delivery metrics failed" });
  });

  it("updates the settings under org:settings:write, refusing wrong types", async () => {
    const denied = await app(["deployments:read"]).request("/settings", {
      method: "PUT",
      body: "{}",
    });
    expect(denied.status).toBe(403);
    const bad = await app().request("/settings", {
      method: "PUT",
      body: JSON.stringify({ pipelinePatterns: [1] }),
    });
    expect(await bad.json()).toEqual({ error: "pipelinePatterns must be a list of strings" });
    mockUpdateSettings.mockResolvedValue({ failureWindowHours: 48 });
    const ok = await app().request("/settings", {
      method: "PUT",
      body: JSON.stringify({ failureWindowHours: 48, digestEnabled: false }),
    });
    expect(ok.status).toBe(200);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      "org-1",
      { failureWindowHours: 48, digestEnabled: false },
      "user-1",
    );
  });

  it("records a deploy, leaving presence and format checks to the recorder", async () => {
    mockRecord.mockResolvedValue({ id: "d1" });
    const res = await app().request("/deployments", {
      method: "POST",
      body: JSON.stringify({
        externalId: "build-9",
        name: "api",
        environment: "production",
        deployedAt: "2026-11-08T10:00:00Z",
        commitSha: null,
        isRollback: true,
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "d1" });
    expect(mockRecord).toHaveBeenCalledWith("org-1", {
      externalId: "build-9",
      name: "api",
      environment: "production",
      deployedAt: "2026-11-08T10:00:00Z",
      commitSha: null,
      isRollback: true,
    });
    mockRecord.mockRejectedValueOnce(new FakeDoraInputError("externalId is required"));
    const missing = await app().request("/deployments", { method: "POST", body: "{}" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "externalId is required" });
    expect(mockRecord.mock.calls[1]![1]).toMatchObject({ externalId: "" });
  });

  it("refuses a bad status or a wrong-typed field in the recorder's words", async () => {
    const status = await app().request("/deployments", {
      method: "POST",
      body: JSON.stringify({ status: "done" }),
    });
    expect(await status.json()).toEqual({
      error: "status must be one of success, failure, in_progress, canceled",
    });
    const typed = await app().request("/deployments", {
      method: "POST",
      body: JSON.stringify({ externalId: 9 }),
    });
    expect(await typed.json()).toEqual({ error: "externalId must be a string" });
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
