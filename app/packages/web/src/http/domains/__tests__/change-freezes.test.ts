import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The body is decoded as the route's zod schema did: strict, bounded, and
// with zod's `datetime({ offset: true })` timestamps, all answering the one
// sentence "Invalid freeze window".
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@/services/audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@/services/change-freezes", () => ({
  createChangeFreeze: (...args: unknown[]) => mockCreate(...args),
  updateChangeFreeze: (...args: unknown[]) => mockUpdate(...args),
  deleteChangeFreeze: vi.fn(async () => false),
  endChangeFreeze: vi.fn(async () => null),
  getActiveChangeFreeze: vi.fn(async () => null),
  listChangeFreezes: vi.fn(async () => []),
}));

const { changeFreezesDomain } = await import("@/http/domains/change-freezes/index");
const buildApp = () =>
  buildTestApi(changeFreezesDomain, { basePath: "/api/org/org-1/change-freezes" });

const row = {
  id: "f1",
  organizationId: "org-1",
  name: "Launch",
  reason: null,
  startsAt: new Date("2030-01-01T00:00:00.000Z"),
  endsAt: null,
  active: true,
  createdByUserId: "user-1",
  endedByUserId: null,
  createdAt: new Date("2029-12-01T00:00:00.000Z"),
  updatedAt: new Date("2029-12-01T00:00:00.000Z"),
};

const post = (body: unknown) =>
  buildApp().request("/", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(row);
});

describe("change freeze routes", () => {
  it("creates a freeze from an offset timestamp and answers the wire shape", async () => {
    const res = await post({ name: "Launch", startsAt: "2030-01-01T00:00:00+02:00" });
    expect(res.status).toBe(200);
    expect(mockCreate.mock.calls[0]![1]).toEqual({
      name: "Launch",
      startsAt: new Date("2030-01-01T00:00:00+02:00"),
    });
    expect(await res.json()).toEqual({
      id: "f1",
      name: "Launch",
      reason: null,
      startsAt: "2030-01-01T00:00:00.000Z",
      endsAt: null,
      active: true,
      createdByUserId: "user-1",
      endedByUserId: null,
      createdAt: "2029-12-01T00:00:00.000Z",
      updatedAt: "2029-12-01T00:00:00.000Z",
    });
  });

  it.each([
    ["an unknown key", { name: "Launch", extra: true }],
    ["an empty name", { name: "" }],
    ["a name over 120 characters", { name: "x".repeat(121) }],
    ["a timestamp without an offset", { name: "Launch", startsAt: "2030-01-01T00:00:00" }],
    ["a date that does not exist", { name: "Launch", startsAt: "2030-02-30T00:00:00Z" }],
  ])("refuses %s with the route's sentence", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid freeze window");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a window that ends before it starts", async () => {
    const res = await post({
      name: "Launch",
      startsAt: "2030-01-02T00:00:00Z",
      endsAt: "2030-01-01T00:00:00Z",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "endsAt must be after startsAt" });
  });

  it("answers 404 for an update to a missing freeze", async () => {
    mockUpdate.mockResolvedValue(null);
    const res = await buildApp().request("/f9", {
      method: "PUT",
      body: JSON.stringify({ name: "Launch" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("checks freezes:write before reading the body", async () => {
    const app = buildTestApi(changeFreezesDomain, {
      basePath: "/api/org/org-1/change-freezes",
      permissions: ["freezes:read"],
    });
    const res = await app.request("/", { method: "POST", body: "not json" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: freezes:write" });
  });
});
