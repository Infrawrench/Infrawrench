import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * The per-resource action endpoints: the NDJSON chat turn streams through the
 * HttpApi router as the plugin yields, and the destructive ones stop at the
 * change freeze before the plugin is called.
 */

const deleteResource = vi.fn(async () => {});
async function* streamChatMessage() {
  yield { kind: "delta", text: "Hel" };
  yield { kind: "delta", text: "lo" };
  throw new Error("upstream closed");
}
vi.mock("../../../services/plugin-clients", () => ({
  getClientForResource: vi.fn(async () => ({
    client: { streamChatMessage, deleteResource },
    plugin: { manifest: { id: "fake" }, resourceTypes: [] },
    account: { id: "acct-1", pluginId: "other" },
  })),
  getClientForAccount: vi.fn(),
}));
const evaluateChangeFreeze = vi.fn(async (): Promise<unknown> => null);
vi.mock("../../../services/change-freezes", () => ({
  CHANGE_FREEZE_OVERRIDE_HEADER: "x-change-freeze-override",
  evaluateChangeFreeze: () => evaluateChangeFreeze(),
  getActiveChangeFreeze: vi.fn(async () => null),
  isActionDestructive: vi.fn(async () => false),
}));
vi.mock("@infrawrench/server-core/savings/capture", () => ({
  captureDeletionSaving: vi.fn(async () => {}),
  captureResizeSaving: vi.fn(async () => {}),
}));

const { resourcesDomain } = await import("@/http/domains/resources/index");
const app = () => buildTestApi(resourcesDomain, { basePath: "/api/org/org-1/resources" });
const target = {
  pluginId: "fake",
  accountId: "acct-1",
  resourceTypeId: "agent",
  resourceId: "acct-1:agent:a1",
};

beforeEach(() => {
  vi.clearAllMocks();
  evaluateChangeFreeze.mockResolvedValue(null);
});

describe("POST /chat-stream", () => {
  it("streams one NDJSON line per event, and the error that ended the turn", async () => {
    const res = await app().request("/chat-stream", {
      method: "POST",
      body: JSON.stringify({ ...target, messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { kind: "delta", text: "Hel" },
      { kind: "delta", text: "lo" },
      { kind: "error", message: "upstream closed" },
    ]);
  });

  it("is gated on resources:execute", async () => {
    const res = await buildTestApi(resourcesDomain, {
      basePath: "/api/org/org-1/resources",
      permissions: ["resources:read"],
    }).request("/chat-stream", {
      method: "POST",
      body: JSON.stringify({ ...target, messages: [] }),
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /:pluginId/:typeId", () => {
  const remove = (query: string) => app().request(`/fake/agent?${query}`, { method: "DELETE" });

  it("names the missing query parameter", async () => {
    expect(await (await remove("accountId=acct-1")).json()).toEqual({
      error: "Missing resourceId",
    });
    expect(await (await remove("resourceId=acct-1:agent:a1")).json()).toEqual({
      error: "Missing accountId",
    });
  });

  it("deletes through the plugin", async () => {
    const res = await remove("resourceId=acct-1:agent:a1&accountId=acct-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteResource).toHaveBeenCalledWith("agent", "acct-1:agent:a1", "acct-1");
  });

  it("stops at an active change freeze before the plugin is called", async () => {
    const blocked = {
      error: "Changes are frozen",
      code: "change_freeze_active",
      freeze: {
        id: "f1",
        name: "Release",
        reason: null,
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt: null,
      },
    };
    evaluateChangeFreeze.mockResolvedValue(blocked);
    const res = await remove("resourceId=acct-1:agent:a1&accountId=acct-1");
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual(blocked);
    expect(deleteResource).not.toHaveBeenCalled();
  });
});
