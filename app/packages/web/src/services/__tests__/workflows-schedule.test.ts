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
// usage) into this suite — the drizzle-orm mock above is intentionally partial.
vi.mock("@infrawrench/server-core/workflows/ai", () => ({
  isWorkflowAiConfigured: () => false,
}));

vi.mock("../workflow-host", () => ({
  listOrgPlugins: vi.fn().mockResolvedValue([]),
}));

const { WorkflowError, setWorkflowSchedule, clearWorkflowSchedule, workflowScheduleView } =
  await import("../workflows");

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
      setWorkflowSchedule("org1", "wf1", { expression: "not a cron" }),
    ).rejects.toMatchObject({ name: "WorkflowError", status: 400 });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects an unknown timezone", async () => {
    await expect(
      setWorkflowSchedule("org1", "wf1", { expression: "0 9 * * *", timezone: "Not/AZone" }),
    ).rejects.toThrow(/timezone/i);
  });

  it("404s on a missing workflow", async () => {
    selectRows.mockReturnValue([]);
    await expect(
      setWorkflowSchedule("org1", "missing", { expression: "0 9 * * *" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("stores the cron trigger with the real next occurrence, not now", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-31T12:00:00Z")); // a Friday
      await setWorkflowSchedule("org1", "wf1", { expression: "0 9 * * 1", timezone: "UTC" });
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
    await setWorkflowSchedule("org1", "wf1", { expression: "0 9 * * *", enabled: false });
    const values = updateSet.mock.calls[0]?.[0] as { nextRunAt: Date | null; enabled: boolean };
    expect(values.enabled).toBe(false);
    expect(values.nextRunAt).toBeNull();
  });
});

describe("clearWorkflowSchedule", () => {
  it("reverts a cron trigger to manual and clears next_run_at", async () => {
    selectRows.mockReturnValue([
      workflowRow({ trigger: { kind: "cron", expression: "0 9 * * *" }, nextRunAt: new Date() }),
    ]);
    await clearWorkflowSchedule("org1", "wf1");
    const values = updateSet.mock.calls[0]?.[0] as { trigger: unknown; nextRunAt: Date | null };
    expect(values.trigger).toEqual({ kind: "manual" });
    expect(values.nextRunAt).toBeNull();
  });

  it("is a no-op for non-cron triggers", async () => {
    await clearWorkflowSchedule("org1", "wf1");
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("still 404s on a missing workflow", async () => {
    selectRows.mockReturnValue([]);
    await expect(clearWorkflowSchedule("org1", "wf1")).rejects.toBeInstanceOf(WorkflowError);
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
