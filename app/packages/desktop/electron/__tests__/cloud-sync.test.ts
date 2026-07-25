import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted so the vi.mock factories below can reference them) ----

const h = vi.hoisted(() => {
  const sentEvents: Array<{ event: string; data: Record<string, unknown> }> = [];

  // In-memory stand-in for the local SQLite DB. Tracks cloud_sync_state
  // writes so tests can assert the pull cursor is never advanced.
  const syncState = new Map<string, string>();
  const localRows = {
    accounts: [] as Array<Record<string, unknown>>,
    dashboards: [] as Array<Record<string, unknown>>,
  };

  const dbExecute = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("cloud_sync_state")) {
      syncState.set(String(params?.[0]), String(params?.[1]));
    }
  });

  const dbSelect = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM cloud_sync_state")) {
      const value = syncState.get(String(params?.[0]));
      return value == null ? [] : [{ value }];
    }
    if (sql.includes("FROM accounts")) return localRows.accounts;
    if (sql.includes("FROM dashboards")) return localRows.dashboards;
    return [];
  });

  return {
    sentEvents,
    syncState,
    localRows,
    dbExecute,
    dbSelect,
    getAccessToken: vi.fn<() => Promise<string | null>>(),
    fetchMock: vi.fn<typeof fetch>(),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (event: string, data: Record<string, unknown>) => {
            h.sentEvents.push({ event, data });
          },
        },
      },
    ],
  },
}));

vi.mock("../cloud-auth", () => ({
  getAccessToken: () => h.getAccessToken(),
}));

vi.mock("../../env", () => ({ CLOUD_URL: "https://cloud.test" }));

vi.mock("../main-utils", () => ({
  getDb: async () => ({ select: h.dbSelect, execute: h.dbExecute }),
  getEncryptionKey: () => Buffer.alloc(32),
  decryptValue: () => JSON.stringify({ apiKey: "plain" }),
  buildAad: (t: string, i: string, f: string) => `${t}:${i}:${f}`,
}));

vi.stubGlobal("fetch", h.fetchMock);

import { runSyncCycle } from "../cloud-sync";

// --- Helpers ---------------------------------------------------------------

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function statusEvents(): Array<Record<string, unknown>> {
  return h.sentEvents.filter((e) => e.event === "cloud-sync-status").map((e) => e.data);
}

beforeEach(() => {
  h.sentEvents.length = 0;
  h.syncState.clear();
  h.localRows.accounts = [];
  h.localRows.dashboards = [];
  h.dbExecute.mockClear();
  h.dbSelect.mockClear();
  h.fetchMock.mockReset();
  h.getAccessToken.mockReset();
});

// --- runSyncCycle ------------------------------------------------------------

describe("runSyncCycle", () => {
  it("reports push-only synced status after a successful push", async () => {
    h.getAccessToken.mockResolvedValue("tok");

    await runSyncCycle();

    const events = statusEvents();
    expect(events[0]).toEqual({ status: "syncing" });
    // `pushOnly` is the permanent shape of cloud sync, not a temporary caveat:
    // cloud mode reads live from the API, so there is no local mirror to claim
    // was refreshed.
    expect(events[1]).toMatchObject({ status: "synced", pushOnly: true });
    expect(events[1]?.["lastSyncedAt"]).toEqual(expect.any(String));
    expect(h.syncState.has("last_sync_version")).toBe(false);
  });

  it("makes no pull request — sync is push-only", async () => {
    h.getAccessToken.mockResolvedValue("tok");

    await runSyncCycle();

    // A downward probe was scaffolding for an apply that is not coming; it cost
    // a request per cycle and produced nothing but a log line.
    for (const [url] of h.fetchMock.mock.calls as Array<[string]>) {
      expect(url).not.toContain("/sync/pull");
    }
  });

  it("reports an error when push fails", async () => {
    h.getAccessToken.mockResolvedValue("tok");
    h.localRows.dashboards = [
      {
        id: "d1",
        name: "Main",
        is_default: 1,
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
      },
    ];
    h.fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 503));

    await runSyncCycle();

    const events = statusEvents();
    expect(events.map((e) => e["status"])).toEqual(["syncing", "error"]);
    expect(events[1]).toMatchObject({ error: "Push failed: 503" });
    // A failed push must not advance the push watermark either.
    expect(h.syncState.has("last_push_at")).toBe(false);
  });

  it("does nothing when there is no access token", async () => {
    h.getAccessToken.mockResolvedValue(null);

    await runSyncCycle();

    expect(statusEvents()).toEqual([]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});
