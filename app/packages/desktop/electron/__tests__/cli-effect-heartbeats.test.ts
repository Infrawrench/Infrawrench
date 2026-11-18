import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `heartbeats` on effect/cli: text and `--json` output and refusals, against
// fixtures. Nothing reaches a network or a database.
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

const NOW = Date.parse("2026-11-08T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const heartbeat = (over: Record<string, unknown>) => ({
  id: "h1",
  name: "Nightly backup",
  scheduleKind: "cron",
  cronExpression: "0 2 * * *",
  timezone: "Europe/London",
  intervalMinutes: null,
  graceMinutes: 30,
  enabled: true,
  status: "up",
  downReason: null,
  pingUrl: "https://app.example.test/api/ping/abcdefghjkmnpqrstuvwxyz23456789ab",
  lastPingAt: "2026-11-08T02:04:00.000Z",
  lastStartAt: "2026-11-08T02:00:00.000Z",
  lastFailAt: null,
  lastDurationMs: 240_000,
  nextExpectedAt: "2026-11-09T02:00:00.000Z",
  deadlineAt: "2026-11-09T02:30:00.000Z",
  lastStateChangeAt: null,
  accountId: null,
  resourceId: null,
  pluginId: null,
  resourceTypeId: null,
  fieldKey: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const LIST = {
  heartbeats: [
    heartbeat({}),
    heartbeat({
      id: "h2",
      name: "Invoice sync",
      scheduleKind: "interval",
      cronExpression: null,
      timezone: "UTC",
      intervalMinutes: 60,
      graceMinutes: 10,
      status: "down",
      downReason: "missed",
      lastDurationMs: null,
    }),
    heartbeat({ id: "h3", name: "Reindex", enabled: false, status: "new", lastPingAt: null }),
    // A status a newer server added renders rather than failing the decode.
    heartbeat({ id: "h4", name: "Future", status: "degraded" }),
  ],
};

const PINGS = {
  pings: [
    {
      id: "p3",
      kind: "success",
      receivedAt: "2026-11-08T02:04:00.000Z",
      durationMs: 240_000,
      method: "GET",
      userAgent: "curl/8",
      body: null,
    },
    {
      id: "p2",
      kind: "start",
      receivedAt: "2026-11-08T02:00:00.000Z",
      durationMs: null,
      method: "GET",
      userAgent: "curl/8",
      body: null,
    },
    {
      id: "p1",
      kind: "fail",
      receivedAt: "2026-11-07T02:03:00.000Z",
      durationMs: 180_000,
      method: "POST",
      userAgent: "curl/8",
      body: "disk full\nmore",
    },
  ],
};

describe("heartbeats", () => {
  it("lists heartbeats", async () => {
    serveRoutes(out, { "GET /heartbeats": LIST });
    expect(await run("heartbeats")).toBe(0);
    expect(out.stdout).toContain("Acme · 4 heartbeats  1 down");
    expect(out.stdout).toContain("● up");
    expect(out.stdout).toContain("● missed");
    expect(out.stdout).toContain("○ paused");
    expect(out.stdout).toContain("0 2 * * * (Europe/London)");
    expect(out.stdout).toContain("every 1h");
    expect(out.stdout).toContain("4m 0s");
    expect(out.stdout).toContain("Future");
  });

  it("prints the raw rows under --json", async () => {
    serveRoutes(out, { "GET /heartbeats": LIST });
    expect(await run("heartbeats", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...LIST });
  });

  it("shows one heartbeat matched by name", async () => {
    serveRoutes(out, { "GET /heartbeats": LIST, "GET /heartbeats/h1/pings": PINGS });
    expect(await run("heartbeats", "nightly")).toBe(0);
    expect(out.stdout).toContain("Nightly backup  ● up");
    expect(out.stdout).toContain(LIST.heartbeats[0]!.pingUrl);
    expect(out.stdout).toContain("min 3m 0s · max 4m 0s · 2 runs");
    expect(out.stdout).toContain("disk full");
    expect(out.stdout).not.toContain("more");
  });

  it("prints one heartbeat's raw row and pings under --json", async () => {
    serveRoutes(out, { "GET /heartbeats": LIST, "GET /heartbeats/h2/pings": PINGS });
    expect(await run("heartbeats", "h2", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      org: "org_1",
      heartbeat: LIST.heartbeats[1],
      pings: PINGS.pings,
    });
  });

  it("refuses a heartbeat nothing matches", async () => {
    serveRoutes(out, { "GET /heartbeats": LIST });
    expect(await run("heartbeats", "nope")).toBe(1);
    expect(out.stderr).toBe('No heartbeat matches "nope". Run `infrawrench heartbeats` to list.\n');
  });

  it("is refused in local mode", async () => {
    serveRoutes(out, {});
    expect(await run("heartbeats", "--local")).toBe(1);
    expect(out.stderr).toBe(
      "Heartbeats live in Infrawrench Cloud: jobs ping the cloud app. Drop --local.\n",
    );
    expect(out.requests).toEqual([]);
  });
});
