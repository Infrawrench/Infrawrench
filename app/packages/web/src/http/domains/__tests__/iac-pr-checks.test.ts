import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The IaC and pull request check routes are what the VS Code and Raycast
// extensions call: these pin their wire answers on HttpApi.

class FakeIacInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
const listIacStates = vi.fn();
const saveIacState = vi.fn();
const runIacReconciliation = vi.fn();
const getIacResourceStatus = vi.fn();
vi.mock("@infrawrench/server-core/iac/store", () => ({
  IacInputError: FakeIacInputError,
  listIacStates: (...a: unknown[]) => listIacStates(...a),
  saveIacState: (...a: unknown[]) => saveIacState(...a),
  deleteIacState: vi.fn(async () => false),
}));
vi.mock("@infrawrench/server-core/iac/service", () => ({
  buildIacImportPlan: vi.fn(),
  getIacResourceStatus: (...a: unknown[]) => getIacResourceStatus(...a),
  runIacReconciliation: (...a: unknown[]) => runIacReconciliation(...a),
}));

class FakeGithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}
const getPrCheckRepository = vi.fn();
const createPrCheckRepository = vi.fn();
const previewPullRequestCheck = vi.fn();
vi.mock("@infrawrench/server-core/github/app", () => ({ isGithubAppConfigured: () => true }));
vi.mock("@infrawrench/server-core/github/issues-api", () => ({
  GithubApiError: FakeGithubApiError,
  isRepoFullName: (name: string) => /^[^/]+\/[^/]+$/.test(name),
}));
vi.mock("@infrawrench/server-core/pr-checks/settings", () => ({
  PrCheckSettingsError: class extends Error {},
  createPrCheckRepository: (...a: unknown[]) => createPrCheckRepository(...a),
  deletePrCheckRepository: vi.fn(),
  getPrCheckRepository: (...a: unknown[]) => getPrCheckRepository(...a),
  listPrCheckInstallationAccess: vi.fn(async () => []),
  listPrCheckRepositories: vi.fn(async () => []),
  updatePrCheckRepository: vi.fn(),
}));
vi.mock("@infrawrench/server-core/pr-checks/runs", () => ({ listPrCheckRuns: vi.fn() }));
vi.mock("@infrawrench/server-core/pr-checks/pass", () => ({
  previewFilesCheck: vi.fn(),
  previewPullRequestCheck: (...a: unknown[]) => previewPullRequestCheck(...a),
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn(async () => undefined) }));

const { iacDomain } = await import("@/http/domains/iac/index");
const { prChecksDomain } = await import("@/http/domains/pr-checks/index");

const iac = (permissions?: readonly string[]) =>
  buildTestApi(iacDomain, {
    basePath: "/api/org/org-1/iac",
    ...(permissions ? { permissions } : {}),
  });
const prChecks = () => buildTestApi(prChecksDomain, { basePath: "/api/org/org-1/pr-checks" });
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

beforeEach(() => vi.clearAllMocks());

describe("iac", () => {
  it("lists states under `states`", async () => {
    listIacStates.mockResolvedValue([{ id: "s1", label: "prod" }]);
    const res = await iac(["iac:read"]).request("/states");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ states: [{ id: "s1", label: "prod" }] });
  });

  it("gates uploads on iac:write before reading the body", async () => {
    const res = await iac(["iac:read"]).request("/states", post({}));
    expect(res.status).toBe(403);
    expect(saveIacState).not.toHaveBeenCalled();
  });

  it("refuses an invalid upload with the route's sentence", async () => {
    const res = await iac().request("/states", post({ label: "", document: "{}" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid body");
  });

  it("returns 201 with the stored state, and the store's refusal with its status", async () => {
    saveIacState.mockResolvedValueOnce({
      state: { id: "s1", label: "prod", resourceCount: 1, redactedAttributeCount: 0 },
      parsed: { format: "tfstate" },
    });
    const ok = await iac().request("/states", post({ label: "prod", document: "{}" }));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({
      state: { id: "s1", label: "prod", resourceCount: 1, redactedAttributeCount: 0 },
    });
    saveIacState.mockRejectedValueOnce(new FakeIacInputError("Unsupported version"));
    const refused = await iac().request("/states", post({ label: "prod", document: "{}" }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Unsupported version" });
  });

  it("answers an unexpected failure with the route's 500 sentence", async () => {
    runIacReconciliation.mockRejectedValueOnce(new Error("clickhouse down"));
    const res = await iac().request("/reconciliation?stateId=s1");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "IaC reconciliation failed" });
  });

  it("names a missing query parameter", async () => {
    expect(await (await iac().request("/reconciliation")).json()).toEqual({
      error: "Missing stateId",
    });
    expect(await (await iac().request("/resource")).json()).toEqual({
      error: "Missing resourceId",
    });
  });

  it("passes a composite resource id through the query", async () => {
    getIacResourceStatus.mockResolvedValue({ status: null, driftFieldCount: 0 });
    const res = await iac().request(`/resource?resourceId=${encodeURIComponent("aws:a1:x/y")}`);
    expect(res.status).toBe(200);
    expect(getIacResourceStatus).toHaveBeenCalledWith("org-1", "aws:a1:x/y");
  });
});

describe("pr-checks", () => {
  const settings = {
    installationId: 7,
    repo: "acme/infra",
    enabled: true,
    commentEnabled: false,
    costThreshold: null,
    thresholdConclusion: "neutral",
    directories: [],
  };

  it("refuses unknown keys in repository settings", async () => {
    const res = await prChecks().request("/repositories", post({ ...settings, extra: 1 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid repository settings");
    expect(createPrCheckRepository).not.toHaveBeenCalled();
  });

  it("creates with 201 and the caller as creator", async () => {
    createPrCheckRepository.mockResolvedValue({ ...settings, id: "r1" });
    const res = await prChecks().request("/repositories", post(settings));
    expect(res.status).toBe(201);
    expect(createPrCheckRepository).toHaveBeenCalledWith("org-1", settings, "user-1");
  });

  it("previews a pull request, 404ing an unknown repository or pull request", async () => {
    getPrCheckRepository.mockResolvedValueOnce(null);
    const unknown = await prChecks().request(
      "/preview",
      post({ repositoryId: "r1", pullNumber: 3 }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Unknown repository" });

    getPrCheckRepository.mockResolvedValueOnce({ id: "r1" });
    previewPullRequestCheck.mockResolvedValueOnce(null);
    const noPull = await prChecks().request(
      "/preview",
      post({ repositoryId: "r1", pullNumber: 3 }),
    );
    expect(await noPull.json()).toEqual({ error: "No such pull request" });
  });

  it("maps GitHub failures to 400 or 502", async () => {
    getPrCheckRepository.mockResolvedValue({ id: "r1" });
    previewPullRequestCheck.mockRejectedValueOnce(new FakeGithubApiError("gone", 404));
    const refused = await prChecks().request(
      "/preview",
      post({ repositoryId: "r1", pullNumber: 3 }),
    );
    expect(refused.status).toBe(400);
    previewPullRequestCheck.mockRejectedValueOnce(new FakeGithubApiError("down", 503));
    const upstream = await prChecks().request(
      "/preview",
      post({ repositoryId: "r1", pullNumber: 3 }),
    );
    expect(upstream.status).toBe(502);
    expect(await upstream.json()).toEqual({ error: "down" });
  });

  it("refuses a malformed repo name on a file preview", async () => {
    const res = await prChecks().request(
      "/preview",
      post({ files: [{ path: "main.tf", before: null, after: "" }], repo: "nope" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo must be owner/name" });
  });
});
