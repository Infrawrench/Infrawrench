import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The store is mocked: it reaches the Drizzle client and the plugin registry.
// These tests own the transport contract: permissions, the strict body schema,
// the person-only arm, refusals as statuses, and audit.
class FakeRefusal extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const store = {
  listGameDays: vi.fn(),
  getGameDayDetail: vi.fn(),
  listGameDayCandidates: vi.fn(),
  createGameDay: vi.fn(),
  updateGameDay: vi.fn(),
  deleteGameDay: vi.fn(),
  armGameDay: vi.fn(),
  disarmGameDay: vi.fn(),
  requestGameDayEnd: vi.fn(),
  retryGameDayUndo: vi.fn(),
};
vi.mock("@infrawrench/server-core/game-days/store", () => ({
  GameDayRefusal: FakeRefusal,
  listGameDays: (...a: unknown[]) => store.listGameDays(...a),
  getGameDayDetail: (...a: unknown[]) => store.getGameDayDetail(...a),
  listGameDayCandidates: (...a: unknown[]) => store.listGameDayCandidates(...a),
  createGameDay: (...a: unknown[]) => store.createGameDay(...a),
  updateGameDay: (...a: unknown[]) => store.updateGameDay(...a),
  deleteGameDay: (...a: unknown[]) => store.deleteGameDay(...a),
  armGameDay: (...a: unknown[]) => store.armGameDay(...a),
  disarmGameDay: (...a: unknown[]) => store.disarmGameDay(...a),
  requestGameDayEnd: (...a: unknown[]) => store.requestGameDayEnd(...a),
  retryGameDayUndo: (...a: unknown[]) => store.retryGameDayUndo(...a),
}));

const mockPlan = vi.fn();
vi.mock("@infrawrench/server-core/game-days/plan", () => ({
  planGameDay: (...a: unknown[]) => mockPlan(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { gameDaysDomain } = await import("@/http/domains/game-days/index");

const buildApp = (
  permissions?: string[],
  principal?: NonNullable<Parameters<typeof buildTestApi>[1]>["principal"],
) =>
  buildTestApi(gameDaysDomain, {
    basePath: "/api/org/org-1/game-days",
    ...(permissions ? { permissions } : {}),
    ...(principal ? { principal } : {}),
  });

const ID = "11111111-1111-4111-8111-111111111111";

const gameDay = {
  id: ID,
  name: "Checkout without its cache",
  description: null,
  serviceId: null,
  serviceName: null,
  status: "planned",
  endReason: null,
  startsAt: "2026-11-20T10:00:00.000Z",
  durationMinutes: 15,
  recoveryTimeoutMinutes: 30,
  freezeDuringRun: false,
  freezeId: null,
  watchedProbes: [],
  watchedSloIds: [],
  armedAt: null,
  armedByUserId: null,
  armedByEmail: null,
  injectedAt: null,
  endsAt: null,
  endRequestedAt: null,
  undoneAt: null,
  recoveredAt: null,
  completedAt: null,
  lastError: null,
  signals: {
    probeFailedAt: null,
    probeDownAt: null,
    metricAlertAt: null,
    sloBurnAt: null,
    incidentDeclaredAt: null,
    alertedAt: null,
    pagedAt: null,
    acknowledgedAt: null,
  },
  targets: [],
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T10:00:00.000Z",
};

const input = {
  name: "Checkout without its cache",
  targets: [{ resourceId: "res-1", actionId: "scale-to-zero" }],
  startsAt: "2026-11-20T10:00:00.000Z",
  durationMinutes: 15,
};

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("game days routes", () => {
  it("lists for a reader", async () => {
    store.listGameDays.mockResolvedValue([gameDay]);
    const res = await buildApp(["game-days:read"]).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gameDays: [gameDay] });
    expect(store.listGameDays).toHaveBeenCalledWith("org-1");
  });

  it("refuses planning without game-days:run", async () => {
    const res = await buildApp(["game-days:read"]).request("/", json(input));
    expect(res.status).toBe(403);
    expect(store.createGameDay).not.toHaveBeenCalled();
  });

  it("plans with the defaults filled in and audits it", async () => {
    store.createGameDay.mockResolvedValue(gameDay);
    const res = await buildApp(["game-days:run"]).request("/", json(input));
    expect(res.status).toBe(200);
    expect(store.createGameDay).toHaveBeenCalledWith(
      "org-1",
      {
        ...input,
        description: null,
        serviceId: null,
        recoveryTimeoutMinutes: 30,
        freezeDuringRun: false,
        watchedProbeIds: [],
        watchedSloIds: [],
      },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "game_day.create", entityId: ID }),
    );
  });

  it("refuses an out-of-range time limit and unknown keys before the store", async () => {
    const app = buildApp();
    expect((await app.request("/", json({ ...input, durationMinutes: 1000 }))).status).toBe(400);
    expect((await app.request("/", json({ ...input, destroy: true }))).status).toBe(400);
    expect((await app.request("/", json({ ...input, targets: [] }))).status).toBe(400);
    expect(store.createGameDay).not.toHaveBeenCalled();
  });

  it("answers a store refusal with its status", async () => {
    store.createGameDay.mockRejectedValue(new FakeRefusal("Resource res-1 not found", 404));
    const res = await buildApp().request("/", json(input));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Resource res-1 not found" });
  });

  it("arms for a person, and refuses an API key", async () => {
    store.armGameDay.mockResolvedValue({ ...gameDay, status: "armed" });
    const ok = await buildApp().request(`/${ID}/arm`, json({ confirmName: gameDay.name }));
    expect(ok.status).toBe(200);
    expect(store.armGameDay).toHaveBeenCalledWith("org-1", ID, "user-1", gameDay.name);

    store.armGameDay.mockClear();
    const key = await buildApp(undefined, {
      apiKey: { id: "key-1", scopes: ["game-days:run"] },
    }).request(`/${ID}/arm`, json({ confirmName: gameDay.name }));
    expect(key.status).toBe(403);
    expect(store.armGameDay).not.toHaveBeenCalled();
  });

  it("lets a reader abort, and audits it", async () => {
    store.requestGameDayEnd.mockResolvedValue({ ...gameDay, status: "running" });
    const res = await buildApp(["game-days:read"]).request(`/${ID}/abort`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(store.requestGameDayEnd).toHaveBeenCalledWith("org-1", ID, "user-1", "aborted");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "game_day.abort" }),
    );
  });

  it("keeps ending early behind game-days:run", async () => {
    const res = await buildApp(["game-days:read"]).request(`/${ID}/end`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("answers a conflict when the game day moved on", async () => {
    store.disarmGameDay.mockRejectedValue(
      new FakeRefusal("Only an armed game day that has not started can be disarmed", 409),
    );
    const res = await buildApp().request(`/${ID}/disarm`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("dry-runs a draft", async () => {
    mockPlan.mockResolvedValue({ steps: [], blockingFreeze: null, unmeasured: ["slo_burn"] });
    const res = await buildApp().request("/plan", json(input));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steps: [], blockingFreeze: null, unmeasured: ["slo_burn"] });
  });
});
