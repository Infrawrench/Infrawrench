import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The services reach Postgres and ClickHouse; these tests are about the
// transport: the read/write gates, the event refusals' statuses, the delete's
// existence check, and the audit trail.
class FakeSavingsEventError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
class FakeRangeError extends Error {}
const events = {
  create: vi.fn(),
  update: vi.fn(),
  annotate: vi.fn(),
  remove: vi.fn(),
  row: vi.fn(),
};
vi.mock("@infrawrench/server-core/savings/events", () => ({
  SavingsEventError: FakeSavingsEventError,
  createManualSavingsEvent: (...a: unknown[]) => events.create(...a),
  updateManualSavingsEvent: (...a: unknown[]) => events.update(...a),
  annotateSavingsEvent: (...a: unknown[]) => events.annotate(...a),
  deleteSavingsEvent: (...a: unknown[]) => events.remove(...a),
  getSavingsEventRow: (...a: unknown[]) => events.row(...a),
}));
const mockReport = vi.fn();
vi.mock("@infrawrench/server-core/savings/realized", () => ({
  RealizedSavingsRangeError: FakeRangeError,
  getRealizedSavingsReport: (...a: unknown[]) => mockReport(...a),
}));
const settings = { get: vi.fn(), set: vi.fn() };
vi.mock("@infrawrench/server-core/savings/settings", () => ({
  getOrgSavingsSettings: (...a: unknown[]) => settings.get(...a),
  setOrgSavingsSettings: (...a: unknown[]) => settings.set(...a),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { savingsDomain } = await import("@/http/domains/savings/index");
const app = (permissions?: string[]) =>
  buildTestApi(savingsDomain, {
    basePath: "/api/org/org-1/savings",
    ...(permissions === undefined ? {} : { permissions }),
  });
const send = (method: string, path: string, body?: unknown, permissions?: string[]) =>
  app(permissions).request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const input = {
  title: "Turned off the old cluster",
  occurredOn: "2026-10-01",
  projectedMonthlyAmount: 120,
  currency: "USD",
};
const event = { id: "e1", kind: "manual", title: input.title, occurredOn: "2026-10-01" };
const tuning = { horizonMonths: 12, shortfallThresholdPercent: 70, baselineWindowDays: 14 };

beforeEach(() => {
  vi.clearAllMocks();
  events.create.mockResolvedValue(event);
  events.update.mockResolvedValue(event);
  events.annotate.mockResolvedValue(event);
  events.remove.mockResolvedValue(event);
  events.row.mockResolvedValue({ id: "e1" });
  mockReport.mockResolvedValue({ from: "2026-01-01", to: "2026-10-31", events: [] });
  settings.get.mockResolvedValue(tuning);
  settings.set.mockImplementation((_org: string, s: unknown) => Promise.resolve(s));
});

describe("GET /savings/realized", () => {
  it("needs costs:read, treats an empty bound as the default, and 400s a bad range", async () => {
    expect((await send("GET", "/realized", undefined, ["resources:read"])).status).toBe(403);
    expect((await send("GET", "/realized?from=&to=2026-10-31")).status).toBe(200);
    expect(mockReport).toHaveBeenCalledWith("org-1", { from: undefined, to: "2026-10-31" });
    mockReport.mockRejectedValueOnce(new FakeRangeError("from is after to"));
    const res = await send("GET", "/realized?from=2026-11-01&to=2026-10-01");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "from is after to" });
  });
});

describe("/savings/events", () => {
  it("needs costs:write to log a saving", async () => {
    expect((await send("POST", "/events", input, ["costs:read"])).status).toBe(403);
    expect(events.create).not.toHaveBeenCalled();
  });

  it("logs a saving, passing the user, and audits it", async () => {
    const res = await send("POST", "/events", input);
    expect(res.status).toBe(200);
    expect(events.create).toHaveBeenCalledWith("org-1", input, "user-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "savings_event.create", entityId: "e1" }),
    );
  });

  it("refuses an invalid body before the service, with the route's sentence", async () => {
    const res = await send("POST", "/events", { ...input, currency: "dollars" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid saving" });
    expect(events.create).not.toHaveBeenCalled();
  });

  it("answers a service refusal with the status it carries", async () => {
    events.update.mockRejectedValueOnce(new FakeSavingsEventError("Saving not found", 404));
    const missing = await send("PUT", "/events/e9", input);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Saving not found" });
    events.annotate.mockRejectedValueOnce(new FakeSavingsEventError("The end date is before"));
    const bad = await send("PATCH", "/events/e1", { endedOn: "2026-01-01" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "The end date is before" });
  });

  it("audits the fields an annotation touched", async () => {
    await send("PATCH", "/events/e1", { note: "approved by finance" });
    expect(events.annotate).toHaveBeenCalledWith("org-1", "e1", { note: "approved by finance" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "savings_event.update",
        metadata: { kind: "manual", fields: ["note"] },
      }),
    );
  });

  it("404s deleting a saving that does not exist, and deletes one that does", async () => {
    events.row.mockResolvedValueOnce(null);
    const missing = await send("DELETE", "/events/e9");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Saving not found" });
    expect(events.remove).not.toHaveBeenCalled();
    const res = await send("DELETE", "/events/e1");
    expect(await res.json()).toEqual({ ok: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "savings_event.delete", entityId: "e1" }),
    );
  });
});

describe("/savings/settings", () => {
  it("reads with costs:read and writes with costs:write", async () => {
    expect(await (await send("GET", "/settings", undefined, ["costs:read"])).json()).toEqual(
      tuning,
    );
    expect((await send("PUT", "/settings", tuning, ["costs:read"])).status).toBe(403);
    const res = await send("PUT", "/settings", { ...tuning, horizonMonths: 6 });
    expect(res.status).toBe(200);
    expect(settings.set).toHaveBeenCalledWith("org-1", { ...tuning, horizonMonths: 6 });
  });

  it("refuses out-of-range tuning", async () => {
    const res = await send("PUT", "/settings", { ...tuning, horizonMonths: 0 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid savings settings" });
  });
});
