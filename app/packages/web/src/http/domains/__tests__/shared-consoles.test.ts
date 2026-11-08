import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const invites = await vi.importActual<
  typeof import("@infrawrench/server-core/shared-console/invites")
>("@infrawrench/server-core/shared-console/invites");

const store = {
  getSharedConsole: vi.fn(),
  getParticipant: vi.fn(),
  listParticipants: vi.fn(),
  closeSharedConsole: vi.fn(),
  createSharedConsole: vi.fn(),
};
class InviteRaceLostError extends Error {}
class DriverRaceLostError extends Error {}
vi.mock("@infrawrench/server-core/shared-console/store", () => ({
  ...invites,
  InviteRaceLostError,
  DriverRaceLostError,
  getSharedConsole: (...a: unknown[]) => store.getSharedConsole(...a),
  getParticipant: (...a: unknown[]) => store.getParticipant(...a),
  listParticipants: (...a: unknown[]) => store.listParticipants(...a),
  closeSharedConsole: (...a: unknown[]) => store.closeSharedConsole(...a),
  createSharedConsole: (...a: unknown[]) => store.createSharedConsole(...a),
  listActiveSharedConsoles: vi.fn(),
  admitParticipant: vi.fn(),
  detachParticipant: vi.fn(),
  getInviteHash: vi.fn(),
  getParticipantById: vi.fn(),
  replaceInvite: vi.fn(),
  requestDriver: vi.fn(),
  setDriver: vi.fn(),
  withdrawInvite: vi.fn(),
}));

const relay = { describeConsole: vi.fn(), revokeShare: vi.fn() };
vi.mock("@/services/shared-console/relay", () => ({
  describeConsole: (...a: unknown[]) => relay.describeConsole(...a),
  revokeShare: (...a: unknown[]) => relay.revokeShare(...a),
  bindShare: vi.fn(),
  markShare: vi.fn(),
  refreshShare: vi.fn(),
  detachParticipant: vi.fn(),
}));
vi.mock("@/services/shared-console/hub", () => ({
  publicShare: (share: { id: string }) => ({ id: share.id }),
  publicParticipant: (p: { id: string }) => ({ id: p.id }),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { sharedConsolesDomain } = await import("@/http/domains/shared-consoles/index");
const buildApp = (permissions?: string[]) =>
  buildTestApi(sharedConsolesDomain, {
    basePath: "/api/org/org-1/shared-consoles",
    ...(permissions ? { permissions } : {}),
  });

const SHARE_ID = "11111111-1111-4111-8111-111111111111";
const share = (over: Record<string, unknown> = {}) => ({
  id: SHARE_ID,
  organizationId: "org-1",
  status: "active",
  ownerUserId: "someone-else",
  allowHandover: true,
  inviteExpiresAt: null,
  inviteConsumedAt: null,
  host: "db-1",
  username: "root",
  accountId: null,
  resourceId: null,
  recordingId: null,
  ...over,
});

const post = (path: string, body: unknown) =>
  buildApp().request(path, { method: "POST", body: JSON.stringify(body) });

describe("Shared console routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("POST /", () => {
    const body = {
      liveConsoleId: "22222222-2222-4222-8222-222222222222",
      routingKey: "route-key-1",
    };

    it("refuses a body as the zod validator did, with its first sentence", async () => {
      const res = await post("/", { ...body, liveConsoleId: "nope" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid uuid" });
      expect(relay.describeConsole).not.toHaveBeenCalled();
    });

    it("refuses an unknown field (strict)", async () => {
      const res = await post("/", { ...body, host: "elsewhere" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unrecognized key(s) in object: 'host'" });
    });

    it("409s with a code when the pty is not held by this replica", async () => {
      relay.describeConsole.mockResolvedValue(null);
      const res = await post("/", body);
      expect(res.status).toBe(409);
      expect(await res.text()).toBe(
        JSON.stringify({
          error:
            "That terminal session is not held by this server. Reopen the terminal and share again.",
          code: "console_not_here",
        }),
      );
      expect(store.createSharedConsole).not.toHaveBeenCalled();
    });

    it("needs resources:execute", async () => {
      const res = await buildApp(["resources:read"]).request("/", {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /:consoleId", () => {
    it("answers somebody else's share with the arbitration denial and its code", async () => {
      store.getSharedConsole.mockResolvedValue(share());
      const res = await buildApp(["resources:execute"]).request(`/${SHARE_ID}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "Only the person sharing this console, or an org administrator, can do that.",
        code: "not-owner",
      });
      expect(store.closeSharedConsole).not.toHaveBeenCalled();
    });

    it("lets the sharer revoke without resources:execute", async () => {
      store.getSharedConsole.mockResolvedValue(share({ ownerUserId: "user-1" }));
      store.closeSharedConsole.mockResolvedValue({ id: SHARE_ID });
      const res = await buildApp([]).request(`/${SHARE_ID}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(store.closeSharedConsole).toHaveBeenCalledWith(SHARE_ID, "revoked", "user-1");
      expect(relay.revokeShare).toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "shared_console.revoked" }),
      );
    });

    it("404s a share in another org", async () => {
      store.getSharedConsole.mockResolvedValue(share({ organizationId: "org-2" }));
      const res = await buildApp().request(`/${SHARE_ID}`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    });
  });

  describe("POST /:consoleId/join", () => {
    it("asks for a token with the route's own sentence", async () => {
      const res = await post(`/${SHARE_ID}/join`, {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "An invite token is required." });
    });
  });
});
