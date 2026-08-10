import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";

/**
 * Linear route tests, mirroring jira.test.ts. The behaviour worth pinning:
 *
 *  - **permission split.** `linear:read` sees the redacted connection, the
 *    team picker, and the links; only `linear:write` configures or files.
 *  - **the key never leaves.** `GET /` must answer with a hint, and `PUT /`
 *    with an omitted key must mean "keep the stored one" rather than wipe it.
 *  - **error mapping.** Linear reports rate limiting and auth failures as
 *    GraphQL errors on an HTTP 400, so a LinearApiError carrying 400 lands on
 *    400 here; a 5xx from Linear becomes a 502.
 *  - **ordering on create.** The link row is only written after Linear returns
 *    an identifier, so a failed create leaves no link claiming an issue that
 *    isn't there.
 */

const mockGetIntegration = vi.fn();
const mockSetIntegration = vi.fn();
const mockDeleteIntegration = vi.fn();
const mockVerifyCredentials = vi.fn();
const mockVerifyStored = vi.fn();
const mockListTeams = vi.fn();
const mockCreateIssue = vi.fn();
const mockRecordLink = vi.fn();
const mockListLinks = vi.fn();

/** The real error class — the route branches on `instanceof` and on `status`. */
class LinearApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LinearApiError";
    this.status = status;
  }
}

vi.mock("@infrawrench/server-core/linear", () => ({
  LINEAR_SOURCE_KINDS: [
    "cost_anomaly",
    "orphan",
    "oversized",
    "posture_finding",
    "expiring",
    "probe",
  ],
  LinearApiError,
  getLinearIntegration: (...a: unknown[]) => mockGetIntegration(...a),
  setLinearIntegration: (...a: unknown[]) => mockSetIntegration(...a),
  deleteLinearIntegration: (...a: unknown[]) => mockDeleteIntegration(...a),
  verifyLinearCredentials: (...a: unknown[]) => mockVerifyCredentials(...a),
  verifyStoredLinearCredentials: (...a: unknown[]) => mockVerifyStored(...a),
  listLinearTeams: (...a: unknown[]) => mockListTeams(...a),
  createLinearIssue: (...a: unknown[]) => mockCreateIssue(...a),
  recordLinearIssueLink: (...a: unknown[]) => mockRecordLink(...a),
  listLinearIssueLinks: (...a: unknown[]) => mockListLinks(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { linearRoutes } = await import("@/api/routes/linear");

function buildAppWithPermissions(permissions: string[]): Hono {
  const app = new Hono();
  const session: AuthSession = { userId: "user-1", email: "test@example.com" };
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    c.set("permissions", permissions);
    c.set("role", null);
    return next();
  });
  app.route("/", linearRoutes);
  return app;
}

const reader = () => buildAppWithPermissions(["linear:read"]);
const writer = () => buildAppWithPermissions(["linear:read", "linear:write"]);

const json = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

const INTEGRATION = {
  keyHint: "…a7f2",
  defaultTeamId: "team-1",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => vi.clearAllMocks());

describe("GET /", () => {
  it("returns the redacted integration to a reader", async () => {
    mockGetIntegration.mockResolvedValue(INTEGRATION);
    const res = await reader().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ integration: INTEGRATION });
  });

  /** Nothing in the response may stand in for the API key but the hint. */
  it("never includes an API key", async () => {
    mockGetIntegration.mockResolvedValue(INTEGRATION);
    const body = await (await reader().request("/")).text();
    expect(body).toContain("…a7f2");
    expect(body).not.toMatch(/apiKey|encryptedApiKey/);
  });

  it("returns null when Linear is not connected", async () => {
    mockGetIntegration.mockResolvedValue(null);
    expect(await (await reader().request("/")).json()).toEqual({ integration: null });
  });

  it("rejects a caller without linear:read", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/");
    expect(res.status).toBe(403);
  });

  /** Jira permissions must not leak across trackers. */
  it("rejects a caller holding only jira:read", async () => {
    const res = await buildAppWithPermissions(["jira:read", "jira:write"]).request("/");
    expect(res.status).toBe(403);
  });
});

describe("PUT /", () => {
  it("saves and audits linear.configure", async () => {
    mockSetIntegration.mockResolvedValue(INTEGRATION);
    const res = await writer().request("/", {
      ...json({ apiKey: "lin_api_tok" }),
      method: "PUT",
    });

    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "linear.configure", entityType: "linear_integration" }),
    );
  });

  /** The audit log is readable by every holder of `audit:read`. */
  it("keeps the key out of the audit metadata", async () => {
    mockSetIntegration.mockResolvedValue(INTEGRATION);
    await writer().request("/", {
      ...json({ apiKey: "super-secret" }),
      method: "PUT",
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain("super-secret");
  });

  /** A blank key field means "unchanged", so the route must forward absence. */
  it("passes an omitted key through as undefined", async () => {
    mockSetIntegration.mockResolvedValue(INTEGRATION);
    await writer().request("/", {
      ...json({ defaultTeamId: "team-2" }),
      method: "PUT",
    });
    expect(mockSetIntegration).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  /** No status ⇒ we never reached Linear ⇒ the caller's input is at fault. */
  it("maps a local LinearApiError to 400 with its message", async () => {
    mockSetIntegration.mockRejectedValue(
      new LinearApiError("An API key is required to connect Linear"),
    );
    const res = await writer().request("/", { ...json({}), method: "PUT" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/API key is required/);
  });

  it("rejects a reader — configuring needs linear:write", async () => {
    const res = await reader().request("/", {
      ...json({ apiKey: "tok" }),
      method: "PUT",
    });
    expect(res.status).toBe(403);
    expect(mockSetIntegration).not.toHaveBeenCalled();
  });
});

describe("DELETE /", () => {
  it("disconnects and audits linear.delete", async () => {
    mockDeleteIntegration.mockResolvedValue(true);
    const res = await writer().request("/", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "linear.delete" }));
  });

  it("404s when there was nothing connected, and audits nothing", async () => {
    mockDeleteIntegration.mockResolvedValue(false);
    const res = await writer().request("/", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("rejects a reader", async () => {
    const res = await reader().request("/", { method: "DELETE" });
    expect(res.status).toBe(403);
  });
});

describe("POST /verify", () => {
  it("verifies a typed key when one is supplied", async () => {
    mockVerifyCredentials.mockResolvedValue({ id: "u1", name: "Ops Bot", email: "ops@acme.com" });
    const res = await writer().request("/verify", json({ apiKey: "tok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "Ops Bot" });
    expect(mockVerifyCredentials).toHaveBeenCalledWith("tok");
    expect(mockVerifyStored).not.toHaveBeenCalled();
  });

  it("falls back to the stored key on an empty body", async () => {
    mockVerifyStored.mockResolvedValue({ id: "u1", name: "Ops Bot", email: null });
    const res = await writer().request("/verify", json({}));
    expect(res.status).toBe(200);
    expect(mockVerifyStored).toHaveBeenCalledWith("org-1");
    expect(mockVerifyCredentials).not.toHaveBeenCalled();
  });

  /**
   * Linear reports a bad key as GraphQL errors on HTTP 400 — the caller can
   * fix it (re-enter the key), so it stays a 400, carrying Linear's wording.
   */
  it("keeps a Linear 400 as 400 with Linear's wording", async () => {
    mockVerifyStored.mockRejectedValue(new LinearApiError("Linear rejected the API key.", 400));
    const res = await writer().request("/verify", json({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rejected the API key/);
  });

  /** A 5xx from Linear is their side — 502. */
  it("maps a Linear 503 to 502", async () => {
    mockVerifyStored.mockRejectedValue(new LinearApiError("Linear is unavailable (HTTP 503)", 503));
    const res = await writer().request("/verify", json({}));
    expect(res.status).toBe(502);
  });

  it("rejects a reader — verifying uses the write credential path", async () => {
    const res = await reader().request("/verify", json({}));
    expect(res.status).toBe(403);
  });
});

describe("GET /teams", () => {
  it("lists teams for a reader", async () => {
    mockListTeams.mockResolvedValue([{ id: "t1", key: "ENG", name: "Engineering" }]);
    const res = await reader().request("/teams");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "t1", key: "ENG", name: "Engineering" }]);
  });

  it("surfaces a Linear failure from the picker as 502", async () => {
    mockListTeams.mockRejectedValue(new LinearApiError("Linear is unavailable (HTTP 503)", 503));
    const res = await reader().request("/teams");
    expect(res.status).toBe(502);
  });

  it("rejects a caller without linear:read", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/teams");
    expect(res.status).toBe(403);
  });
});

describe("POST /issues", () => {
  const body = {
    sourceKind: "cost_anomaly",
    sourceId: "anom-1",
    teamId: "t1",
    title: "Cost anomaly: EC2 spend up 240%",
    description: "Baseline: $12/day",
  };
  const ISSUE = { id: "i1", identifier: "ENG-123", url: "https://linear.app/acme/issue/ENG-123" };
  const LINK = {
    id: "link-1",
    sourceKind: "cost_anomaly",
    sourceId: "anom-1",
    issueIdentifier: "ENG-123",
    issueUrl: ISSUE.url,
    createdByUserId: "user-1",
    createdAt: "2026-08-08T00:00:00.000Z",
  };

  it("creates the issue, records the link, and audits linear.issue.create", async () => {
    mockCreateIssue.mockResolvedValue(ISSUE);
    mockRecordLink.mockResolvedValue(LINK);

    const res = await writer().request("/issues", json(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issue: ISSUE, link: LINK });
    expect(mockRecordLink).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "anom-1", issueIdentifier: "ENG-123", userId: "user-1" }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "linear.issue.create", entityId: "link-1" }),
    );
  });

  /**
   * The link must never claim an issue that was not created — a dangling link
   * silently suppresses the file button for a finding nobody filed.
   */
  it("records no link when Linear refuses the create", async () => {
    mockCreateIssue.mockRejectedValue(
      new LinearApiError("Linear returned an error — Team not found", 400),
    );
    const res = await writer().request("/issues", json(body));

    expect(res.status).toBe(400);
    expect(mockRecordLink).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("rejects an unknown source kind with 400", async () => {
    const res = await writer().request("/issues", json({ ...body, sourceKind: "made_up" }));
    expect(res.status).toBe(400);
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("rejects a reader — filing needs linear:write", async () => {
    const res = await reader().request("/issues", json(body));
    expect(res.status).toBe(403);
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });
});

describe("GET /links", () => {
  it("returns links for a reader", async () => {
    mockListLinks.mockResolvedValue([]);
    const res = await reader().request("/links");
    expect(res.status).toBe(200);
    expect(mockListLinks).toHaveBeenCalledWith("org-1", {
      sourceKind: undefined,
      sourceIds: undefined,
    });
  });

  /** The batch shape: repeating sourceId is what makes this one request. */
  it("passes a repeated sourceId through as a list", async () => {
    mockListLinks.mockResolvedValue([]);
    await reader().request("/links?sourceKind=cost_anomaly&sourceId=a&sourceId=b");
    expect(mockListLinks).toHaveBeenCalledWith("org-1", {
      sourceKind: "cost_anomaly",
      sourceIds: ["a", "b"],
    });
  });

  it("rejects an unknown sourceKind with 400", async () => {
    const res = await reader().request("/links?sourceKind=made_up");
    expect(res.status).toBe(400);
  });

  it("rejects a caller without linear:read", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/links");
    expect(res.status).toBe(403);
  });
});
