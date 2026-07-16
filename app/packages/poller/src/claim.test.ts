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

import { claimDueAccounts, claimDueWorkflows, ACCOUNT_LEASE_MS, WORKFLOW_LEASE_MS } from "./claim";

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
