import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const OFFBOARDING_ID = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const ITEM_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const progress = { total: 1, resolved: 0, open: 1, failed: 0, unconfirmed: 0 };
const summary = {
  id: OFFBOARDING_ID,
  email: "jane@example.com",
  name: "Jane Doe",
  userId: "user-9",
  aliases: ["jdoe"],
  status: "open",
  source: "manual",
  sourceDetail: null,
  startedByName: "Ada",
  note: null,
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: "2026-11-08T10:00:00.000Z",
  completedAt: null,
  lastScannedAt: "2026-11-08T10:00:00.000Z",
  scanTruncated: false,
  progress,
};
const wireItem = {
  id: ITEM_ID,
  kind: "seat",
  title: "Copilot Business",
  detail: "business",
  pluginId: "github",
  providerName: "GitHub",
  accountId: "acct-1",
  accountName: "acme",
  resourceId: null,
  resourceTypeId: null,
  confidence: "exact",
  matchReason: "Their email in the seat's email",
  matchState: "matched",
  actions: ["remove-seat"],
  status: "open",
  resolution: null,
  lastError: null,
  note: null,
  resolvedByName: null,
  resolvedAt: null,
  firstSeenAt: "2026-11-08T10:00:00.000Z",
  lastSeenAt: "2026-11-08T10:00:00.000Z",
};
const offboarding = { ...summary, items: [wireItem] };

/** The stored row the action route reads, with its server-only `ref`. */
const storedItem = (over: Record<string, unknown> = {}) => ({
  ...wireItem,
  itemKey: "seat:s1",
  ref: { seatId: "s1" },
  offboardingId: OFFBOARDING_ID,
  ...over,
});

const store = {
  listOffboardings: vi.fn(),
  getOffboarding: vi.fn(),
  getOffboardingItemRow: vi.fn(),
  listOffboardingMembers: vi.fn(),
  loadOffboardingActor: vi.fn(),
  previewOffboarding: vi.fn(),
  recordItemOutcome: vi.fn(),
  rescanOffboarding: vi.fn(),
  startOffboarding: vi.fn(),
  updateOffboarding: vi.fn(),
  updateOffboardingItem: vi.fn(),
};
class OffboardingInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
vi.mock("@infrawrench/server-core/offboarding/store", () => ({ ...store, OffboardingInputError }));

const mockRun = vi.fn();
class OffboardingActionRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409,
  ) {
    super(message);
  }
}
vi.mock("@/services/offboarding-actions", () => ({
  runOffboardingAction: (...a: unknown[]) => mockRun(...a),
  OffboardingActionRefused,
}));
const mockFreeze = vi.fn();
vi.mock("@/services/change-freezes", () => ({
  CHANGE_FREEZE_OVERRIDE_HEADER: "x-change-freeze-override",
  evaluateChangeFreeze: (...a: unknown[]) => mockFreeze(...a),
}));
const mockAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockAudit(...a) }));

const { offboardingDomain } = await import("@/http/domains/offboarding/index");
const buildApp = (permissions?: string[]) =>
  buildTestApi(offboardingDomain, {
    basePath: "/api/org/org-1/offboardings",
    ...(permissions ? { permissions } : {}),
  });

const actPath = `/${OFFBOARDING_ID}/items/${ITEM_ID}/action`;
const act = (body: unknown, permissions?: string[]) =>
  buildApp(permissions).request(actPath, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  store.loadOffboardingActor.mockResolvedValue({ userId: "user-1", name: "Ada" });
  store.getOffboardingItemRow.mockResolvedValue({
    offboarding: { id: OFFBOARDING_ID, email: "jane@example.com", status: "open" },
    item: storedItem(),
  });
  store.recordItemOutcome.mockImplementation(
    async (_id: string, outcome: { ok: boolean; error?: string }) => ({
      ...wireItem,
      status: outcome.ok ? "done" : "failed",
      lastError: outcome.ok ? null : outcome.error,
    }),
  );
  mockFreeze.mockResolvedValue(null);
});

describe("offboarding routes", () => {
  it("lists checklists", async () => {
    store.listOffboardings.mockResolvedValue([summary]);
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ offboardings: [summary] });
  });

  it("starts a checklist and audits it", async () => {
    store.startOffboarding.mockResolvedValue({ offboarding, created: true });
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ email: "jane@example.com", aliases: ["jdoe"] }),
    });
    expect(res.status).toBe(200);
    expect(store.startOffboarding).toHaveBeenCalledWith(
      "org-1",
      { email: "jane@example.com", aliases: ["jdoe"] },
      { userId: "user-1", name: "Ada" },
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "offboarding.started", entityId: OFFBOARDING_ID }),
    );
  });

  it("answers a store refusal with its status", async () => {
    store.startOffboarding.mockRejectedValue(
      new OffboardingInputError("Enter the email address the person signed in with."),
    );
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ email: "jane" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Enter the email address the person signed in with.",
    });
  });

  it("needs team:remove", async () => {
    const res = await buildApp(["team:read"]).request("/");
    expect(res.status).toBe(403);
  });

  it("exports the checklist as CSV and audits it", async () => {
    store.getOffboarding.mockResolvedValue(offboarding);
    const res = await buildApp().request(`/${OFFBOARDING_ID}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await res.text()).toContain('"Copilot Business"');
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "offboarding.exported" }),
    );
  });
});

describe("acting on a row", () => {
  it("runs the action, records it and audits the attempt", async () => {
    mockRun.mockResolvedValue("Removed. The provider bills it until the end of the cycle.");
    const res = await act({ action: "remove-seat" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item.status).toBe("done");
    expect(body.message).toBe("Removed. The provider bills it until the end of the cycle.");
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", userId: "user-1" }),
      expect.objectContaining({ ref: { seatId: "s1" } }),
      { action: "remove-seat" },
    );
    expect(mockFreeze).toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "offboarding.action",
        metadata: expect.objectContaining({ action: "remove-seat", outcome: "done" }),
      }),
    );
  });

  it("records a provider refusal on the row rather than failing the call", async () => {
    mockRun.mockRejectedValue(new Error("GitHub said no"));
    const res = await act({ action: "remove-seat" });
    expect(res.status).toBe(200);
    expect((await res.json()).item).toMatchObject({
      status: "failed",
      lastError: "GitHub said no",
    });
    expect(store.recordItemOutcome).toHaveBeenCalledWith(
      ITEM_ID,
      { ok: false, error: "GitHub said no" },
      { userId: "user-1", name: "Ada" },
    );
  });

  it("refuses an action the row does not offer", async () => {
    const res = await act({ action: "remove-member" });
    expect(res.status).toBe(409);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("refuses to act on an unconfirmed match", async () => {
    store.getOffboardingItemRow.mockResolvedValue({
      offboarding: { id: OFFBOARDING_ID, email: "jane@example.com", status: "open" },
      item: storedItem({ confidence: "possible", matchState: "unconfirmed" }),
    });
    const res = await act({ action: "remove-seat" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Confirm this is them before acting on it." });
  });

  it("needs the action's own permission on top of team:remove", async () => {
    const res = await act({ action: "remove-seat" }, ["team:remove"]);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: resources:write" });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("needs a member to hand a resource to", async () => {
    store.getOffboardingItemRow.mockResolvedValue({
      offboarding: { id: OFFBOARDING_ID, email: "jane@example.com", status: "open" },
      item: storedItem({ kind: "resource", actions: ["transfer-ownership"] }),
    });
    const res = await act({ action: "transfer-ownership" });
    expect(res.status).toBe(400);
    expect(mockFreeze).not.toHaveBeenCalled();
  });

  it("refuses when the checklist is closed", async () => {
    store.getOffboardingItemRow.mockResolvedValue({
      offboarding: { id: OFFBOARDING_ID, email: "jane@example.com", status: "completed" },
      item: storedItem(),
    });
    expect((await act({ action: "remove-seat" })).status).toBe(409);
  });

  it("maps a caller refusal from the action to its status", async () => {
    mockRun.mockRejectedValue(
      new OffboardingActionRefused("Only an owner can remove another owner.", 403),
    );
    const res = await act({ action: "remove-seat" });
    expect(res.status).toBe(403);
    expect(store.recordItemOutcome).not.toHaveBeenCalled();
  });
});
