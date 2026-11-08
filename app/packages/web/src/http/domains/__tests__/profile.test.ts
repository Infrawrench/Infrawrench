import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi, TEST_SESSION } from "@/http/testing";

const userManagement = {
  getUser: vi.fn(),
  getUserIdentities: vi.fn(),
  updateUser: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  listAuthFactors: vi.fn(),
  enrollAuthFactor: vi.fn(),
  createPasswordReset: vi.fn(),
  sendVerificationEmail: vi.fn(),
};
const mfa = { verifyChallenge: vi.fn(), challengeFactor: vi.fn(), deleteFactor: vi.fn() };
const mockWorkosPost = vi.fn();
vi.mock("@/auth/workos", () => ({
  workos: { userManagement, mfa, post: (...a: unknown[]) => mockWorkosPost(...a) },
  clientId: "client-1",
}));

const mockSet = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    update: () => ({ set: (v: unknown) => (mockSet(v), { where: () => Promise.resolve() }) }),
  },
}));

const mockDeleteAccount = vi.fn();
const mockPlan = vi.fn();
vi.mock("@/services/account-deletion", async () => {
  class AccountDeletionError extends Error {
    constructor(
      message: string,
      readonly status: 409 | 502,
      readonly code: string,
      readonly details?: Record<string, unknown>,
    ) {
      super(message);
    }
  }
  return {
    AccountDeletionError,
    deleteAccount: (...a: unknown[]) => mockDeleteAccount(...a),
    planAccountDeletion: (...a: unknown[]) => mockPlan(...a),
  };
});

const { profileDomain } = await import("@/http/domains/profile/index");
const { AccountDeletionError } = await import("@/services/account-deletion");

/** A browser session, which is what carries a WorkOS `sid`. */
const BROWSER = { ...TEST_SESSION, sessionId: "sess_current" };
const buildApp = (session: { userId: string; email: string; sessionId?: string } = BROWSER) =>
  buildTestApi(profileDomain, { basePath: "/api/profile", principal: { session } });

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** WorkOS lists the current session as established `ageMs` ago, plus one other. */
function sessionsEstablished(ageMs: number) {
  userManagement.listSessions.mockResolvedValue({
    data: [
      {
        id: "sess_current",
        status: "active",
        createdAt: new Date(Date.now() - ageMs).toISOString(),
        updatedAt: "2026-11-01T00:00:00.000Z",
        expiresAt: "2027-11-01T00:00:00.000Z",
        ipAddress: "203.0.113.1",
        userAgent: "Firefox",
        authMethod: "password",
      },
      {
        id: "sess_other",
        status: "active",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2027-10-01T00:00:00.000Z",
        ipAddress: null,
        userAgent: null,
        authMethod: "sso",
      },
      {
        id: "sess_gone",
        status: "revoked",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2027-09-01T00:00:00.000Z",
        ipAddress: null,
        userAgent: null,
        authMethod: "sso",
      },
    ],
  });
}

const RECENT = 60_000;
const STALE = 60 * 60 * 1000;

describe("profile routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionsEstablished(RECENT);
  });

  describe("step-up re-authentication", () => {
    it("refuses a stale sign-in with the code the client re-authenticates on", async () => {
      sessionsEstablished(STALE);
      const res = await buildApp().request("/mfa/f1", { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "For your security, please sign in again to confirm this change.",
        code: "reauthentication_required",
      });
      expect(mfa.deleteFactor).not.toHaveBeenCalled();
    });

    it("refuses a bearer principal, which has no interactive session", async () => {
      const res = await buildApp(TEST_SESSION).request("/sessions/revoke-others", {
        method: "POST",
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "This action requires a recent sign-in from a browser session.",
        code: "reauthentication_required",
      });
      expect(userManagement.revokeSession).not.toHaveBeenCalled();
    });

    it("checks before reading the body", async () => {
      sessionsEstablished(STALE);
      const res = await buildApp().request("/email-change", json("POST", {}));
      expect(res.status).toBe(403);
    });

    it("lets a recent sign-in through", async () => {
      userManagement.listAuthFactors.mockResolvedValue({ data: [{ id: "f1" }] });
      const res = await buildApp().request("/mfa/f1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mfa.deleteFactor).toHaveBeenCalledWith("f1");
    });
  });

  describe("MFA factors", () => {
    it("refuses a factor the caller does not own", async () => {
      userManagement.listAuthFactors.mockResolvedValue({ data: [{ id: "mine" }] });
      const res = await buildApp().request("/mfa/theirs", { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Factor not found" });
      expect(mfa.deleteFactor).not.toHaveBeenCalled();
    });

    it("checks the verify body before ownership", async () => {
      const res = await buildApp().request("/mfa/f1/verify", json("POST", { code: "123456" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "challengeId and code are required" });
      expect(userManagement.listAuthFactors).not.toHaveBeenCalled();
    });

    it("verifies a trimmed code against the challenge", async () => {
      userManagement.listAuthFactors.mockResolvedValue({ data: [{ id: "f1" }] });
      mfa.verifyChallenge.mockResolvedValue({ valid: true });
      const res = await buildApp().request(
        "/mfa/f1/verify",
        json("POST", { challengeId: "c1", code: " 123456 " }),
      );
      expect(await res.json()).toEqual({ verified: true });
      expect(mfa.verifyChallenge).toHaveBeenCalledWith({
        authenticationChallengeId: "c1",
        code: "123456",
      });
    });

    it("lists factors in the documented shape", async () => {
      userManagement.listAuthFactors.mockResolvedValue({
        data: [
          {
            id: "f1",
            type: "totp",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            totp: { issuer: "Infrawrench", user: "test@example.com" },
          },
        ],
      });
      const res = await buildApp().request("/mfa");
      expect(await res.json()).toEqual([
        {
          id: "f1",
          type: "totp",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          totpIssuer: "Infrawrench",
          totpUser: "test@example.com",
        },
      ]);
    });
  });

  describe("sessions", () => {
    it("lists active sessions and marks the one making the request", async () => {
      const res = await buildApp().request("/sessions");
      const body = (await res.json()) as Array<{ id: string; current: boolean }>;
      expect(body.map((s) => [s.id, s.current])).toEqual([
        ["sess_current", true],
        ["sess_other", false],
      ]);
    });

    it("refuses to revoke the session making the request", async () => {
      const res = await buildApp().request("/sessions/sess_current", { method: "DELETE" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Use sign out to end the session you're using right now",
      });
      expect(userManagement.revokeSession).not.toHaveBeenCalled();
    });

    it("refuses a session that is not the caller's", async () => {
      const res = await buildApp().request("/sessions/sess_someone", { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Session not found" });
    });

    it("revokes another of the caller's sessions", async () => {
      const res = await buildApp().request("/sessions/sess_other", { method: "DELETE" });
      expect(await res.json()).toEqual({ ok: true });
      expect(userManagement.revokeSession).toHaveBeenCalledWith({ sessionId: "sess_other" });
    });

    it("revokes every other active session", async () => {
      const res = await buildApp().request("/sessions/revoke-others", { method: "POST" });
      expect(await res.json()).toEqual({ revoked: 1 });
      expect(userManagement.revokeSession.mock.calls).toEqual([[{ sessionId: "sess_other" }]]);
    });
  });

  describe("name and email", () => {
    it("refuses a body with neither name", async () => {
      const res = await buildApp().request("/", json("PATCH", {}));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Provide firstName and/or lastName" });
    });

    it("refuses a name that is not a short string", async () => {
      const res = await buildApp().request("/", json("PATCH", { firstName: "x".repeat(129) }));
      expect(await res.json()).toEqual({
        error: "Names must be strings of at most 128 characters",
      });
    });

    it("updates WorkOS and the mirrored display name", async () => {
      userManagement.updateUser.mockResolvedValue({
        id: "user-1",
        email: "test@example.com",
        emailVerified: true,
        firstName: "Ada",
        lastName: null,
        profilePictureUrl: null,
        lastSignInAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const res = await buildApp().request("/", json("PATCH", { firstName: "  Ada " }));
      expect(res.status).toBe(200);
      expect(userManagement.updateUser).toHaveBeenCalledWith({
        userId: "user-1",
        firstName: "Ada",
      });
      expect(mockSet).toHaveBeenCalledWith({ displayName: "Ada" });
    });

    it("answers a WorkOS email-change refusal with its own sentence", async () => {
      userManagement.getUser.mockResolvedValue({ email: "test@example.com" });
      mockWorkosPost.mockRejectedValue(new Error("Email already in use"));
      const res = await buildApp().request(
        "/email-change",
        json("POST", { newEmail: "new@example.com" }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Email already in use" });
    });

    it("moves the mirrored email when the change is confirmed", async () => {
      mockWorkosPost.mockResolvedValue({
        data: { user: { id: "user-1", email: "new@example.com" } },
      });
      const res = await buildApp().request("/email-change/confirm", json("POST", { code: "42" }));
      expect(await res.json()).toEqual({ email: "new@example.com" });
      expect(mockSet).toHaveBeenCalledWith({ email: "new@example.com" });
    });
  });

  describe("DELETE /", () => {
    it("passes the ownership refusal through with its details, keeping the cookie", async () => {
      mockDeleteAccount.mockRejectedValue(
        new AccountDeletionError(
          "Transfer ownership of your organizations before deleting your account.",
          409,
          "transfer_ownership_required",
          { organizations: [{ id: "o1", name: "Acme", memberCount: 3 }] },
        ),
      );
      const res = await buildApp().request("/", { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "Transfer ownership of your organizations before deleting your account.",
        code: "transfer_ownership_required",
        organizations: [{ id: "o1", name: "Acme", memberCount: 3 }],
      });
      expect(res.headers.getSetCookie()).toEqual([]);
    });

    it("deletes the account and clears the session cookie", async () => {
      mockDeleteAccount.mockResolvedValue({ organizationsDeleted: 2 });
      const res = await buildApp().request("/", { method: "DELETE" });
      expect(await res.json()).toEqual({ ok: true, organizationsDeleted: 2 });
      expect(res.headers.getSetCookie()).toEqual(["wos-session=; Max-Age=0; Path=/"]);
      expect(mockDeleteAccount).toHaveBeenCalledWith("user-1");
    });

    it("refuses a stale sign-in before deleting anything", async () => {
      sessionsEstablished(STALE);
      const res = await buildApp().request("/", { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(mockDeleteAccount).not.toHaveBeenCalled();
    });
  });
});
