import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The WorkOS webhook is outside every auth layer, so the route's ordering is
 * the security property: signature first (before parsing), then the org
 * lookup, then the replay claim, and a failed handler un-claims so WorkOS's
 * retry is processed rather than dropped as a duplicate.
 */
const mockClaim = vi.fn();
const mockRelease = vi.fn();
const mockHandle = vi.fn();
const mockOrgId = vi.fn();
const mockFindSettings = vi.fn();

vi.mock("@/services/sso/webhook", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/sso/webhook")>("@/services/sso/webhook");
  return {
    verifyWorkosSignature: actual.verifyWorkosSignature,
    parseWorkosEvent: actual.parseWorkosEvent,
    claimEvent: (...a: unknown[]) => mockClaim(...a),
    releaseEvent: (...a: unknown[]) => mockRelease(...a),
    handleWorkosEvent: (...a: unknown[]) => mockHandle(...a),
    eventWorkosOrgId: (...a: unknown[]) => mockOrgId(...a),
  };
});
vi.mock("@/services/sso/settings", () => ({
  findSsoSettingsByWorkosOrg: (...a: unknown[]) => mockFindSettings(...a),
}));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/services/sso/directory-sync", () => ({}));
vi.mock("@/services/sso/workos-api", () => ({}));

const { workosWebhookRoutes } = await import("@/api/routes/workos-webhook");

const SECRET = "test-webhook-secret-not-real";
const body = JSON.stringify({
  id: "event_01TEST",
  event: "dsync.user.deleted",
  data: { id: "directory_user_01TEST", organization_id: "org_wos" },
});

function post(payload: string, signature?: string) {
  return workosWebhookRoutes.request("/", {
    method: "POST",
    body: payload,
    headers: signature ? { "WorkOS-Signature": signature } : {},
  });
}

function sign(payload: string, t = Date.now()) {
  return `t=${t}, v1=${createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex")}`;
}

describe("POST /api/v1/webhooks/workos", () => {
  beforeEach(() => {
    process.env["WORKOS_WEBHOOK_SECRET"] = SECRET;
    mockOrgId.mockResolvedValue("org_wos");
    mockFindSettings.mockResolvedValue({
      organizationId: "org-1",
      workosOrganizationId: "org_wos",
    });
    mockClaim.mockResolvedValue(true);
    mockHandle.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete process.env["WORKOS_WEBHOOK_SECRET"];
    vi.clearAllMocks();
  });

  it("refuses when no secret is configured", async () => {
    delete process.env["WORKOS_WEBHOOK_SECRET"];
    expect((await post(body, sign(body))).status).toBe(503);
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it("rejects an unsigned or mis-signed body before touching anything", async () => {
    expect((await post(body)).status).toBe(400);
    expect((await post(body, sign(`${body}x`))).status).toBe(400);
    expect(mockOrgId).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("acknowledges events for orgs that never set up SSO without acting", async () => {
    mockFindSettings.mockResolvedValue(null);
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it("acknowledges a redelivery without processing it twice", async () => {
    mockClaim.mockResolvedValue(false);
    const res = await post(body, sign(body));
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it("processes a fresh event for a configured org", async () => {
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(mockHandle).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1" }),
      expect.objectContaining({ id: "event_01TEST" }),
    );
  });

  it("un-claims a failed event so the retry is processed", async () => {
    mockHandle.mockRejectedValue(new Error("db down"));
    mockRelease.mockResolvedValue(undefined);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(body, sign(body));
    expect(res.status).toBe(500);
    expect(mockRelease).toHaveBeenCalledWith("event_01TEST");
    spy.mockRestore();
  });
});
