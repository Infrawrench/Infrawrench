import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("@infrawrench/server-core/db/client", () => ({
  db: { execute: (q: unknown) => execute(q) },
}));

// Capture the sql tag's inputs so tests can assert on the raw statement text.
vi.mock("drizzle-orm", () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }),
    { raw: (text: string) => ({ raw: text }) },
  ),
}));

import {
  claimDueAccounts,
  claimDueCostAccounts,
  claimDueQuotaAccounts,
  claimDueVulnerabilityAccounts,
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

/** The scope condition `all` splices in: nothing at all. */
const NO_SCOPE = { strings: [""], values: [] };

/** Any spliced-in fragment, for the product conditions (asserted by text). */
const FRAGMENT = expect.objectContaining({ strings: expect.any(Array) });

/** Flatten a captured query, nested fragments included, to its text. */
function flatText(q: unknown): string {
  if (q && typeof q === "object" && "raw" in q) return String((q as { raw: string }).raw);
  if (!q || typeof q !== "object" || !("strings" in q)) return "?";
  const { strings, values } = q as CapturedQuery;
  return strings.map((str, i) => str + (i < values.length ? flatText(values[i]) : "")).join("");
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
    expect(q.values).toEqual([ACCOUNT_LEASE_MS, NO_SCOPE, FRAGMENT, 8]);
  });

  it("only considers live, due accounts, never-polled first", async () => {
    await claimDueAccounts(3);

    const text = capturedSql().strings.join("?");
    expect(text).toContain("deleted_at IS NULL");
    expect(text).toContain("next_poll_at IS NULL OR next_poll_at <= now()");
    expect(text).toContain("ORDER BY last_polled_at ASC NULLS FIRST, id ASC");
  });

  it("leaves gateway-bound accounts to the gateway when claiming for the edge", async () => {
    await claimDueAccounts(8, "edge");

    const text = flatText(capturedSql());
    expect(text).toMatch(/AND NOT \(\s*accounts\.requires_gateway/);
    expect(text).toContain("accounts.bastion_id IS NOT NULL");
    expect(text).toContain("FROM ssh_tunnel_configs t WHERE t.account_id = accounts.id");
  });

  it("claims only gateway-bound accounts when claiming for the gateway", async () => {
    await claimDueAccounts(8, "gateway");

    const text = flatText(capturedSql());
    expect(text).toMatch(/AND \(\s*accounts\.requires_gateway/);
    expect(text).not.toContain("AND NOT");
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
    await claimDueCostAccounts(2, ["aws", "gcp"], []);

    const q = capturedSql();
    const text = q.strings.join("?");
    expect(text).toContain("FOR UPDATE SKIP LOCKED");
    expect(text).toContain("UPDATE accounts");
    expect(text).toContain("SET cost_next_poll_at = now() +");
    expect(q.values).toEqual([COST_LEASE_MS, ["aws", "gcp"], NO_SCOPE, FRAGMENT, 2]);
  });

  // Regression: this used to be `= ANY(${ids})`. The sql tag expands a JS array
  // into a parenthesized placeholder list, so ANY() received `($2, $3)` (a row
  // constructor, not an array) and every cost tick died with Postgres 42809.
  // The mocked sql tag can't execute SQL, so assert on the operator directly.
  it("matches plugin ids with IN, never ANY()", async () => {
    await claimDueCostAccounts(2, ["aws", "gcp"], []);

    const text = capturedSql().strings.join("?");
    expect(text).toContain("plugin_id IN ");
    expect(text).not.toContain("plugin_id = ANY(");
  });

  it("treats a NULL cost_next_poll_at as due, never-polled first", async () => {
    await claimDueCostAccounts(2, ["aws"], []);

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

    await expect(claimDueCostAccounts(2, ["aws"], [])).resolves.toEqual([
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
    await expect(claimDueCostAccounts(2, [], [])).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});

/*
 * A connection is made for chosen apps (`accounts.products`, NULL = all of
 * them). The mocked sql tag cannot run SQL, so these pin the predicate each
 * claim carries; `account-products.test.ts` in server-core covers the helper.
 */
describe("claims honour the apps a connection is for", () => {
  it("never resource-syncs a connection made for Costs alone", async () => {
    await claimDueAccounts(8);

    const text = flatText(capturedSql());
    expect(text).toContain(
      "AND (accounts.products IS NULL OR jsonb_array_length(accounts.products - 'costs') > 0)",
    );
    // Inside the locking subquery, so a skipped account is never leased.
    expect(text.indexOf("accounts.products IS NULL")).toBeLessThan(
      text.indexOf("FOR UPDATE SKIP LOCKED"),
    );
  });

  it("collects costs only where Costs was chosen, for plugins that offer the choice", async () => {
    await claimDueCostAccounts(2, ["aws", "gcp"], ["aws"]);

    const text = flatText(capturedSql());
    expect(text).toContain("accounts.products IS NULL OR CASE WHEN accounts.plugin_id IN ?");
    expect(text).toContain("THEN accounts.products @> ?::jsonb");
    const gate = capturedSql().values.find((v) =>
      flatText(v).includes("CASE WHEN"),
    ) as CapturedQuery;
    expect(gate.values).toContainEqual(["aws"]);
    expect(gate.values).toContain('["costs"]');
  });

  it("falls back to the inventory rule when no plugin offers the choice", async () => {
    await claimDueCostAccounts(2, ["aws"], []);

    const text = flatText(capturedSql());
    expect(text).not.toContain("CASE WHEN");
    expect(text).toContain("jsonb_array_length(accounts.products - 'costs') > 0");
  });

  it("gates quotas on Infrastructure and vulnerabilities on Security", async () => {
    await claimDueQuotaAccounts(2, ["aws"], ["aws"]);
    const quota = capturedSql();
    expect(flatText(quota)).toContain("CASE WHEN a.plugin_id IN ?");
    expect(JSON.stringify(quota.values)).toContain('[\\"infrastructure\\"]');

    execute.mockClear();
    await claimDueVulnerabilityAccounts(2, ["aws"], ["github"]);
    const vulnerabilities = capturedSql();
    expect(JSON.stringify(vulnerabilities.values)).toContain('[\\"security\\"]');
    // The product condition sits in the SELECT half, before the upsert.
    const text = flatText(vulnerabilities);
    expect(text.indexOf("a.products IS NULL")).toBeLessThan(text.indexOf("ON CONFLICT"));
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
