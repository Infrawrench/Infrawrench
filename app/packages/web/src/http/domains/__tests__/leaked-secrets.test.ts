import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

class FakeLeakedSecretError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 = 400,
  ) {
    super(message);
  }
}

const mockRotate = vi.fn();
const mockReopen = vi.fn();
const mockList = vi.fn();
vi.mock("@infrawrench/server-core/leaked-secrets/actions", () => ({
  LeakedSecretError: FakeLeakedSecretError,
  rotateLeak: (...a: unknown[]) => mockRotate(...a),
  markLeakRotated: vi.fn(),
  dismissLeak: vi.fn(),
  reopenLeak: (...a: unknown[]) => mockReopen(...a),
}));
vi.mock("@infrawrench/server-core/leaked-secrets/store", () => ({
  listLeakedSecrets: (...a: unknown[]) => mockList(...a),
}));
vi.mock("@infrawrench/server-core/leaked-secrets/scan", () => ({
  scanOrgLeakedSecretsNow: vi.fn(),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { leakedSecretsDomain } = await import("@/http/domains/leaked-secrets/index");
const basePath = "/api/org/org-1/leaked-secrets";
const app = (permissions?: readonly string[]) =>
  buildTestApi(leakedSecretsDomain, { basePath, ...(permissions ? { permissions } : {}) });

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

beforeEach(() => vi.clearAllMocks());

describe("leaked secret routes", () => {
  it("filters the list by status and refuses an unknown one", async () => {
    mockList.mockResolvedValue({ leaks: [], scanners: [] });
    expect((await app(["resources:read"]).request("/?status=open")).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("org-1", { status: "open" });
    const bad = await app().request("/?status=nope");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Unknown status" });
  });

  it("rotates with the caller as actor and audits without the value", async () => {
    mockRotate.mockResolvedValue({
      id: "l1",
      tokenType: "github_pat",
      rotationMethod: "replaced",
      matchKind: "account",
    });
    const res = await app().request("/l1/rotate", post({ value: "secret" }));
    expect(res.status).toBe(200);
    expect(mockRotate).toHaveBeenCalledWith(
      "org-1",
      "l1",
      { value: "secret", resolveUpstream: undefined },
      { userId: "user-1", userLabel: "test@example.com" },
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "leaked_secret.rotated",
        metadata: { tokenType: "github_pat", method: "replaced", matchKind: "account" },
      }),
    );
  });

  it("checks the action bodies by hand", async () => {
    expect((await app().request("/l1/rotate", post({ value: 1 }))).status).toBe(400);
    const res = await app().request("/l1/rotate", post({ resolveUpstream: "yes" }));
    expect(await res.json()).toEqual({ error: "resolveUpstream must be a boolean" });
    const dismiss = await app().request("/l1/dismiss", post({ reason: "bored" }));
    expect(dismiss.status).toBe(400);
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it("answers an action's refusal with the status it carries", async () => {
    for (const status of [404, 409, 502] as const) {
      mockReopen.mockRejectedValueOnce(new FakeLeakedSecretError(`refused ${status}`, status));
      const res = await app().request("/l1/reopen", { method: "POST" });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: `refused ${status}` });
    }
  });

  it("needs secrets:write for every action", async () => {
    const res = await app(["resources:read"]).request("/l1/reopen", { method: "POST" });
    expect(res.status).toBe(403);
    expect(mockReopen).not.toHaveBeenCalled();
  });
});
