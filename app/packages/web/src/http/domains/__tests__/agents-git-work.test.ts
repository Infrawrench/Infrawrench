import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * An agent session started from a pull request on git.infrawrench.com
 * (`gitWork`): who may start one, what refuses it before a VM exists, and
 * what reaches the session when it is allowed.
 */

process.env["ENCRYPTION_MASTER_KEY"] = Buffer.alloc(32, 1).toString("base64");
process.env["WORKOS_API_KEY"] = "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] = "test_workos_client_id";

class GitWorkUnavailable extends Error {
  constructor() {
    super("There is no open pull request to work on at that address.");
  }
}
const work = {
  organizationId: "org-1",
  repositoryId: "repo-1",
  pullRequestId: "issue-1",
  owner: "acme",
  repo: "infra",
  pull: 7,
  branch: "work/fix-login",
  ref: "refs/heads/work/fix-login",
  title: "Fix the login redirect",
  body: "Users land on / after signing in.",
  cloneUrl: "https://git.example.test/acme/infra.git",
  pullUrl: "https://git.example.test/acme/infra/pull/7",
  forgeOrigin: "https://git.example.test",
};
const resolveGitWork = vi.fn(async (): Promise<typeof work> => work);
vi.mock("@infrawrench/server-core/git/agent-work", () => ({
  GitWorkUnavailable,
  resolveGitWork: (...a: unknown[]) => (resolveGitWork as (...b: unknown[]) => unknown)(...a),
  recordAgentLink: vi.fn(),
}));
vi.mock("@infrawrench/server-core/agent-links/links", () => ({
  grantablePermissions: vi.fn(async () => []),
  createApprovedLink: vi.fn(),
  revokeLink: vi.fn(async () => true),
}));
vi.mock("@/services/plugin-clients", () => ({ getClientForAccount: vi.fn() }));
vi.mock("@/services/agent-services", () => ({
  publicServiceInstalls: () => [],
  releaseAgentServices: vi.fn(),
  resolveAgentServiceAccounts: vi.fn(async () => ({ accountIds: [], pluginIds: [] })),
}));
vi.mock("@/services/agent-setup", () => ({
  createAgentSetupPlanForRepo: vi.fn(),
  ensureAgentVmSetupForSession: vi.fn(),
  hasAgentSetupComplete: vi.fn(),
  maybeAutoResumeAgentSetup: vi.fn(),
  renewAgentGitCredential: vi.fn(),
  scheduleAgentVmSetup: vi.fn(),
  revokeT3CodeLinkOnVm: vi.fn(),
  setupAwareAgentStatus: vi.fn(),
  setupPlanLogLines: () => [],
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/db/client", () => ({ db: {} }));
const createAgentSession = vi.fn(async (_input: Record<string, unknown>) => ({
  kind: "provision-failed" as const,
  message: "stopped here by the test",
}));
vi.mock("@/http/domains/agents/sessions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAgentSession: (input: Record<string, unknown>) => createAgentSession(input),
}));

const { agentsDomain } = await import("@/http/domains/agents/index");

function app(permissions: string[] = ["*"]) {
  return buildTestApi(agentsDomain, {
    basePath: "/api/org/org-1/agents",
    permissions,
    principal: { session: { userId: "user-1", email: "u@example.com" } },
  });
}

const create = (surface: string, gitWork: unknown = { owner: "acme", repo: "infra", pull: 7 }) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    repo: "",
    projectName: "infra-7",
    workspaceName: "infra",
    settings: {
      accountId: "acct-1",
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      tool: "claude-code",
      surface,
      fields: {},
    },
    gitWork,
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /sessions with gitWork", () => {
  it("needs git:write, and asks nothing of the forge's tables without it", async () => {
    const res = await app(["resources:write", "git:read"]).request("/sessions", create("terminal"));
    expect(res.status).toBe(403);
    expect(resolveGitWork).not.toHaveBeenCalled();
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("runs only in a terminal session", async () => {
    for (const surface of ["t3-code", "nibblets"]) {
      const res = await app().request("/sessions", create(surface));
      expect(res.status, surface).toBe(400);
    }
    expect(resolveGitWork).not.toHaveBeenCalled();
  });

  it("refuses a malformed address before looking anything up", async () => {
    for (const gitWork of [
      { owner: "acme", repo: "infra", pull: 0 },
      { owner: "", repo: "infra", pull: 1 },
      { owner: "acme", repo: "x".repeat(101), pull: 1 },
      { owner: "acme", repo: "infra", pull: 1.5 },
    ]) {
      const res = await app().request("/sessions", create("terminal", gitWork));
      expect(res.status, JSON.stringify(gitWork)).toBe(400);
    }
    expect(resolveGitWork).not.toHaveBeenCalled();
  });

  it("gives one refusal for a pull request it cannot work on, before any VM", async () => {
    resolveGitWork.mockRejectedValueOnce(new GitWorkUnavailable());
    const res = await app(["resources:write", "git:write"]).request(
      "/sessions",
      create("terminal"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "There is no open pull request to work on at that address.",
    );
    expect(resolveGitWork).toHaveBeenCalledWith("org-1", { owner: "acme", repo: "infra", pull: 7 });
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("starts the session on the forge's repository with the pull request's work", async () => {
    const res = await app(["resources:write", "git:admin"]).request(
      "/sessions",
      create("terminal"),
    );
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(createAgentSession.mock.calls[0]?.[0]).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      repo: work.cloneUrl,
      surface: "terminal",
      tool: "claude-code",
      work,
    });
    // The mocked create stops there.
    expect(res.status).toBe(400);
  });
});
