import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The break-glass service reaches Postgres; these tests are about the
// transport: the body rules the Zod schemas enforced, the refusal bodies, and
// that every decision is audited before the response.
const mockCreate = vi.fn();
const mockDecide = vi.fn();
const mockGet = vi.fn();
const mockRevoke = vi.fn();
vi.mock("@infrawrench/server-core/access/break-glass", () => ({
  MIN_GRANT_MINUTES: 5,
  MAX_GRANT_MINUTES: 480,
  createAccessRequest: (...a: unknown[]) => mockCreate(...a),
  decideAccessRequest: (...a: unknown[]) => mockDecide(...a),
  getAccessRequest: (...a: unknown[]) => mockGet(...a),
  listAccessRequests: vi.fn(async () => []),
  revokeAccessGrant: (...a: unknown[]) => mockRevoke(...a),
  withdrawAccessRequest: vi.fn(),
}));
vi.mock("@infrawrench/server-core/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ displayName: "Ada", email: "a@b.c" }] }),
      }),
    }),
  },
}));
const mockAudit = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockAudit(...a) }));

const { accessRequestsDomain } = await import("@/http/domains/access-requests/index");
const basePath = "/api/org/org-1/access-requests";
const buildApp = (permissions?: string[]) =>
  buildTestApi(accessRequestsDomain, { basePath, ...(permissions ? { permissions } : {}) });

const post = (path: string, body?: unknown, permissions?: string[]) =>
  buildApp(permissions).request(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const request = { id: "r1", userId: "user-2", permissions: ["costs:write"], durationMinutes: 30 };

beforeEach(() => vi.clearAllMocks());

describe("access request routes", () => {
  it("creates a request and answers 201", async () => {
    mockCreate.mockResolvedValue({ outcome: "created", request });
    const res = await post("/", {
      permissions: ["costs:write"],
      reason: "Incident 42 needs it",
      durationMinutes: 30,
    });
    expect(res.status).toBe(201);
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ userId: "user-1", durationMinutes: 30 });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "access_request.create" }),
    );
  });

  it("refuses an unknown key, a short reason and an out-of-range duration with one sentence", async () => {
    for (const body of [
      { permissions: ["a"], reason: "long enough reason", durationMinutes: 30, extra: 1 },
      { permissions: ["a"], reason: "short", durationMinutes: 30 },
      { permissions: ["a"], reason: "long enough reason", durationMinutes: 481 },
      { permissions: [], reason: "long enough reason", durationMinutes: 30 },
    ]) {
      const res = await post("/", body);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(Object.keys(json)).toEqual(["error"]);
      expect(typeof json.error).toBe("string");
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON as a 400, not a 500", async () => {
    const res = await buildApp().request("/", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });

  it("decides with no body at all", async () => {
    mockDecide.mockResolvedValue({ outcome: "decided", request });
    const res = await post("/r1/approve");
    expect(res.status).toBe(200);
    expect(mockDecide.mock.calls[0]!.slice(0, 3)).toEqual(["org-1", "r1", "approved"]);
    expect(mockDecide.mock.calls[0]![3]).toMatchObject({ userId: "user-1", name: "Ada" });
  });

  it("answers self-approval and over-reach with their codes", async () => {
    mockDecide.mockResolvedValueOnce({ outcome: "self_approval" });
    const self = await post("/r1/approve", {});
    expect(self.status).toBe(403);
    expect(await self.json()).toEqual({
      error: "You cannot decide your own access request; that is the whole point of the approval.",
      code: "self_approval",
    });

    mockDecide.mockResolvedValueOnce({ outcome: "exceeds_approver", missing: ["billing:write"] });
    const over = await post("/r1/approve", { note: "ok" });
    expect(over.status).toBe(403);
    expect(await over.json()).toEqual({
      error: "You cannot grant permissions you do not hold yourself: billing:write.",
      code: "exceeds_approver",
      missing: ["billing:write"],
    });
  });

  it("deciding needs access:approve", async () => {
    const res = await post("/r1/approve", {}, ["access:read"]);
    expect(res.status).toBe(403);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it("lets the holder revoke without access:approve, and nobody else", async () => {
    mockRevoke.mockResolvedValue({ outcome: "revoked", request: { ...request, userId: "user-1" } });
    mockGet.mockResolvedValue({ ...request, userId: "user-1" });
    expect((await post("/r1/revoke", undefined, [])).status).toBe(200);

    mockGet.mockResolvedValue(request);
    const other = await post("/r1/revoke", undefined, []);
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: "Missing permission: access:approve" });
  });

  it("names the allowed statuses when the filter is wrong", async () => {
    const res = await buildApp().request("/?status=bogus");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "status must be one of: pending, approved, denied, expired",
    });
  });
});
