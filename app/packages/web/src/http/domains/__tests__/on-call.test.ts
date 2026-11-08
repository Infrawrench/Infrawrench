import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * The on-call routes only parse, gate and audit; the store is mocked (it
 * reaches the db client at import time). What is pinned here is the wire:
 * the hand checks' sentences, the store's refusals at their own status, and
 * the empty 204s.
 */
class OnCallInputError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  getSchedule: vi.fn(),
  listOverrides: vi.fn(),
  createOverride: vi.fn(),
  deleteSchedule: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@infrawrench/server-core/on-call/store", () => ({
  OnCallInputError,
  createOnCallOverride: (...a: unknown[]) => mocks.createOverride(...a),
  createOnCallSchedule: (...a: unknown[]) => mocks.create(...a),
  deleteOnCallOverride: vi.fn(async () => false),
  deleteOnCallSchedule: (...a: unknown[]) => mocks.deleteSchedule(...a),
  getOnCallSchedule: (...a: unknown[]) => mocks.getSchedule(...a),
  listOnCallOverrides: (...a: unknown[]) => mocks.listOverrides(...a),
  listOnCallSchedules: vi.fn(async () => []),
  resolveOnCallNow: vi.fn(),
  updateOnCallSchedule: (...a: unknown[]) => mocks.update(...a),
}));
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mocks.audit(...a) }));

const { onCallDomain } = await import("@/http/domains/on-call/index");
const basePath = "/api/org/org-1/on-call";
const app = (permissions?: string[]) =>
  buildTestApi(onCallDomain, { basePath, ...(permissions ? { permissions } : {}) });

const schedule = {
  id: "s1",
  name: "Primary",
  timezone: "Europe/London",
  rotationDays: 7,
  handoffTime: "09:00",
  startDate: "2026-08-03",
  participants: [{ userId: "u1", name: null, email: null }],
  enabled: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /on-call/schedules", () => {
  it("needs org:settings:write before reading the body", async () => {
    const res = await app(["team:read"]).request("/schedules", { method: "POST", body: "nope" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: org:settings:write" });
  });

  it("names the field a hand check refused", async () => {
    const res = await app().request("/schedules", {
      method: "POST",
      body: JSON.stringify({ name: "Primary", rotationDays: 1.5 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "rotationDays must be a whole number" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, or not an object", async () => {
    const notJson = await app().request("/schedules", { method: "POST", body: "{" });
    expect(await notJson.json()).toEqual({ error: "Invalid JSON body" });
    const array = await app().request("/schedules", { method: "POST", body: "[]" });
    expect(array.status).toBe(400);
    expect(await array.json()).toEqual({ error: "Request body must be an object" });
  });

  it("answers the store's refusal at its status and audits a creation", async () => {
    mocks.create.mockRejectedValueOnce(new OnCallInputError("Name taken", 409));
    const conflict = await app().request("/schedules", {
      method: "POST",
      body: JSON.stringify({ name: "Primary" }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "Name taken" });

    mocks.create.mockResolvedValueOnce(schedule);
    const res = await app().request("/schedules", {
      method: "POST",
      body: JSON.stringify({ name: "Primary", participantUserIds: ["u1"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(schedule);
    expect(mocks.create.mock.calls[1]![1]).toMatchObject({
      name: "Primary",
      participantUserIds: ["u1"],
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "on_call_schedule.create", entityId: "s1" }),
    );
  });
});

describe("PATCH /on-call/schedules/:scheduleId", () => {
  it("refuses an empty patch", async () => {
    const res = await app().request("/schedules/s1", { method: "PATCH", body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No changes supplied" });
  });
});

describe("GET /on-call/schedules/:scheduleId/shifts", () => {
  it("404s an unknown rotation", async () => {
    mocks.getSchedule.mockResolvedValue(null);
    const res = await app().request("/schedules/nope/shifts");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No such rotation" });
  });

  it("refuses a count out of range with the route's sentence", async () => {
    mocks.getSchedule.mockResolvedValue(schedule);
    const res = await app().request("/schedules/s1/shifts?count=61");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("count must be a whole number between 1 and 60");
  });

  it("previews the rotation with the covers beside it", async () => {
    mocks.getSchedule.mockResolvedValue(schedule);
    mocks.listOverrides.mockResolvedValue([]);
    const res = await app().request("/schedules/s1/shifts?count=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shifts: unknown[]; overrides: unknown[] };
    expect(body.shifts).toHaveLength(2);
    expect(body.overrides).toEqual([]);
  });
});

describe("DELETE /on-call/schedules/:scheduleId", () => {
  it("answers an empty 204 and audits", async () => {
    mocks.deleteSchedule.mockResolvedValue(true);
    const res = await app().request("/schedules/s1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "on_call_schedule.delete", entityId: "s1" }),
    );
  });
});

describe("POST /on-call/overrides", () => {
  it("is open to team:read, and names the first missing field", async () => {
    const res = await app(["team:read"]).request("/overrides", {
      method: "POST",
      body: JSON.stringify({ scheduleId: "s1", startsAt: "x" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "userId is required" });
  });
});
