import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";

const mockGetSettings = vi.fn();
const mockUpdate = vi.fn();
const mockMarkDue = vi.fn();
const mockOverview = vi.fn();
const mockLogAudit = vi.fn();

class FakeSettingsError extends Error {
  readonly status = 400 as const;
}

// The real modules reach server-core's db client at import time, which needs
// DATABASE_URL: stub them at the boundary.
vi.mock("@infrawrench/server-core/idle/settings", () => ({
  getOrgIdleSettings: (...args: unknown[]) => mockGetSettings(...args),
  updateOrgIdleSettings: (...args: unknown[]) => mockUpdate(...args),
  markOrgIdleScansDue: (...args: unknown[]) => mockMarkDue(...args),
  IdleSettingsError: FakeSettingsError,
}));
vi.mock("@infrawrench/server-core/idle/feed", () => ({
  getIdleFindingsOverview: (...args: unknown[]) => mockOverview(...args),
}));
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { idleFindingRoutes } = await import("@/api/routes/idle-findings");

function buildApp(permissions: string[]): Hono {
  const app = new Hono();
  const session: AuthSession = { userId: "user-1", email: "test@example.com" };
  app.onError((err) => {
    if (err instanceof HTTPException) return err.getResponse();
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    c.set("permissions", permissions);
    c.set("role", null);
    return next();
  });
  app.route("/", idleFindingRoutes);
  return app;
}

const put = (body: unknown) => ({
  method: "PUT",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

const settings = { enabled: true, lookbackDays: 14, rules: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettings.mockResolvedValue(settings);
  mockUpdate.mockImplementation((_org: string, patch: Record<string, unknown>) =>
    Promise.resolve({ ...settings, ...patch }),
  );
  mockOverview.mockResolvedValue({ settings, rules: [], accounts: [] });
});

describe("GET /idle-findings", () => {
  it("needs resources:read and returns the overview", async () => {
    expect((await buildApp(["costs:read"]).request("/")).status).toBe(403);
    const res = await buildApp(["resources:read"]).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings, rules: [], accounts: [] });
    expect(mockOverview).toHaveBeenCalledWith("org-1");
  });
});

describe("GET /idle-findings/settings", () => {
  it("needs org:settings:write", async () => {
    expect((await buildApp(["resources:read"]).request("/settings")).status).toBe(403);
    const res = await buildApp(["org:settings:write"]).request("/settings");
    expect(await res.json()).toEqual(settings);
  });
});

describe("PUT /idle-findings/settings", () => {
  it("needs org:settings:write", async () => {
    const res = await buildApp(["resources:read"]).request("/settings", put({ enabled: false }));
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("saves a patch, passes the user, and audits it", async () => {
    const body = {
      lookbackDays: 21,
      rules: { "aws:nat-gateway": { enabled: false, thresholds: { maxBytesOut: 5 } } },
    };
    const res = await buildApp(["org:settings:write"]).request("/settings", put(body));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("org-1", body, "user-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "idle_findings.settings_update", entityId: "org-1" }),
    );
  });

  it("rejects malformed bodies before touching storage", async () => {
    const app = buildApp(["org:settings:write"]);
    for (const body of [
      {},
      { enabled: "yes" },
      { lookbackDays: "14" },
      { rules: [] },
      { rules: { "aws:nat-gateway": { thresholds: { maxBytesOut: "1" } } } },
      { rules: { "aws:nat-gateway": { muted: true } } },
      { surprise: 1 },
    ]) {
      const res = await app.request("/settings", put(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("answers 400 with the settings module's message for an out-of-range value", async () => {
    mockUpdate.mockRejectedValue(
      new FakeSettingsError("lookbackDays must be a whole number from 7 to 42"),
    );
    const res = await buildApp(["org:settings:write"]).request(
      "/settings",
      put({ lookbackDays: 3 }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "lookbackDays must be a whole number from 7 to 42" });
  });
});

describe("POST /idle-findings/rescan", () => {
  it("needs org:settings:write, marks the org due and audits", async () => {
    expect((await buildApp(["resources:read"]).request("/rescan", { method: "POST" })).status).toBe(
      403,
    );
    const res = await buildApp(["org:settings:write"]).request("/rescan", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockMarkDue).toHaveBeenCalledWith("org-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "idle_findings.rescan" }),
    );
  });
});
