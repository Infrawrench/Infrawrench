import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A git trigger's `installationId` must be one of the org's own GitHub App
 * installations: the github-watcher mints installation tokens for whatever id
 * is stored, so a foreign id would poll another org's private repository.
 */

const insertValues = vi.fn();
const ownedIds = vi.fn<() => Promise<Set<number>>>();

vi.mock("../../db/client", () => {
  const limit = () =>
    Promise.resolve([
      { id: "wf1", organizationId: "org1", trigger: { kind: "manual" }, enabled: true },
    ]);
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
      insert: () => ({
        values: (v: unknown) => {
          insertValues(v);
          return Promise.resolve();
        },
      }),
    },
  };
});

vi.mock("../../db/schema", () => ({
  workflows: { id: "id", organizationId: "organization_id", deletedAt: "deleted_at" },
  workflowRuns: {},
  workflowMetrics: {},
  budgets: {},
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  isNull: (a: unknown) => a,
}));

vi.mock("@infrawrench/workflow-runtime", () => ({
  DEFAULT_BUDGET_TRIGGER_PERCENT: 100,
  generateInfraDts: vi.fn(),
  typecheckWorkflow: vi.fn(),
}));

vi.mock("@infrawrench/server-core/workflows/runner", () => ({
  listOrgSshKeyNames: vi.fn().mockResolvedValue([]),
}));

vi.mock("@infrawrench/server-core/workflows/ai", () => ({
  isWorkflowAiConfigured: () => false,
}));

vi.mock("../workflow-host", () => ({
  listOrgPlugins: vi.fn().mockResolvedValue([]),
}));

vi.mock("../github-installations", () => ({
  orgGithubInstallationIds: () => ownedIds(),
}));

const { createWorkflow } = await import("../workflows");

beforeEach(() => {
  vi.clearAllMocks();
  ownedIds.mockResolvedValue(new Set([42]));
});

describe("git trigger installation ownership", () => {
  it("rejects an installation the org has not connected", async () => {
    await expect(
      createWorkflow(
        "org1",
        { trigger: { kind: "git", repo: "victim/private", branch: "main", installationId: 7 } },
        "user1",
      ),
    ).rejects.toMatchObject({ name: "WorkflowError", status: 400 });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric installation id", async () => {
    await expect(
      createWorkflow(
        "org1",
        {
          trigger: {
            kind: "git",
            repo: "acme/app",
            branch: "main",
            installationId: "42" as unknown as number,
          },
        },
        "user1",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("accepts one of the org's own installations", async () => {
    await createWorkflow(
      "org1",
      { trigger: { kind: "git", repo: "acme/app", branch: "main", installationId: 42 } },
      "user1",
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: expect.objectContaining({ installationId: 42 }) }),
    );
  });

  it("does not look installations up for a git trigger without one", async () => {
    await createWorkflow("org1", { trigger: { kind: "git", repo: "acme/app" } }, "user1");
    expect(ownedIds).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalled();
  });
});
