import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";

/**
 * Jira route tests. The behaviour worth pinning here is not the happy path —
 * it is:
 *
 *  - **permission split.** `jira:read` sees the redacted connection, the
 *    pickers, and the links; only `jira:write` configures or files. A member
 *    who could file by holding read alone would defeat the whole decision.
 *  - **the token never leaves.** `GET /` must answer with a hint, and `PUT /`
 *    with an omitted token must mean "keep the stored one" rather than wipe it.
 *  - **error mapping.** A Jira 401 has to become a 502 (their side), while a
 *    bad site URL — which never reaches Jira — has to become a 400 (ours).
 *  - **ordering on create.** The link row is only written after Jira returns a
 *    key, so a failed create leaves no link claiming an issue that isn't there.
 */

const mockGetIntegration = vi.fn();
const mockSetIntegration = vi.fn();
const mockDeleteIntegration = vi.fn();
const mockVerifyCredentials = vi.fn();
const mockVerifyStored = vi.fn();
const mockListProjects = vi.fn();
const mockListIssueTypes = vi.fn();
const mockCreateIssue = vi.fn();
const mockRecordLink = vi.fn();
const mockListLinks = vi.fn();

/** The real error class — the route branches on `instanceof` and on `status`. */
class JiraApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
  }
}

vi.mock("@infrawrench/server-core/jira", () => ({
  JIRA_SOURCE_KINDS: [
    "cost_anomaly",
    "orphan",
    "oversized",
    "posture_finding",
    "expiring",
    "probe",
  ],
  JiraApiError,
  getJiraIntegration: (...a: unknown[]) => mockGetIntegration(...a),
  setJiraIntegration: (...a: unknown[]) => mockSetIntegration(...a),
  deleteJiraIntegration: (...a: unknown[]) => mockDeleteIntegration(...a),
  verifyJiraCredentials: (...a: unknown[]) => mockVerifyCredentials(...a),
  verifyStoredJiraCredentials: (...a: unknown[]) => mockVerifyStored(...a),
  listJiraProjects: (...a: unknown[]) => mockListProjects(...a),
  listJiraIssueTypes: (...a: unknown[]) => mockListIssueTypes(...a),
  createJiraIssue: (...a: unknown[]) => mockCreateIssue(...a),
  recordJiraIssueLink: (...a: unknown[]) => mockRecordLink(...a),
  listJiraIssueLinks: (...a: unknown[]) => mockListLinks(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { jiraRoutes } = await import("@/api/routes/jira");

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
  app.route("/", jiraRoutes);
  return app;
}

const reader = () => buildAppWithPermissions(["jira:read"]);
const writer = () => buildAppWithPermissions(["jira:read", "jira:write"]);

const json = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

const INTEGRATION = {
  siteUrl: "https://acme.atlassian.net",
  accountEmail: "ops@acme.com",
  tokenHint: "…a7f2",
  defaultProjectKey: "OPS",
  defaultIssueTypeId: "10004",
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

  /** Nothing in the response may stand in for the API token but the hint. */
  it("never includes an API token", async () => {
    mockGetIntegration.mockResolvedValue(INTEGRATION);
    const body = await (await reader().request("/")).text();
    expect(body).toContain("…a7f2");
    expect(body).not.toMatch(/apiToken|encryptedApiToken/);
  });

  it("returns null when Jira is not connected", async () => {
    mockGetIntegration.mockResolvedValue(null);
    expect(await (await reader().request("/")).json()).toEqual({ integration: null });
  });

  it("rejects a caller without jira:read", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/");
    expect(res.status).toBe(403);
  });
});

describe("PUT /", () => {
  it("saves and audits jira.configure", async () => {
    mockSetIntegration.mockResolvedValue(INTEGRATION);
    const res = await writer().request("/", {
      ...json({
        siteUrl: "https://acme.atlassian.net",
        accountEmail: "ops@acme.com",
        apiToken: "tok",
      }),
      method: "PUT",
    });

    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "jira.configure", entityType: "jira_integration" }),
    );
  });

  /** The audit log is readable by every holder of `audit:read`. */
  it("keeps the token out of the audit metadata", async () => {
    mockSetIntegration.mockResolvedValue(INTEGRATION);
    await writer().request("/", {
      ...json({
        siteUrl: "https://acme.atlassian.net",
        accountEmail: "ops@acme.com",
        apiToken: "super-secret",
      }),
      method: "PUT",
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain("super-secret");
  });

  /** A blank token field means "unchanged", so the route must forward absence. */
  it("passes an omitted token through as undefined", async () => {
    mockSetIntegration.mockResolvedValue(INTEGRATION);
    await writer().request("/", {
      ...json({ siteUrl: "https://acme.atlassian.net", accountEmail: "ops@acme.com" }),
      method: "PUT",
    });
    expect(mockSetIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: undefined }),
    );
  });

  it("rejects an invalid email with 400 before touching storage", async () => {
    const res = await writer().request("/", {
      ...json({ siteUrl: "https://acme.atlassian.net", accountEmail: "not-an-email" }),
      method: "PUT",
    });
    expect(res.status).toBe(400);
    expect(mockSetIntegration).not.toHaveBeenCalled();
  });

  /** No status ⇒ we never reached Jira ⇒ the caller's input is at fault. */
  it("maps a local JiraApiError to 400 with its message", async () => {
    mockSetIntegration.mockRejectedValue(new JiraApiError("evil.example.com is not a Jira Cloud site"));
    const res = await writer().request("/", {
      ...json({ siteUrl: "https://evil.example.com", accountEmail: "ops@acme.com", apiToken: "t" }),
      method: "PUT",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a Jira Cloud site/);
  });

  it("rejects a reader — configuring needs jira:write", async () => {
    const res = await reader().request("/", {
      ...json({ siteUrl: "https://acme.atlassian.net", accountEmail: "ops@acme.com" }),
      method: "PUT",
    });
    expect(res.status).toBe(403);
    expect(mockSetIntegration).not.toHaveBeenCalled();
  });
});

describe("DELETE /", () => {
  it("disconnects and audits jira.delete", async () => {
    mockDeleteIntegration.mockResolvedValue(true);
    const res = await writer().request("/", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "jira.delete" }),
    );
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
  it("verifies typed credentials when all three are supplied", async () => {
    mockVerifyCredentials.mockResolvedValue({
      accountId: "acc",
      displayName: "Ops Bot",
      emailAddress: "ops@acme.com",
    });
    const res = await writer().request(
      "/verify",
      json({
        siteUrl: "https://acme.atlassian.net",
        accountEmail: "ops@acme.com",
        apiToken: "tok",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, displayName: "Ops Bot" });
    expect(mockVerifyStored).not.toHaveBeenCalled();
  });

  it("falls back to the stored credentials on an empty body", async () => {
    mockVerifyStored.mockResolvedValue({
      accountId: "acc",
      displayName: "Ops Bot",
      emailAddress: null,
    });
    const res = await writer().request("/verify", json({}));
    expect(res.status).toBe(200);
    expect(mockVerifyStored).toHaveBeenCalledWith("org-1");
    expect(mockVerifyCredentials).not.toHaveBeenCalled();
  });

  /** Jira answered — their side, so 502, carrying Jira's wording. */
  it("maps a Jira 401 to 502", async () => {
    mockVerifyStored.mockRejectedValue(
      new JiraApiError("Jira rejected the credentials (401).", 401),
    );
    const res = await writer().request("/verify", json({}));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/401/);
  });

  it("rejects a reader — verifying uses the write credential path", async () => {
    const res = await reader().request("/verify", json({}));
    expect(res.status).toBe(403);
  });
});

describe("pickers", () => {
  it("lists projects for a reader", async () => {
    mockListProjects.mockResolvedValue([{ id: "1", key: "OPS", name: "Operations" }]);
    const res = await reader().request("/projects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "1", key: "OPS", name: "Operations" }]);
  });

  it("lists issue types for a project", async () => {
    mockListIssueTypes.mockResolvedValue([
      { id: "10004", name: "Task", subtask: false, description: null },
    ]);
    const res = await reader().request("/projects/OPS/issue-types");
    expect(res.status).toBe(200);
    expect(mockListIssueTypes).toHaveBeenCalledWith("org-1", "OPS");
  });

  it("surfaces a Jira failure from a picker as 502", async () => {
    mockListProjects.mockRejectedValue(new JiraApiError("Jira is unavailable (HTTP 503)", 503));
    const res = await reader().request("/projects");
    expect(res.status).toBe(502);
  });

  it("rejects a caller without jira:read", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/projects");
    expect(res.status).toBe(403);
  });
});

describe("POST /issues", () => {
  const body = {
    sourceKind: "cost_anomaly",
    sourceId: "anom-1",
    projectKey: "OPS",
    issueTypeId: "10004",
    summary: "Cost anomaly: EC2 spend up 240%",
    description: "Baseline: $12/day",
    labels: ["infrawrench"],
  };
  const ISSUE = { id: "1", key: "OPS-412", url: "https://acme.atlassian.net/browse/OPS-412" };
  const LINK = {
    id: "link-1",
    sourceKind: "cost_anomaly",
    sourceId: "anom-1",
    issueKey: "OPS-412",
    issueUrl: ISSUE.url,
    createdByUserId: "user-1",
    createdAt: "2026-08-08T00:00:00.000Z",
  };

  it("creates the issue, records the link, and audits jira.issue.create", async () => {
    mockCreateIssue.mockResolvedValue(ISSUE);
    mockRecordLink.mockResolvedValue(LINK);

    const res = await writer().request("/issues", json(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issue: ISSUE, link: LINK });
    expect(mockRecordLink).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "anom-1", issueKey: "OPS-412", userId: "user-1" }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "jira.issue.create", entityId: "link-1" }),
    );
  });

  /**
   * The link must never claim an issue that was not created — a dangling link
   * silently suppresses the file button for a finding nobody filed.
   */
  it("records no link when Jira refuses the create", async () => {
    mockCreateIssue.mockRejectedValue(
      new JiraApiError("Jira rejected the request (400) — Issue type is required.", 400),
    );
    const res = await writer().request("/issues", json(body));

    // 400 rather than 502: Jira validated our fields and found them wanting,
    // which the caller can fix by picking a different type.
    expect(res.status).toBe(400);
    expect(mockRecordLink).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("rejects an unknown source kind with 400", async () => {
    const res = await writer().request("/issues", json({ ...body, sourceKind: "made_up" }));
    expect(res.status).toBe(400);
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("rejects a reader — filing needs jira:write", async () => {
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

  it("rejects a caller without jira:read", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/links");
    expect(res.status).toBe(403);
  });
});
