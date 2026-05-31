import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("@/db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));

vi.mock("@/services/encryption", () => ({
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ token: "secret" })),
  buildAad: vi.fn().mockReturnValue("aad"),
}));

const mockGetPlugin = vi.fn();
vi.mock("@/plugins/loader", () => ({ getPlugin: (...a: unknown[]) => mockGetPlugin(...a) }));

vi.mock("@/services/host-services", () => ({
  buildPluginHostServices: vi.fn().mockResolvedValue({}),
}));

const { handleSqlSession } = await import("@/services/sql-proxy");

function fakeWs() {
  const sent: unknown[] = [];
  return {
    sent,
    send: (msg: string) => sent.push(JSON.parse(msg)),
  };
}

function selectAccount(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

describe("handleSqlSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends sql:error when the account is not found", async () => {
    selectAccount([]);
    const ws = fakeWs();
    await handleSqlSession(ws as never, "org-1", "a1", "SELECT 1");
    expect(ws.sent[0]).toMatchObject({ type: "sql:error", error: "Account not found" });
  });

  it("sends sql:error when the plugin is not registered", async () => {
    selectAccount([
      { id: "a1", pluginId: "ghost", encryptedCredentials: "e", credentialsIv: "iv" },
    ]);
    mockGetPlugin.mockResolvedValue(null);
    const ws = fakeWs();
    await handleSqlSession(ws as never, "org-1", "a1", "SELECT 1");
    expect(ws.sent[0]).toMatchObject({ type: "sql:error", error: "Plugin not found" });
  });

  it("sends sql:error when the plugin lacks executeQuery", async () => {
    selectAccount([{ id: "a1", pluginId: "pg", encryptedCredentials: "e", credentialsIv: "iv" }]);
    mockGetPlugin.mockResolvedValue({
      plugin: { manifest: { id: "pg" }, createClient: () => ({}) },
    });
    const ws = fakeWs();
    await handleSqlSession(ws as never, "org-1", "a1", "SELECT 1");
    expect(ws.sent[0]).toMatchObject({ type: "sql:error" });
    expect((ws.sent[0] as { error: string }).error).toMatch(/does not support/);
  });

  it("streams sql:result when executeQuery succeeds", async () => {
    selectAccount([{ id: "a1", pluginId: "pg", encryptedCredentials: "e", credentialsIv: "iv" }]);
    const executeQuery = vi.fn().mockResolvedValue({ rows: [{ x: 1 }], durationMs: 12 });
    mockGetPlugin.mockResolvedValue({
      plugin: { manifest: { id: "pg" }, createClient: () => ({ executeQuery }) },
    });
    const ws = fakeWs();
    await handleSqlSession(ws as never, "org-1", "a1", "SELECT 1");
    expect(ws.sent[0]).toMatchObject({ type: "sql:result", rows: [{ x: 1 }], durationMs: 12 });
  });

  it("sends sql:error with the thrown message on failure", async () => {
    selectAccount([{ id: "a1", pluginId: "pg", encryptedCredentials: "e", credentialsIv: "iv" }]);
    const executeQuery = vi.fn().mockRejectedValue(new Error("syntax error"));
    mockGetPlugin.mockResolvedValue({
      plugin: { manifest: { id: "pg" }, createClient: () => ({ executeQuery }) },
    });
    const ws = fakeWs();
    await handleSqlSession(ws as never, "org-1", "a1", "SELECT bad");
    expect(ws.sent[0]).toMatchObject({ type: "sql:error", error: "syntax error" });
  });
});
