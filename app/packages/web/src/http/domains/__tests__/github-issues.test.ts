import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * GitHub issue filing: the permission split, the strict request schemas, and
 * the failure mapping both clients branch on (the structured 409 that turns
 * into a "grant the permission" prompt).
 */

/** The real error classes: the handlers branch on `instanceof` and on fields. */
class GithubApiError extends Error {
  constructor(
    message: string,
    readonly installationId: number,
    readonly status: number | null = null,
    readonly missingPermission: string | null = null,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}
class GithubFilingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 = 400,
  ) {
    super(message);
    this.name = "GithubFilingError";
  }
}

const mocks = vi.hoisted(() => ({
  file: vi.fn(),
  labels: vi.fn(),
  installs: vi.fn(),
  access: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@infrawrench/server-core/github/app", () => ({
  getInstallationAccess: (...a: unknown[]) => mocks.access(...a),
  isGithubAppConfigured: () => true,
}));
vi.mock("@infrawrench/server-core/github/issues-api", () => ({
  GithubApiError,
  isRepoFullName: (s: string) => /^[^/]+\/[^/]+$/.test(s),
  listAssignees: vi.fn(),
  listBranches: vi.fn(),
  listLabels: (...a: unknown[]) => mocks.labels(...a),
}));
vi.mock("@infrawrench/server-core/github-issues/settings", () => ({
  GithubIssueSettingsError: class extends Error {},
  getGithubIssueSettings: vi.fn(),
  listInstallationAccess: vi.fn(),
  orgInstallationIds: (...a: unknown[]) => mocks.installs(...a),
  setGithubIssueSettings: vi.fn(),
}));
vi.mock("@infrawrench/server-core/github-issues/filing", () => ({
  GithubFilingError,
  fileFindingToGithub: (...a: unknown[]) => mocks.file(...a),
  listGithubIssueLinks: vi.fn(),
  resolveFindingRoute: vi.fn(),
}));
vi.mock("@infrawrench/server-core/github-issues/pull-request", () => ({
  IacPullRequestRefused: class extends Error {},
  openIacPullRequest: vi.fn(),
  previewIacPullRequest: vi.fn(),
}));
vi.mock("@infrawrench/server-core/issue-status/sync", () => ({
  refreshOrgIssueStatuses: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mocks.audit(...a) }));

const { githubIssuesDomain } = await import("@/http/domains/github-issues/index");

const app = (permissions: string[] = ["github-issues:read", "github-issues:write"]) =>
  buildTestApi(githubIssuesDomain, { basePath: "/api/org/org-1/github-issues", permissions });

const FINDING = { sourceKind: "orphan", sourceId: "vol-1", title: "Unattached volume" };
const file = (body: unknown, permissions?: string[]) =>
  app(permissions).request("/issues", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.installs.mockResolvedValue(new Set([42]));
});

describe("POST /issues", () => {
  it("needs github-issues:write", async () => {
    const res = await file(FINDING, ["github-issues:read"]);
    expect(res.status).toBe(403);
    expect(mocks.file).not.toHaveBeenCalled();
  });

  it("refuses an unknown key, as the strict zod schema did", async () => {
    const res = await file({ ...FINDING, colour: "red" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid issue");
    expect(mocks.file).not.toHaveBeenCalled();
  });

  it("files the finding and audits the create", async () => {
    const result = {
      action: "created",
      link: { id: "link-1", repo: "acme/infra", issueNumber: 7 },
    };
    mocks.file.mockResolvedValue(result);
    const res = await file({ ...FINDING, labels: ["cost"], details: [{ label: "Size" }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mocks.file).toHaveBeenCalledWith(
      "org-1",
      { ...FINDING, details: [{ label: "Size", value: undefined }] },
      {
        userId: "user-1",
        autoFiled: false,
        repo: undefined,
        labels: ["cost"],
        assignees: undefined,
      },
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "github_issues.issue.create", entityId: "link-1" }),
    );
  });

  it("answers a missing installation permission with the structured 409", async () => {
    mocks.file.mockRejectedValue(new GithubApiError("Needs issues: write", 42, 403, "issues"));
    mocks.access.mockResolvedValue({ accountLogin: "acme", htmlUrl: "https://github.com/x" });
    const res = await file(FINDING);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Needs issues: write",
      code: "github_permission_required",
      permissions: ["issues"],
      installationId: 42,
      accountLogin: "acme",
      manageUrl: "https://github.com/x",
    });
  });

  it("keeps a filing refusal's own status and sentence", async () => {
    mocks.file.mockRejectedValue(
      new GithubFilingError("GitHub issue filing is turned off for this organization.", 409),
    );
    const res = await file(FINDING);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "GitHub issue filing is turned off for this organization.",
    });
  });

  it("maps a GitHub outage to 502 and anything unexpected to the route's 500", async () => {
    mocks.file.mockRejectedValueOnce(new GithubApiError("GitHub is down", 42, 503));
    const outage = await file(FINDING);
    expect(outage.status).toBe(502);
    expect(await outage.json()).toEqual({ error: "GitHub is down" });

    mocks.file.mockRejectedValueOnce(new Error("boom"));
    const unexpected = await file(FINDING);
    expect(unexpected.status).toBe(500);
    expect(await unexpected.json()).toEqual({ error: "GitHub request failed" });
  });
});

describe("GET /labels", () => {
  it("refuses a repository under an installation the org has not connected", async () => {
    const res = await app().request("/labels?installationId=7&repo=acme/infra");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown repository" });
    expect(mocks.labels).not.toHaveBeenCalled();
  });

  it("refuses an unreadable installation id the same way", async () => {
    const res = await app().request("/labels?installationId=abc&repo=acme/infra");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown repository" });
  });

  it("lists the labels of a connected repository", async () => {
    mocks.labels.mockResolvedValue([{ name: "cost", color: "fff", description: null }]);
    const res = await app().request("/labels?installationId=42&repo=acme/infra");
    expect(res.status).toBe(200);
    expect(mocks.labels).toHaveBeenCalledWith(42, "acme/infra");
  });
});
