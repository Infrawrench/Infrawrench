import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cron-schedule behaviour of the workflow service: validation at save time,
 * the computed (not "now") next_run_at, and the schedule read model. The cron
 * maths itself is covered in @infrawrench/client-core's cron tests.
 */

const selectRows = vi.fn<() => unknown[]>(() => []);
const updateSet = vi.fn();

vi.mock("../../db/client", () => {
  const limit = () => Promise.resolve(selectRows());
  const makeWhere = () => ({ limit, orderBy: () => ({ limit }) });
  return {
    db: {
      select: () => ({ from: () => ({ where: makeWhere }) }),
      update: () => ({
        set: (values: unknown) => {
          updateSet(values);
          return { where: () => Promise.resolve() };
        },
      }),
      insert: () => ({ values: () => Promise.resolve() }),
    },
  };
});

vi.mock("../../db/schema", () => ({
  workflows: { id: "id", organizationId: "organization_id", deletedAt: "deleted_at" },
  workflowRuns: {},
  workflowMetrics: {},
  budgets: { id: "id", organizationId: "organization_id", deletedAt: "deleted_at" },
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

// Avoid pulling server-core's AI billing (and its real db client / drizzle `sql`
// usage) into this suite: the drizzle-orm mock above is intentionally partial.
vi.mock("@infrawrench/server-core/workflows/ai", () => ({
  isWorkflowAiConfigured: () => false,
}));

vi.mock("../workflow-host", () => ({
  listOrgPlugins: vi.fn().mockResolvedValue([]),
}));

const assignedSecretIds = vi.fn<() => string[]>(() => []);
vi.mock("../workflow-secrets", () => ({
  getWorkflowSecretAssignments: () => Promise.resolve(assignedSecretIds()),
  setWorkflowSecretAssignments: vi.fn().mockResolvedValue([]),
  validateWorkflowSecretIds: (_org: string, ids: string[]) => Promise.resolve([...new Set(ids)]),
}));

const {
  WorkflowError,
  assignWorkflowSecrets,
  setWorkflowSchedule,
  clearWorkflowSchedule,
  updateWorkflow,
  workflowScheduleView,
} = await import("../workflows");

function workflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf1",
    organizationId: "org1",
    name: "wf",
    description: null,
    source: "",
    trigger: { kind: "manual" },
    metricDefs: [],
    enabled: true,
    webhookToken: null,
    webhookSecret: null,
    nextRunAt: null,
    lastRunAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows.mockReturnValue([workflowRow()]);
});

describe("setWorkflowSchedule", () => {
  it("rejects an unparseable expression with a 400 WorkflowError", async () => {
    await expect(
      setWorkflowSchedule("org1", "wf1", { expression: "not a cron" }, "u1"),
    ).rejects.toMatchObject({ name: "WorkflowError", status: 400 });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects an unknown timezone", async () => {
    await expect(
      setWorkflowSchedule("org1", "wf1", { expression: "0 9 * * *", timezone: "Not/AZone" }, "u1"),
    ).rejects.toThrow(/timezone/i);
  });

  it("404s on a missing workflow", async () => {
    selectRows.mockReturnValue([]);
    await expect(
      setWorkflowSchedule("org1", "missing", { expression: "0 9 * * *" }, "u1"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("stores the cron trigger with the real next occurrence, not now", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-31T12:00:00Z")); // a Friday
      await setWorkflowSchedule("org1", "wf1", { expression: "0 9 * * 1", timezone: "UTC" }, "u1");
      expect(updateSet).toHaveBeenCalledTimes(1);
      const values = updateSet.mock.calls[0]?.[0] as {
        trigger: { kind: string; expression: string; timezone?: string };
        nextRunAt: Date | null;
      };
      expect(values.trigger).toEqual({ kind: "cron", expression: "0 9 * * 1", timezone: "UTC" });
      // A "now" seed would fire the workflow on save; this is next Monday 9am.
      expect(values.nextRunAt).toEqual(new Date("2026-08-03T09:00:00Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves next_run_at empty while the workflow is disabled", async () => {
    await setWorkflowSchedule("org1", "wf1", { expression: "0 9 * * *", enabled: false }, "u1");
    const values = updateSet.mock.calls[0]?.[0] as { nextRunAt: Date | null; enabled: boolean };
    expect(values.enabled).toBe(false);
    expect(values.nextRunAt).toBeNull();
  });
});

/**
 * Automated runs act for `sourceAuthorUserId`. The escalation this covers: a
 * member with `workflows:write` rewrote an admin's workflow, the attributed
 * user never changed, and the next cron tick ran the member's code with the
 * admin's permissions.
 */
describe("automated-run attribution", () => {
  const ADMIN_WORKFLOW = {
    source: "await infra.log('admin');",
    trigger: { kind: "cron", expression: "0 9 * * *" },
    createdByUserId: "admin",
    sourceAuthorUserId: "admin",
  };

  function attributed(): unknown {
    const values = updateSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    return "sourceAuthorUserId" in values ? values["sourceAuthorUserId"] : "unchanged";
  }

  beforeEach(() => {
    selectRows.mockReturnValue([workflowRow(ADMIN_WORKFLOW)]);
    assignedSecretIds.mockReturnValue(["s1"]);
  });

  it("re-attributes to the editor when the source changes", async () => {
    await updateWorkflow("org1", "wf1", { source: "await infra.log('member');" }, "member");
    expect(attributed()).toBe("member");
  });

  it("re-attributes when the trigger changes", async () => {
    await updateWorkflow(
      "org1",
      "wf1",
      { trigger: { kind: "cron", expression: "*/5 * * * *" } },
      "member",
    );
    expect(attributed()).toBe("member");
  });

  it("re-attributes when the assigned secrets change", async () => {
    await updateWorkflow("org1", "wf1", { secretIds: ["s1", "s2"] }, "member");
    expect(attributed()).toBe("member");
  });

  it("re-attributes through the schedule sub-resource", async () => {
    await setWorkflowSchedule("org1", "wf1", { expression: "*/5 * * * *" }, "member");
    expect(attributed()).toBe("member");
  });

  it("re-attributes through the secrets sub-resource", async () => {
    await assignWorkflowSecrets("org1", "wf1", ["s1", "s2"], "member");
    expect(attributed()).toBe("member");
  });

  it("denies rather than keeping the old author when no editor is recorded", async () => {
    await updateWorkflow("org1", "wf1", { source: "await infra.log('?');" }, null);
    expect(attributed()).toBeNull();
  });

  it("keeps the author for a rename, a re-save of identical content, or a toggle", async () => {
    // The editor saves the whole body, so identical source/trigger/secrets
    // must not count as a change, or renaming would move a schedule's
    // permissions. Key order differs on purpose: jsonb does not preserve it.
    await updateWorkflow(
      "org1",
      "wf1",
      {
        name: "renamed",
        enabled: false,
        source: ADMIN_WORKFLOW.source,
        trigger: { expression: "0 9 * * *", kind: "cron" },
        secretIds: ["s1"],
      },
      "member",
    );
    expect(attributed()).toBe("unchanged");

    vi.clearAllMocks();
    await assignWorkflowSecrets("org1", "wf1", ["s1"], "member");
    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe("clearWorkflowSchedule", () => {
  it("reverts a cron trigger to manual and clears next_run_at", async () => {
    selectRows.mockReturnValue([
      workflowRow({ trigger: { kind: "cron", expression: "0 9 * * *" }, nextRunAt: new Date() }),
    ]);
    await clearWorkflowSchedule("org1", "wf1", "u1");
    const values = updateSet.mock.calls[0]?.[0] as { trigger: unknown; nextRunAt: Date | null };
    expect(values.trigger).toEqual({ kind: "manual" });
    expect(values.nextRunAt).toBeNull();
  });

  it("is a no-op for non-cron triggers", async () => {
    await clearWorkflowSchedule("org1", "wf1", "u1");
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("still 404s on a missing workflow", async () => {
    selectRows.mockReturnValue([]);
    await expect(clearWorkflowSchedule("org1", "wf1", "u1")).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe("workflowScheduleView", () => {
  it("is null for non-cron triggers", () => {
    expect(workflowScheduleView(workflowRow() as never)).toBeNull();
  });

  it("returns the schedule with a computed preview", () => {
    const view = workflowScheduleView(
      workflowRow({
        trigger: { kind: "cron", expression: "*/30 * * * *" },
        nextRunAt: new Date("2027-01-01T00:00:00Z"),
      }) as never,
    );
    expect(view).not.toBeNull();
    expect(view!.expression).toBe("*/30 * * * *");
    expect(view!.timezone).toBeNull();
    expect(view!.enabled).toBe(true);
    expect(view!.nextRuns).toHaveLength(3);
    // Consecutive half-hour marks.
    expect(view!.nextRuns[1]!.getTime() - view!.nextRuns[0]!.getTime()).toBe(30 * 60 * 1000);
  });

  it("tolerates a stored expression that no longer parses", () => {
    const view = workflowScheduleView(
      workflowRow({ trigger: { kind: "cron", expression: "junk" } }) as never,
    );
    expect(view).not.toBeNull();
    expect(view!.nextRuns).toEqual([]);
  });
});
