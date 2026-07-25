import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("@infrawrench/server-core/db/client", () => ({
  db: { execute: (q: unknown) => execute(q) },
}));

// Capture the sql tag's inputs so tests can assert on the raw statement text.
vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  }),
}));

import {
  claimDueAccounts,
  claimDueCostAccounts,
  claimDueWorkflows,
  ACCOUNT_LEASE_MS,
  COST_LEASE_MS,
  WORKFLOW_LEASE_MS,
} from "./claim";

interface CapturedQuery {
  strings: string[];
  values: unknown[];
}

function capturedSql(): CapturedQuery {
  return execute.mock.calls[0]![0] as CapturedQuery;
}

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue([]);
});

describe("claimDueAccounts", () => {
  it("claims atomically with SKIP LOCKED and a lease on next_poll_at", async () => {
    await claimDueAccounts(8);

    const q = capturedSql();
    const text = q.strings.join("?");
    expect(text).toContain("FOR UPDATE SKIP LOCKED");
    expect(text).toContain("UPDATE accounts");
    expect(text).toContain("SET next_poll_at = now() +");
    expect(text).toContain("RETURNING");
    expect(q.values).toEqual([ACCOUNT_LEASE_MS, 8]);
  });

  it("only considers live, due accounts, never-polled first", async () => {
    await claimDueAccounts(3);

    const text = capturedSql().strings.join("?");
    expect(text).toContain("deleted_at IS NULL");
    expect(text).toContain("next_poll_at IS NULL OR next_poll_at <= now()");
    expect(text).toContain("ORDER BY last_polled_at ASC NULLS FIRST, id ASC");
  });

  it("maps returned snake_case rows to PollAccountRow", async () => {
    execute.mockResolvedValue([
      {
        id: "a1",
        organization_id: "org1",
        plugin_id: "aws",
        display_name: "Prod AWS",
        poll_failure_count: 2,
      },
    ]);

    const rows = await claimDueAccounts(8);

    expect(rows).toEqual([
      {
        id: "a1",
        organizationId: "org1",
        pluginId: "aws",
        displayName: "Prod AWS",
        pollFailureCount: 2,
      },
    ]);
  });

  it("returns an empty array when nothing is due", async () => {
    await expect(claimDueAccounts(8)).resolves.toEqual([]);
  });
});

describe("claimDueCostAccounts", () => {
  it("claims atomically with SKIP LOCKED and a lease on cost_next_poll_at", async () => {
    await claimDueCostAccounts(2, ["aws", "gcp"]);

    const q = capturedSql();
    const text = q.strings.join("?");
    expect(text).toContain("FOR UPDATE SKIP LOCKED");
    expect(text).toContain("UPDATE accounts");
    expect(text).toContain("SET cost_next_poll_at = now() +");
    expect(q.values).toEqual([COST_LEASE_MS, ["aws", "gcp"], 2]);
  });

  // Regression: this used to be `= ANY(${ids})`. The sql tag expands a JS array
  // into a parenthesized placeholder list, so ANY() received `($2, $3)` — a row
  // constructor, not an array — and every cost tick died with Postgres 42809.
  // The mocked sql tag can't execute SQL, so assert on the operator directly.
  it("matches plugin ids with IN, never ANY()", async () => {
    await claimDueCostAccounts(2, ["aws", "gcp"]);

    const text = capturedSql().strings.join("?");
    expect(text).toContain("plugin_id IN ");
    expect(text).not.toContain("plugin_id = ANY(");
  });

  it("treats a NULL cost_next_poll_at as due, never-polled first", async () => {
    await claimDueCostAccounts(2, ["aws"]);

    const text = capturedSql().strings.join("?");
    expect(text).toContain("deleted_at IS NULL");
    expect(text).toContain("cost_next_poll_at IS NULL OR cost_next_poll_at <= now()");
    expect(text).toContain("ORDER BY cost_last_polled_at ASC NULLS FIRST, id ASC");
  });

  it("maps cost_poll_failure_count onto pollFailureCount", async () => {
    execute.mockResolvedValue([
      {
        id: "a1",
        organization_id: "org1",
        plugin_id: "aws",
        display_name: "Prod AWS",
        cost_poll_failure_count: 3,
      },
    ]);

    await expect(claimDueCostAccounts(2, ["aws"])).resolves.toEqual([
      {
        id: "a1",
        organizationId: "org1",
        pluginId: "aws",
        displayName: "Prod AWS",
        pollFailureCount: 3,
      },
    ]);
  });

  // An empty IN () list is a syntax error, so the guard has to short-circuit
  // before the query is ever built.
  it("short-circuits without querying when no plugin declares costs", async () => {
    await expect(claimDueCostAccounts(2, [])).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("claimDueWorkflows", () => {
  it("claims atomically with SKIP LOCKED and a fallback lease on next_run_at", async () => {
    await claimDueWorkflows(8);

    const q = capturedSql();
    const text = q.strings.join("?");
    expect(text).toContain("FOR UPDATE SKIP LOCKED");
    expect(text).toContain("UPDATE workflows");
    expect(text).toContain("SET next_run_at = now() +");
    expect(q.values).toEqual([WORKFLOW_LEASE_MS, 8]);
  });

  it("only considers enabled, live, scheduled workflows", async () => {
    await claimDueWorkflows(8);

    const text = capturedSql().strings.join("?");
    expect(text).toContain("enabled = true");
    expect(text).toContain("deleted_at IS NULL");
    expect(text).toContain("next_run_at IS NOT NULL");
    expect(text).toContain("next_run_at <= now()");
  });

  it("maps returned rows, passing the trigger jsonb through untouched", async () => {
    const trigger = { kind: "cron", expression: "*/5 * * * *" };
    execute.mockResolvedValue([{ id: "w1", organization_id: "org1", trigger }]);

    const rows = await claimDueWorkflows(8);

    expect(rows).toEqual([{ id: "w1", organizationId: "org1", trigger }]);
  });
});
