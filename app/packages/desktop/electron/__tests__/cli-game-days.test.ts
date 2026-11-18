import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `game-days` on effect/cli: the listing, one report, abort, --json and the
// refusals, against fixtures. Nothing reaches a network or a database.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../cloud-tokens", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => [{ id: "org_1", displayName: "Acme", role: "admin" }]),
  getAuthStatus: vi.fn(async () => ({ authenticated: true, email: "ada@example.com" })),
  clearStoredTokens: vi.fn(),
  createPkceChallenge: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  setTokenStoreReadOnly: vi.fn(),
}));

import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const NOW = Date.parse("2026-11-18T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (minutes: number) =>
  new Date(Date.parse("2026-11-18T10:00:00.000Z") + minutes * 60_000).toISOString();

const signals = {
  probeFailedAt: null,
  probeDownAt: null,
  metricAlertAt: null,
  sloBurnAt: null,
  incidentDeclaredAt: null,
  alertedAt: null,
  pagedAt: null,
  acknowledgedAt: null,
};

const gameDay = (over: Record<string, unknown>) => ({
  id: "gd1",
  name: "Checkout without its cache",
  description: "A probe pages on-call within five minutes",
  serviceId: "svc1",
  serviceName: "Checkout",
  status: "completed",
  endReason: "time_limit",
  startsAt: at(0),
  durationMinutes: 15,
  recoveryTimeoutMinutes: 30,
  freezeDuringRun: false,
  freezeId: null,
  watchedProbes: [{ id: "p1", name: "checkout", status: "up" }],
  watchedSloIds: [],
  armedAt: at(-60),
  armedByUserId: "u1",
  armedByEmail: "ada@example.com",
  injectedAt: at(0),
  endsAt: at(15),
  endRequestedAt: at(15),
  undoneAt: at(15),
  recoveredAt: at(17),
  completedAt: at(17),
  lastError: null,
  signals: {
    ...signals,
    probeFailedAt: at(1),
    probeDownAt: at(3),
    alertedAt: at(3),
    pagedAt: at(4),
  },
  targets: [
    {
      id: "t1",
      resourceId: "r1",
      accountId: "a1",
      pluginId: "kubernetes",
      resourceTypeId: "k8s-deployment",
      displayName: "redis",
      actionId: "scale-to-zero",
      actionLabel: "Scale to zero replicas",
      undoLabel: "Scale back to the previous replica count",
      state: "reverted",
      stateBefore: "3 replicas",
      injectedAt: at(0),
      revertedAt: at(15),
      attempts: 0,
      lastError: null,
    },
  ],
  createdAt: at(-120),
  updatedAt: at(17),
  ...over,
});

const LIST = {
  gameDays: [
    gameDay({}),
    gameDay({
      id: "gd2",
      name: "Database failover",
      status: "planned",
      endReason: null,
      startsAt: "2026-11-20T09:00:00.000Z",
      injectedAt: null,
      endsAt: null,
      endRequestedAt: null,
      undoneAt: null,
      recoveredAt: null,
      completedAt: null,
      armedAt: null,
      signals,
    }),
    gameDay({ id: "gd3", name: "Quiet failure", signals, status: "some_new_status" }),
  ],
};

const DETAIL = {
  gameDay: LIST.gameDays[0],
  alerts: [
    {
      id: "al1",
      at: at(3),
      trigger: "probeAlerts",
      severity: "critical",
      title: "Probe checkout is down",
      related: true,
      paged: true,
      unrouted: false,
    },
  ],
  report: {
    timeToDetectMs: 60_000,
    timeToPageMs: 240_000,
    timeToAcknowledgeMs: null,
    timeToRecoverMs: 120_000,
    injectedForMs: 900_000,
    detectedBy: "probe_failure",
    detectors: [
      { detector: "probe_failure", at: at(1), afterMs: 60_000, measurable: true },
      { detector: "slo_burn", at: null, afterMs: null, measurable: false },
      { detector: "acknowledge", at: null, afterMs: null, measurable: true },
    ],
    state: "final",
  },
};

describe("game-days", () => {
  it("is refused under --local", async () => {
    serveRoutes(out, {});
    expect(await run("game-days", "--local")).toBe(1);
    expect(out.stderr).toBe(
      "Game days live in Infrawrench Cloud. The poller injects and undoes them. Drop --local.\n",
    );
    expect(out.requests).toEqual([]);
  });

  it("lists game days with the time to detect, a newer status included", async () => {
    serveRoutes(out, { "GET /game-days": LIST });
    expect(await run("game-days")).toBe(0);
    expect(out.stdout).toContain("Acme · 3 game days");
    expect(out.stdout).toContain("Checkout without its cache");
    expect(out.stdout).toContain("1 min");
    expect(out.stdout).toContain("○ planned");
    expect(out.stdout).toContain("some_new_status");
    expect(out.stdout).toContain("not detected");
  });

  it("prints the raw rows under --json", async () => {
    serveRoutes(out, { "GET /game-days": LIST });
    expect(await run("game-days", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...LIST });
  });

  it("prints one report", async () => {
    serveRoutes(out, { "GET /game-days": LIST, "GET /game-days/gd1": DETAIL });
    expect(await run("game-days", "cache")).toBe(0);
    expect(out.stdout).toContain("detect 1 min · page 4 min · acknowledge - · recover 2 min");
    expect(out.stdout).toContain("first failed probe check");
    expect(out.stdout).toContain("not set up");
    expect(out.stdout).toContain("did not fire");
    expect(out.stdout).toContain("Scale to zero replicas");
    expect(out.stdout).toContain("Probe checkout is down");
  });

  it("prints one report raw under --json", async () => {
    serveRoutes(out, { "GET /game-days": LIST, "GET /game-days/gd1": DETAIL });
    expect(await run("game-days", "gd1", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...DETAIL });
  });

  it("aborts a game day by name", async () => {
    serveRoutes(out, {
      "GET /game-days": LIST,
      "POST /game-days/gd2/abort": { ...LIST.gameDays[1], status: "cancelled" },
    });
    expect(await run("game-days", "abort", "failover")).toBe(0);
    expect(out.requests).toEqual(["GET /game-days", "POST /game-days/gd2/abort"]);
    expect(out.stdout).toContain("Cancelled before it started.");
  });

  it("refuses a game day nothing matches", async () => {
    serveRoutes(out, { "GET /game-days": LIST });
    expect(await run("game-days", "nope")).toBe(1);
    expect(out.stderr).toBe('No game day matches "nope". Run `infrawrench game-days` to list.\n');
  });
});
