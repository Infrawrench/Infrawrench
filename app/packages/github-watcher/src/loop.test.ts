import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks (must be declared before importing the loop) ---
const rows = vi.fn();
const updates: Array<Record<string, unknown>> = [];
// The CAS update returns the claimed row ids; [] simulates losing the race.
const updateReturning = vi.fn().mockResolvedValue([{ id: "wf1" }]);
vi.mock("@infrawrench/server-core/db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => rows() }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          updates.push(v);
          return { returning: () => updateReturning() };
        },
      }),
    }),
  },
}));
vi.mock("@infrawrench/server-core/db/schema", () => ({
  workflows: { id: "id", organizationId: "org", trigger: "trigger", gitLastSha: "sha" },
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
}));
const runOrgWorkflow = vi.fn();
vi.mock("@infrawrench/server-core/infrafile/runner", () => ({
  runDeployment: vi.fn(),
}));
vi.mock("@infrawrench/server-core/workflows/runner", () => ({
  runOrgWorkflow: (a: unknown) => runOrgWorkflow(a),
}));
const getBranchHeadSha = vi.fn();
vi.mock("@infrawrench/server-core/github/app", () => ({
  isGithubAppConfigured: () => true,
  getBranchHeadSha: (...a: unknown[]) => getBranchHeadSha(...a),
}));
const claimDueDeploymentTriggers = vi.fn().mockResolvedValue([]);
vi.mock("@infrawrench/server-core/infrafile/triggers", () => ({
  claimDueDeploymentTriggers: () => claimDueDeploymentTriggers(),
}));

const { GithubWatcher } = await import("./loop");
const { runDeployment } = vi.mocked(await import("@infrawrench/server-core/infrafile/runner"));

function gitRow(over: Partial<{ gitLastSha: string | null }> = {}) {
  return {
    id: "wf1",
    organizationId: "org1",
    trigger: { kind: "git", repo: "acme/app", branch: "main", installationId: 42 },
    gitLastSha: null,
    ...over,
  };
}

function dueTrigger(over: Record<string, unknown> = {}) {
  return {
    id: "dt1",
    organizationId: "org1",
    repo: "acme/app",
    branch: "main",
    env: "prod",
    answers: { region: "lon1" },
    sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ...over,
  };
}

describe("GithubWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updates.length = 0;
    updateReturning.mockResolvedValue([{ id: "wf1" }]);
    claimDueDeploymentTriggers.mockResolvedValue([]);
    runDeployment.mockReset();
    rows.mockResolvedValue([]);
  });

  it("records the head SHA on first sight without running", async () => {
    rows.mockResolvedValue([gitRow({ gitLastSha: null })]);
    getBranchHeadSha.mockResolvedValue("sha-1");
    await new GithubWatcher().tick();
    expect(updates).toEqual([expect.objectContaining({ gitLastSha: "sha-1" })]);
    expect(runOrgWorkflow).not.toHaveBeenCalled();
  });

  it("runs the workflow when the SHA changes", async () => {
    rows.mockResolvedValue([gitRow({ gitLastSha: "sha-1" })]);
    getBranchHeadSha.mockResolvedValue("sha-2");
    await new GithubWatcher().tick();
    expect(updates).toEqual([expect.objectContaining({ gitLastSha: "sha-2" })]);
    expect(runOrgWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "wf1", triggerSource: "git" }),
    );
  });

  it("does nothing when the SHA is unchanged", async () => {
    rows.mockResolvedValue([gitRow({ gitLastSha: "sha-1" })]);
    getBranchHeadSha.mockResolvedValue("sha-1");
    await new GithubWatcher().tick();
    expect(updates).toEqual([]);
    expect(runOrgWorkflow).not.toHaveBeenCalled();
  });

  it("skips the run when another instance claims the SHA transition first", async () => {
    rows.mockResolvedValue([gitRow({ gitLastSha: "sha-1" })]);
    getBranchHeadSha.mockResolvedValue("sha-2");
    updateReturning.mockResolvedValue([]); // CAS matched zero rows
    await new GithubWatcher().tick();
    expect(updates).toEqual([expect.objectContaining({ gitLastSha: "sha-2" })]);
    expect(runOrgWorkflow).not.toHaveBeenCalled();
  });

  it("stays quiet when losing the first-sight race", async () => {
    rows.mockResolvedValue([gitRow({ gitLastSha: null })]);
    getBranchHeadSha.mockResolvedValue("sha-1");
    updateReturning.mockResolvedValue([]);
    await new GithubWatcher().tick();
    expect(runOrgWorkflow).not.toHaveBeenCalled();
  });

  it("skips git triggers missing repo/branch/installation", async () => {
    rows.mockResolvedValue([
      {
        id: "x",
        organizationId: "o",
        trigger: { kind: "git", repo: "acme/app" },
        gitLastSha: null,
      },
      {
        id: "y",
        organizationId: "o",
        trigger: { kind: "cron", expression: "* * * * *" },
        gitLastSha: null,
      },
    ]);
    await new GithubWatcher().tick();
    expect(getBranchHeadSha).not.toHaveBeenCalled();
  });

  it("deploys the claimed commit, not the branch", async () => {
    const run = runDeployment.mockResolvedValue({ runId: "run1" } as never);
    claimDueDeploymentTriggers.mockResolvedValue([dueTrigger()]);

    await new GithubWatcher().tick();

    // The claimed commit, not the branch: two pushes must ship two commits
    // rather than the newer one twice.
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        repo: "acme/app",
        branch: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        env: "prod",
        answers: { region: "lon1" },
        interactive: false,
      }),
    );
  });

  it("keeps deploying the rest when one trigger throws", async () => {
    const run = runDeployment
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ runId: "run2" } as never);
    claimDueDeploymentTriggers.mockResolvedValue([
      dueTrigger({ id: "dt1" }),
      dueTrigger({ id: "dt2", env: "staging" }),
    ]);

    await new GithubWatcher().tick();

    expect(run).toHaveBeenCalledTimes(2);
  });
});
