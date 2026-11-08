/**
 * The cost canvas routes' transport contract: permissions (including the
 * second `chat:write` gate), the strict spec decode and its one-sentence 400,
 * the PDF attachment, and the schedule routes' visibility check. The canvas
 * logic itself is the services', which the chat tools share and test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi, type TestApi } from "@/http/testing";

class FakeCostCanvasInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}
class FakeReportNotificationInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

const mocks = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  draft: vi.fn(),
  ensureConversation: vi.fn(),
  run: vi.fn(),
  runSpec: vi.fn(),
  pdf: vi.fn(),
  listNotifications: vi.fn(),
  createNotification: vi.fn(),
  sendNow: vi.fn(),
  requireLive: vi.fn(),
  targets: vi.fn(),
  audit: vi.fn(),
};

vi.mock("../../../services/cost-canvases", () => ({
  CostCanvasInputError: FakeCostCanvasInputError,
  listCostCanvases: (...a: unknown[]) => mocks.list(...a),
  getCostCanvas: (...a: unknown[]) => mocks.get(...a),
  createCostCanvas: (...a: unknown[]) => mocks.create(...a),
  updateCostCanvas: (...a: unknown[]) => mocks.update(...a),
  softDeleteCostCanvas: (...a: unknown[]) => mocks.softDelete(...a),
  draftCostCanvas: (...a: unknown[]) => mocks.draft(...a),
  ensureCanvasConversation: (...a: unknown[]) => mocks.ensureConversation(...a),
  runCostCanvas: (...a: unknown[]) => mocks.run(...a),
  runCostCanvasSpec: (...a: unknown[]) => mocks.runSpec(...a),
}));
vi.mock("../../../services/cost-canvas-pdf", () => ({
  renderCostCanvasPdf: (...a: unknown[]) => mocks.pdf(...a),
  renderCanvasForDelivery: vi.fn(),
}));
vi.mock("@infrawrench/server-core/report-delivery/store", () => ({
  ReportNotificationInputError: FakeReportNotificationInputError,
  listReportDeliveryTargets: (...a: unknown[]) => mocks.targets(...a),
}));
vi.mock("@infrawrench/server-core/report-delivery/canvas", () => ({
  listCanvasNotifications: (...a: unknown[]) => mocks.listNotifications(...a),
  createCanvasNotification: (...a: unknown[]) => mocks.createNotification(...a),
  updateCanvasNotification: vi.fn(),
  deleteCanvasNotification: vi.fn(),
  sendCanvasNotificationNow: (...a: unknown[]) => mocks.sendNow(...a),
  requireLiveCanvas: (...a: unknown[]) => mocks.requireLive(...a),
}));
vi.mock("../../../services/audit", () => ({
  logAudit: (...a: unknown[]) => mocks.audit(...a),
}));

const { costCanvasesDomain } = await import("@/http/domains/cost-canvases/index");

const basePath = "/api/org/org-1/cost-canvases";
const app = (permissions?: string[]): TestApi =>
  buildTestApi(costCanvasesDomain, { basePath, ...(permissions ? { permissions } : {}) });

const spec = { version: 1, blocks: [{ id: "t1", kind: "text", text: "Spend is up." }] };

const canvas = {
  id: "c1",
  name: "Monthly",
  description: null,
  spec,
  prompt: null,
  conversationId: null,
  createdByUserId: "user-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  placements: [],
};

const runResult = {
  canvasId: "c1",
  name: "Monthly",
  ranAt: "2026-10-01T00:00:00.000Z",
  displayCurrency: null,
  blocks: [{ id: "t1", kind: "text", text: "Spend is up." }],
};

const json = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([canvas]);
  mocks.get.mockResolvedValue(canvas);
  mocks.create.mockResolvedValue(canvas);
  mocks.update.mockResolvedValue(canvas);
  mocks.softDelete.mockResolvedValue(true);
  mocks.draft.mockResolvedValue(canvas);
  mocks.ensureConversation.mockResolvedValue("conv-1");
  mocks.run.mockResolvedValue(runResult);
  mocks.runSpec.mockResolvedValue(runResult);
  mocks.listNotifications.mockResolvedValue([]);
});

describe("canvas CRUD", () => {
  it("lists for the caller", async () => {
    const res = await app(["costs:read"]).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([canvas]);
    expect(mocks.list).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("creates from a valid spec and audits", async () => {
    const res = await app().request("/", json({ name: "Monthly", spec }));
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith("org-1", { name: "Monthly", spec }, "user-1");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_canvas.create", entityId: "c1" }),
    );
  });

  it("refuses a malformed spec as one sentence, with no issues list", async () => {
    const res = await app().request(
      "/",
      json({ name: "Monthly", spec: { version: 1, blocks: [{ id: "t1", kind: "text" }] } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
    expect(String(body["error"])).toMatch(/^Invalid canvas: spec\.blocks\.0/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown key: canvas bodies are strict", async () => {
    const res = await app().request("/", json({ name: "Monthly", spec, sql: "select 1" }));
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error: string }).error)).toContain("Invalid canvas:");
  });

  it("needs costs:write to create", async () => {
    const res = await app(["costs:read"]).request("/", json({ name: "Monthly", spec }));
    expect(res.status).toBe(403);
  });

  it("404s a canvas the caller cannot see", async () => {
    mocks.get.mockResolvedValue(null);
    const res = await app().request("/c9");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("replaces, and 404s a missing one", async () => {
    expect((await app().request("/c1", json({ name: "Renamed", spec }, "PUT"))).status).toBe(200);
    mocks.update.mockResolvedValue(null);
    expect((await app().request("/c1", json({ name: "Renamed", spec }, "PUT"))).status).toBe(404);
  });

  it("deletes", async () => {
    const res = await app().request("/c1", { method: "DELETE" });
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_canvas.delete", entityId: "c1" }),
    );
  });
});

describe("drafting and conversations", () => {
  it("needs chat:write on top of costs:write", async () => {
    const res = await app(["costs:write"]).request("/draft", json({ prompt: "Monthly spend" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: chat:write" });
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it("refuses a bad draft with the payload 400", async () => {
    const res = await app().request("/draft", json({ prompt: "" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("Invalid draft");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("drafts from a prompt", async () => {
    const res = await app().request("/draft", json({ prompt: "Monthly spend" }));
    expect(res.status).toBe(200);
    expect(mocks.draft).toHaveBeenCalledWith("org-1", { prompt: "Monthly spend" }, "user-1");
  });

  it("maps the service's refusal to its status", async () => {
    mocks.draft.mockRejectedValue(new FakeCostCanvasInputError("Unknown model."));
    const res = await app().request("/draft", json({ prompt: "x", model: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown model." });
  });

  it("opens the caller's conversation, and needs chat:write", async () => {
    const res = await app().request("/c1/conversation", json({ fresh: true }));
    expect(await res.json()).toEqual({ conversationId: "conv-1" });
    expect(mocks.ensureConversation).toHaveBeenCalledWith("org-1", "c1", "user-1", {
      model: undefined,
      fresh: true,
    });
    const denied = await app(["costs:write"]).request("/c1/conversation", json({}));
    expect(denied.status).toBe(403);
  });

  it("404s a conversation on a canvas the caller cannot edit", async () => {
    mocks.ensureConversation.mockRejectedValue(new FakeCostCanvasInputError("Not found", 404));
    const res = await app().request("/c1/conversation", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("running", () => {
  it("runs a saved canvas, with chart data unless asked not to", async () => {
    await app().request("/c1/run", { method: "POST" });
    expect(mocks.run).toHaveBeenCalledWith("org-1", "c1", {
      granted: ["*"],
      includeChartData: true,
    });
    await app().request("/c1/run", json({ includeChartData: false }));
    expect(mocks.run).toHaveBeenLastCalledWith("org-1", "c1", {
      granted: ["*"],
      includeChartData: false,
    });
  });

  it("previews an unsaved spec, and refuses a bad one as a sentence", async () => {
    const res = await app(["costs:read"]).request("/preview", json({ spec, name: "Draft" }));
    expect(res.status).toBe(200);
    expect(mocks.runSpec).toHaveBeenCalledWith(
      "org-1",
      { id: null, name: "Draft", spec },
      { granted: ["costs:read"], includeChartData: true },
    );
    const bad = await app().request("/preview", json({ spec: { version: 2, blocks: [] } }));
    expect(bad.status).toBe(400);
    expect(String(((await bad.json()) as { error: string }).error)).toMatch(/^Invalid canvas: /);
  });

  it("sends the PDF as a private attachment", async () => {
    mocks.pdf.mockResolvedValue({ name: "Monthly", pdf: new Uint8Array([37, 80, 68, 70]) });
    const res = await app().request("/c1/pdf?tz=Europe/Berlin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe("4");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(mocks.pdf).toHaveBeenCalledWith("org-1", "c1", {
      granted: ["*"],
      timezone: "Europe/Berlin",
    });
  });
});

describe("delivery schedules", () => {
  it("404s every schedule route for a canvas the caller cannot see", async () => {
    mocks.get.mockResolvedValue(null);
    expect((await app().request("/c1/notifications")).status).toBe(404);
    expect((await app().request("/c1/notifications", json({ cadence: "daily" }))).status).toBe(404);
    expect(mocks.listNotifications).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it("needs org:settings:write to change a schedule", async () => {
    const res = await app(["costs:read", "costs:write"]).request(
      "/c1/notifications",
      json({ cadence: "daily" }),
    );
    expect(res.status).toBe(403);
  });

  it("hands the body to the store and answers its refusal", async () => {
    mocks.createNotification.mockRejectedValue(
      new FakeReportNotificationInputError("Pick at least one destination"),
    );
    const input = { cadence: "daily", hour: 9, timezone: "UTC" };
    const res = await app().request("/c1/notifications", json(input));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Pick at least one destination" });
    expect(mocks.createNotification).toHaveBeenCalledWith("org-1", "c1", input, "user-1");
  });

  it("checks the canvas is live before listing targets", async () => {
    mocks.requireLive.mockRejectedValue(new FakeReportNotificationInputError("Not found", 404));
    expect((await app().request("/c1/notifications/targets")).status).toBe(404);
    expect(mocks.targets).not.toHaveBeenCalled();
  });
});
