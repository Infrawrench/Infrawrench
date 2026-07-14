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

import { pullChanges, runSyncCycle } from "../cloud-sync";

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

// --- pullChanges -------------------------------------------------------------

describe("pullChanges", () => {
  it("requests versions above the stored cursor", async () => {
    h.syncState.set("last_sync_version", "3");
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ accounts: [], resources: [], dashboards: [] }),
    );

    await pullChanges("tok");

    expect(h.fetchMock).toHaveBeenCalledWith(
      "https://cloud.test/api/v1/sync/pull",
      expect.objectContaining({ body: JSON.stringify({ lastSyncVersion: 3 }) }),
    );
  });

  it("does NOT advance last_sync_version even when records are returned (they are not applied)", async () => {
    h.syncState.set("last_sync_version", "3");
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({
        accounts: [{ id: "a1", syncVersion: 7 }],
        resources: [{ id: "r1", syncVersion: 9 }],
        dashboards: [{ id: "d1", syncVersion: 8 }],
      }),
    );

    const pending = await pullChanges("tok");

    // Advancing the cursor without applying would permanently skip these
    // records once pull-apply is implemented.
    expect(h.syncState.get("last_sync_version")).toBe("3");
    expect(h.dbExecute).not.toHaveBeenCalled();
    expect(pending).toEqual({ accounts: 1, resources: 1, dashboards: 1 });
  });

  it("defaults the cursor to 0 and leaves it unset", async () => {
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ accounts: [{ id: "a1", syncVersion: 1 }], resources: [], dashboards: [] }),
    );

    await pullChanges("tok");

    expect(h.fetchMock).toHaveBeenCalledWith(
      "https://cloud.test/api/v1/sync/pull",
      expect.objectContaining({ body: JSON.stringify({ lastSyncVersion: 0 }) }),
    );
    expect(h.syncState.has("last_sync_version")).toBe(false);
  });

  it("throws on a non-OK response", async () => {
    h.fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 500));

    await expect(pullChanges("tok")).rejects.toThrow("Pull failed: 500");
  });
});

// --- runSyncCycle ------------------------------------------------------------

describe("runSyncCycle", () => {
  it("reports push-only synced status after a successful push", async () => {
    h.getAccessToken.mockResolvedValue("tok");
    // No local changes -> push skips the network; pull probe returns pending data.
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ accounts: [{ id: "a1", syncVersion: 5 }], resources: [], dashboards: [] }),
    );

    await runSyncCycle();

    const events = statusEvents();
    expect(events[0]).toEqual({ status: "syncing" });
    expect(events[1]).toMatchObject({ status: "synced", pushOnly: true });
    expect(events[1]?.["lastSyncedAt"]).toEqual(expect.any(String));
    // Pull probe must not advance the cursor.
    expect(h.syncState.has("last_sync_version")).toBe(false);
  });

  it("still reports synced when the pull probe fails (pull applies nothing)", async () => {
    h.getAccessToken.mockResolvedValue("tok");
    h.fetchMock.mockRejectedValueOnce(new Error("network down"));

    await runSyncCycle();

    const events = statusEvents();
    expect(events.map((e) => e["status"])).toEqual(["syncing", "synced"]);
    expect(events[1]).toMatchObject({ pushOnly: true });
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
