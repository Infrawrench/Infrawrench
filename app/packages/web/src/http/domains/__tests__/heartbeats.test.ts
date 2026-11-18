import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The store, the suggestions reader and the ping recorder reach Postgres;
// these tests are about the transport: decoded bodies, statuses, the store's
// refusals, the public ping route's plain-text answers, and that the ping
// token never reaches the audit log.
vi.mock("@infrawrench/server-core/db/client", () => ({ db: {} }));
vi.mock("@/db/client", () => ({ db: {} }));
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockList = vi.fn();
const mockRotate = vi.fn();
const mockPings = vi.fn();
vi.mock("@infrawrench/server-core/heartbeats/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@infrawrench/server-core/heartbeats/store")>()),
  createHeartbeatRecord: (...a: unknown[]) => mockCreate(...a),
  updateHeartbeatRecord: (...a: unknown[]) => mockUpdate(...a),
  deleteHeartbeatRecord: (...a: unknown[]) => mockDelete(...a),
  listHeartbeatRecords: (...a: unknown[]) => mockList(...a),
  rotateHeartbeatToken: (...a: unknown[]) => mockRotate(...a),
  listHeartbeatPings: (...a: unknown[]) => mockPings(...a),
}));
const mockSuggestions = vi.fn();
vi.mock("@infrawrench/server-core/heartbeats/suggestions", () => ({
  listHeartbeatSuggestions: (...a: unknown[]) => mockSuggestions(...a),
}));
const mockRecord = vi.fn();
const mockAnnounce = vi.fn();
vi.mock("@infrawrench/server-core/heartbeats/ping", () => ({
  recordHeartbeatPing: (...a: unknown[]) => mockRecord(...a),
  announcePingTransition: (...a: unknown[]) => mockAnnounce(...a),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { HeartbeatInputError } = await import("@infrawrench/server-core/heartbeats/store");
const { heartbeatsDomain } = await import("@/http/domains/heartbeats/index");
const app = (permissions?: string[]) =>
  buildTestApi(heartbeatsDomain, {
    basePath: "/api/org/org-1/heartbeats",
    ...(permissions ? { permissions } : {}),
  });
const ping = () => buildTestApi(heartbeatsDomain, { basePath: "/api/ping" });

const TOKEN = "abcdefghjkmnpqrstuvwxyz23456789ab";
const ID = "8d3c2a4e-1f6b-4c3d-9e2a-7b5c4d3e2f1a";
const row = {
  id: ID,
  organizationId: "org-1",
  name: "Nightly backup",
  scheduleKind: "cron" as const,
  cronExpression: "0 2 * * *",
  timezone: "UTC",
  intervalMinutes: null,
  graceMinutes: 10,
  enabled: true,
  pingToken: TOKEN,
  status: "new" as const,
  downReason: null,
  lastPingAt: null,
  lastStartAt: null,
  lastFailAt: null,
  lastDurationMs: null,
  nextExpectedAt: null,
  deadlineAt: null,
  lastStateChangeAt: null,
  pingWindowStart: null,
  pingWindowCount: 0,
  accountId: null,
  resourceId: null,
  pluginId: null,
  resourceTypeId: null,
  fieldKey: null,
  createdByUserId: null,
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("heartbeat routes", () => {
  it("lists heartbeats with their ping URL", async () => {
    mockList.mockResolvedValue([row]);
    const res = await app().request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.heartbeats[0]).toMatchObject({
      id: ID,
      status: "new",
      cronExpression: "0 2 * * *",
      intervalMinutes: null,
    });
    expect(body.heartbeats[0].pingUrl).toMatch(new RegExp(`/api/ping/${TOKEN}$`));
    expect(body.heartbeats[0]).not.toHaveProperty("pingToken");
  });

  it("creates, answering 201, and keeps the token out of the audit log", async () => {
    mockCreate.mockResolvedValue(row);
    const res = await app().request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Nightly backup",
        scheduleKind: "cron",
        cronExpression: "0 2 * * *",
      }),
    });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      { name: "Nightly backup", scheduleKind: "cron", cronExpression: "0 2 * * *" },
      expect.any(String),
    );
    await vi.waitFor(() => expect(mockLogAudit).toHaveBeenCalled());
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(TOKEN);
  });

  it("refuses a body of the wrong shape before the store sees it", async () => {
    const res = await app().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "x", scheduleKind: "weekly" }),
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("answers the store's refusals in its words", async () => {
    mockUpdate.mockRejectedValue(new HeartbeatInputError("Heartbeat not found", 404));
    const res = await app().request(`/${ID}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Heartbeat not found" });
  });

  it("needs resources:write to change anything", async () => {
    const res = await app(["resources:read"]).request(`/${ID}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("passes the resource filter to the suggestions reader", async () => {
    mockSuggestions.mockResolvedValue([]);
    const res = await app().request("/suggestions?resourceId=r-1");
    expect(res.status).toBe(200);
    expect(mockSuggestions).toHaveBeenCalledWith("org-1", { resourceId: "r-1" });
  });

  it("reads ping history with a bounded limit", async () => {
    mockPings.mockResolvedValue([]);
    expect((await app().request(`/${ID}/pings?limit=20`)).status).toBe(200);
    expect(mockPings).toHaveBeenCalledWith("org-1", ID, 20);
    expect((await app().request(`/${ID}/pings?limit=5000`)).status).toBe(400);
  });
});

describe("public ping URL", () => {
  it("records a success ping and answers OK in plain text, uncached", async () => {
    mockRecord.mockResolvedValue({ outcome: "recorded", transition: null });
    const res = await ping().request(`/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK\n");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mockRecord).toHaveBeenCalledWith(TOKEN, "success", {
      method: "GET",
      userAgent: null,
      body: null,
    });
  });

  it("keeps a POSTed failure's body and announces the transition", async () => {
    const transition = { kind: "down", heartbeat: row, detail: "disk full" };
    mockRecord.mockResolvedValue({ outcome: "recorded", transition });
    const res = await ping().request(`/${TOKEN}/fail`, {
      method: "POST",
      headers: { "content-type": "text/plain", "user-agent": "curl/8" },
      body: "disk full",
    });
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(TOKEN, "fail", {
      method: "POST",
      userAgent: "curl/8",
      body: "disk full",
    });
    await vi.waitFor(() => expect(mockAnnounce).toHaveBeenCalledWith(transition));
  });

  it("records a start ping", async () => {
    mockRecord.mockResolvedValue({ outcome: "recorded", transition: null });
    expect((await ping().request(`/${TOKEN}/start`, { method: "POST" })).status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(TOKEN, "start", expect.anything());
  });

  it("answers an unknown token 404 and a full window 429", async () => {
    mockRecord.mockResolvedValueOnce({ outcome: "not-found" });
    expect((await ping().request("/nope")).status).toBe(404);
    mockRecord.mockResolvedValueOnce({ outcome: "rate-limited" });
    expect((await ping().request(`/${TOKEN}`)).status).toBe(429);
  });
});
