import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

class FakeComplianceInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

const mockBuildPack = vi.fn();
const mockStatus = vi.fn();
const mockCreateSchedule = vi.fn();
const mockGetSetting = vi.fn();
vi.mock("@infrawrench/server-core/compliance/settings", () => ({
  ComplianceInputError: FakeComplianceInputError,
  deleteComplianceControlSetting: vi.fn(),
  getComplianceControlSetting: (...a: unknown[]) => mockGetSetting(...a),
  listComplianceControlSettings: vi.fn(async () => []),
  putComplianceControlSetting: vi.fn(),
}));
vi.mock("@infrawrench/server-core/compliance/status", () => ({
  getComplianceStatus: (...a: unknown[]) => mockStatus(...a),
  requireFramework: (id: string) => {
    if (id !== "soc2") throw new FakeComplianceInputError("Unknown framework", 404);
  },
}));
vi.mock("@infrawrench/server-core/compliance/pack", () => ({
  buildEvidencePack: (...a: unknown[]) => mockBuildPack(...a),
}));
vi.mock("@infrawrench/server-core/compliance/schedules", () => ({
  createCompliancePackSchedule: (...a: unknown[]) => mockCreateSchedule(...a),
  deleteCompliancePackSchedule: vi.fn(),
  getCompliancePackScheduleRow: vi.fn(),
  listCompliancePackSchedules: vi.fn(async () => []),
  sendCompliancePackScheduleNow: vi.fn(),
  toCompliancePackScheduleView: (r: unknown) => r,
  updateCompliancePackSchedule: vi.fn(),
}));
vi.mock("@infrawrench/server-core/report-delivery/store", () => ({
  ReportNotificationInputError: class extends Error {},
  listReportDeliveryTargets: vi.fn(),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { complianceDomain } = await import("@/http/domains/compliance/index");
const basePath = "/api/org/org-1/compliance";
const app = (permissions?: readonly string[]) =>
  buildTestApi(complianceDomain, { basePath, ...(permissions ? { permissions } : {}) });

beforeEach(() => vi.clearAllMocks());

describe("compliance routes", () => {
  it("serves the evidence pack as a ZIP attachment and audits it", async () => {
    mockBuildPack.mockResolvedValue({
      bytes: Buffer.from([0x50, 0x4b, 3, 4]),
      filename: "soc2-evidence.zip",
      manifest: { framework: { id: "soc2" }, files: [{}, {}] },
    });
    const res = await app(["audit:read"]).request(
      "/pack?framework=soc2&from=2026-07-01&to=2026-09-30",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="soc2-evidence.zip"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]));
    expect(mockBuildPack.mock.calls[0]![2]).toMatchObject({
      period: { from: "2026-07-01", to: "2026-09-30" },
      generatedBy: "test@example.com",
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "compliance.pack_exported" }),
    );
  });

  it("refuses a bad period and passes the caller's permissions to each source", async () => {
    expect((await app().request("/?framework=soc2&from=nope")).status).toBe(400);
    mockStatus.mockResolvedValue({ controls: [] });
    await app(["audit:read"]).request("/?framework=soc2");
    const { canRead } = mockStatus.mock.calls[0]![2];
    expect(canRead("audit:read")).toBe(true);
    expect(canRead("resources:read")).toBe(false);
  });

  it("answers store refusals with their status", async () => {
    const res = await app().request("/controls?framework=nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown framework" });
    mockGetSetting.mockResolvedValue(null);
    const missing = await app().request("/controls/soc2/CC6.1");
    expect(await missing.json()).toEqual({ error: "No decision is stored for this control" });
  });

  it("checks a schedule body by hand and creates with 201", async () => {
    const bad = await app().request("/schedules", {
      method: "POST",
      body: JSON.stringify({ frameworkId: "soc2", cadence: "weekly" }),
    });
    expect(await bad.json()).toEqual({ error: 'cadence must be "monthly" or "quarterly"' });
    mockCreateSchedule.mockResolvedValue({
      id: "s1",
      frameworkId: "soc2",
      cadence: "monthly",
      emailRecipients: ["a@example.com"],
    });
    const body = {
      frameworkId: "soc2",
      cadence: "monthly",
      hour: 9,
      timezone: "UTC",
      enabled: true,
      emailRecipients: ["a@example.com"],
    };
    const res = await app().request("/schedules", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(201);
    expect(mockCreateSchedule.mock.calls[0]![1]).toEqual({
      ...body,
      sendDayOfMonth: undefined,
      slackChannelIds: [],
      teamsWebhookIds: [],
    });
  });
});
