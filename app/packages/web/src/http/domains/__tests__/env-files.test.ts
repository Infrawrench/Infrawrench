import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The service reaches Postgres, the plugins and GitHub; these tests are about
// the transport: permission gates, the service's refusals as statuses, the
// structured GitHub permission 409, and that resolved values never reach the
// audit log.
vi.mock("@infrawrench/server-core/db/client", () => ({ db: {} }));
vi.mock("@/db/client", () => ({ db: {} }));
const mockDescribe = vi.fn();
const mockResolve = vi.fn();
const mockSources = vi.fn();
const mockRepos = vi.fn();
const mockRead = vi.fn();
const mockCommit = vi.fn();
vi.mock("@infrawrench/server-core/env-files/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@infrawrench/server-core/env-files/service")>()),
  describeInfraenv: (...a: unknown[]) => mockDescribe(...a),
  resolveInfraenv: (...a: unknown[]) => mockResolve(...a),
  listInfraenvSources: (...a: unknown[]) => mockSources(...a),
  listInfraenvRepos: (...a: unknown[]) => mockRepos(...a),
  readInfraenvRepoFile: (...a: unknown[]) => mockRead(...a),
  commitInfraenvFile: (...a: unknown[]) => mockCommit(...a),
}));
vi.mock("@infrawrench/server-core/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@infrawrench/server-core/github/app")>()),
  getInstallationAccess: async () => ({
    accountLogin: "acme",
    htmlUrl: "https://github.com/settings/installations/7",
  }),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { EnvFileRefused } = await import("@infrawrench/server-core/env-files/service");
const { GithubApiError } = await import("@infrawrench/server-core/github/issues-api");
const { envFilesDomain } = await import("@/http/domains/env-files/index");
const app = (permissions?: string[]) =>
  buildTestApi(envFilesDomain, {
    basePath: "/api/org/org-1/env-files",
    ...(permissions ? { permissions } : {}),
  });

const post = (path: string, body: unknown, permissions?: string[]) =>
  app(permissions).request(path, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("env file routes", () => {
  it("resolves, and audits the variable names but never the values", async () => {
    mockResolve.mockResolvedValue({
      environment: "production",
      values: [{ key: "DATABASE_URL", value: "postgres://u:hunter2@db/app" }],
      problems: [{ line: 3, key: "STRIPE", message: "No organization secret named STRIPE" }],
      dotenv: "# Auto-generated\nDATABASE_URL=postgres://u:hunter2@db/app\n",
    });
    const res = await post("/resolve", { source: "[env]\n", environment: "production" });
    expect(res.status).toBe(200);
    expect((await res.json()).values[0].value).toBe("postgres://u:hunter2@db/app");
    expect(mockResolve).toHaveBeenCalledWith("org-1", {
      source: "[env]\n",
      environment: "production",
      sourceName: undefined,
    });
    await vi.waitFor(() => expect(mockLogAudit).toHaveBeenCalled());
    const audit = mockLogAudit.mock.calls[0]![0];
    expect(audit).toMatchObject({
      action: "env_file.resolve",
      metadata: { environment: "production", variables: ["DATABASE_URL"], failed: ["STRIPE"] },
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain("hunter2");
  });

  it("needs secrets:read to resolve, and resources:read alone to describe", async () => {
    mockDescribe.mockResolvedValue({ problems: [], environments: [], resources: [], secrets: [] });
    expect((await post("/resolve", { source: "" }, ["resources:read"])).status).toBe(403);
    expect(mockResolve).not.toHaveBeenCalled();
    expect((await post("/describe", { source: "" }, ["resources:read"])).status).toBe(200);
  });

  it("answers the service's refusal as 400 in its words", async () => {
    mockResolve.mockRejectedValue(new EnvFileRefused("The file has no [env.staging] section"));
    const res = await post("/resolve", { source: "[env]\n", environment: "staging" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The file has no [env.staging] section" });
  });

  it("refuses an unknown body field before the service sees it", async () => {
    const res = await post("/describe", { source: "", extra: true });
    expect(res.status).toBe(400);
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it("passes the picker query through", async () => {
    mockSources.mockResolvedValue([]);
    const res = await app().request("/sources?q=neon&limit=10");
    expect(res.status).toBe(200);
    expect(mockSources).toHaveBeenCalledWith("org-1", { q: "neon", limit: 10 });
  });

  it("reads a repository file", async () => {
    mockRead.mockResolvedValue({ path: ".infraenv", branch: "main", content: null, sha: null });
    const res = await app().request("/repo-file?installationId=7&repo=acme/web&path=.infraenv");
    expect(res.status).toBe(200);
    expect(mockRead).toHaveBeenCalledWith("org-1", {
      installationId: 7,
      repo: "acme/web",
      path: ".infraenv",
      branch: undefined,
    });
  });

  it("commits and audits the commit", async () => {
    mockCommit.mockResolvedValue({
      mode: "pull-request",
      branch: "infrawrench/env-abc",
      commitSha: "abc123",
      commitUrl: "https://github.com/acme/web/commit/abc123",
      pullRequest: { number: 4, url: "https://github.com/acme/web/pull/4" },
    });
    const body = {
      installationId: 7,
      repo: "acme/web",
      path: ".infraenv",
      content: "[env]\n",
      sha: null,
      mode: "pull-request",
    };
    const res = await post("/commit", body);
    expect(res.status).toBe(200);
    expect((await res.json()).pullRequest.number).toBe(4);
    await vi.waitFor(() =>
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "env_file.commit", entityId: "acme/web:.infraenv" }),
      ),
    );
    expect((await post("/commit", body, ["github-issues:read"])).status).toBe(403);
  });

  it("turns a missing GitHub permission into the structured 409", async () => {
    mockCommit.mockRejectedValue(new GithubApiError("no contents", 7, 403, "contents"));
    const res = await post("/commit", {
      installationId: 7,
      repo: "acme/web",
      path: ".infraenv",
      content: "[env]\n",
      sha: "s",
      mode: "commit",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "github_permission_required",
      permissions: ["contents"],
      installationId: 7,
      manageUrl: "https://github.com/settings/installations/7",
    });
  });
});
