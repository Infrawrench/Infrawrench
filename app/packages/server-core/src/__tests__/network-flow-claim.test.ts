import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("../db/client", () => ({ db: { execute: (q: unknown) => execute(q) } }));
// The pass imports the collector and the plugin registry at module load; the
// claim needs neither, and loading them here would drag every plugin in.
vi.mock("../plugin-loader", () => ({ loadPlugins: async () => [] }));
vi.mock("../network-flow/collect", () => ({ collectAccountNetworkFlows: async () => ({}) }));

// Capture the sql tag's inputs so tests can assert on — and execute — the raw
// statement. Everything else in drizzle stays real, since the schema module
// this pass imports is built out of it.
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  }),
}));

import { claimDueNetworkFlowAccounts, NETWORK_FLOW_LEASE_MS } from "../network-flow/pass";

interface CapturedQuery {
  strings: string[];
  values: unknown[];
}

function statementText(call: number = 0): string {
  return (execute.mock.calls[call]![0] as CapturedQuery).strings.join("?");
}

/**
 * The `ON CONFLICT DO UPDATE … WHERE` predicate, as a function of the row it
 * would be re-checked against.
 *
 * Deliberately narrow: it understands the two atoms this claim is allowed to
 * use and throws on anything else, so a predicate that does not actually test
 * due-ness cannot pass the race test by being waved through as "there is a
 * WHERE, so it must be exclusive".
 */
function conflictPredicate(
  text: string,
): ((nextPollAt: number | null, now: number) => boolean) | null {
  const upsert = text.slice(text.indexOf("ON CONFLICT"));
  const match = /DO UPDATE\s+SET[\s\S]*?\sWHERE\s([\s\S]*?)\sRETURNING/i.exec(upsert);
  if (!match) return null;
  const atoms = match[1]!
    // Comments are part of the statement text; they are not part of the predicate.
    .replace(/--[^\n]*/g, " ")
    .replace(/account_network_flow_polls\./g, "")
    .split(/\s+OR\s+/i)
    .map((atom) => atom.replace(/\s+/g, " ").trim())
    .filter((atom) => atom !== "");
  const tests = atoms.map((atom) => {
    if (/^\(?next_poll_at IS NULL\)?$/i.test(atom)) return (v: number | null) => v === null;
    if (/^\(?next_poll_at <= now\(\)\)?$/i.test(atom))
      return (v: number | null, now: number) => v !== null && v <= now;
    throw new Error(`unsupported ON CONFLICT predicate: ${atom}`);
  });
  return (nextPollAt, now) => tests.some((t) => t(nextPollAt, now));
}

/**
 * Just enough Postgres to run this claim, modelling the two behaviours the
 * exclusivity argument rests on:
 *
 * - the `SELECT` half reads a **snapshot**, so every replica in a round sees
 *   the same accounts as due however many of them have already claimed;
 * - `ON CONFLICT DO UPDATE` re-checks its `WHERE` against the **latest**
 *   committed version of the conflicting row, under a lock.
 *
 * Nothing else about the statement is interpreted, so this can only ever prove
 * a claim non-exclusive for the reason a real deployment would.
 */
class FakePostgres {
  now = Date.parse("2026-08-11T12:00:00.000Z");
  /** account_id → next_poll_at (epoch ms), or null. Absent means no poll row. */
  rows = new Map<string, number | null>();
  /** Accounts the SELECT half finds, frozen for the whole round. */
  private snapshot: string[] = [];

  /** Freeze what every replica in this round's SELECT will see. */
  beginRound(accountIds: string[]) {
    this.snapshot = accountIds.filter((id) => {
      if (!this.rows.has(id)) return true;
      const next = this.rows.get(id)!;
      return next === null || next <= this.now;
    });
  }

  execute = (q: CapturedQuery): Record<string, unknown>[] => {
    const text = q.strings.join("?");
    const predicate = conflictPredicate(text);
    const claimed: Record<string, unknown>[] = [];
    for (const id of this.snapshot) {
      if (this.rows.has(id)) {
        // Conflict: the row is re-read at its latest version and the predicate
        // decides. A row the predicate rejects is neither updated nor returned.
        if (predicate && !predicate(this.rows.get(id)!, this.now)) continue;
      }
      this.rows.set(id, this.now + NETWORK_FLOW_LEASE_MS);
      claimed.push({ account_id: id, organization_id: "org-1", failure_count: 0 });
    }
    return claimed;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue([]);
});

describe("claimDueNetworkFlowAccounts", () => {
  it("leases into next_poll_at and only looks at enabled orgs and capable plugins", async () => {
    await claimDueNetworkFlowAccounts(2, ["aws"]);

    const text = statementText();
    expect(text).toContain("INSERT INTO account_network_flow_polls");
    expect(text).toContain("s.enabled = true");
    expect(text).toContain("a.plugin_id IN ");
    expect(text).toContain("deleted_at IS NULL");
    expect(text).toContain("ORDER BY p.last_polled_at ASC NULLS FIRST, a.id ASC");
    expect(text).toContain("RETURNING account_id, organization_id, failure_count");
  });

  // The claim's exclusivity lives entirely in this predicate: an unconditional
  // DO UPDATE re-leases and returns the row to whoever asks.
  it("guards the conflict update with a due-time predicate", async () => {
    await claimDueNetworkFlowAccounts(2, ["aws"]);

    const text = statementText();
    expect(/DO UPDATE\s+SET[\s\S]*\sWHERE\s/i.test(text.slice(text.indexOf("ON CONFLICT")))).toBe(
      true,
    );
    expect(conflictPredicate(text)).not.toBeNull();
  });

  it("short-circuits without querying when no plugin can report flows", async () => {
    await expect(claimDueNetworkFlowAccounts(2, [])).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("maps returned snake_case rows", async () => {
    execute.mockResolvedValue([
      { account_id: "acct-1", organization_id: "org-1", failure_count: 4 },
    ]);

    await expect(claimDueNetworkFlowAccounts(2, ["aws"])).resolves.toEqual([
      { accountId: "acct-1", organizationId: "org-1", failureCount: 4 },
    ]);
  });

  /*
   * Regression: two poller replicas ticking together both saw the account as
   * due, and an unconditional conflict update handed it to both. Each then ran
   * the flow-log query — which the provider bills to the *customer's* cloud
   * account by the gigabyte scanned, so a lost race is a real charge on
   * somebody else's bill.
   */
  describe("under two concurrent replicas", () => {
    it("gives an already-leased account to exactly one of them", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000); // due
      pg.beginRound(["acct-1"]);
      execute.mockImplementation((q: CapturedQuery) => Promise.resolve(pg.execute(q)));

      const first = await claimDueNetworkFlowAccounts(2, ["aws"]);
      const second = await claimDueNetworkFlowAccounts(2, ["aws"]);

      expect(first.map((r) => r.accountId)).toEqual(["acct-1"]);
      expect(second).toEqual([]);
    });

    it("gives a never-polled account to exactly one of them", async () => {
      const pg = new FakePostgres();
      pg.beginRound(["acct-new"]); // no poll row at all
      execute.mockImplementation((q: CapturedQuery) => Promise.resolve(pg.execute(q)));

      const first = await claimDueNetworkFlowAccounts(2, ["aws"]);
      const second = await claimDueNetworkFlowAccounts(2, ["aws"]);

      expect(first.map((r) => r.accountId)).toEqual(["acct-new"]);
      expect(second).toEqual([]);
    });

    it("splits a batch rather than duplicating it", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000);
      pg.rows.set("acct-2", null);
      pg.beginRound(["acct-1", "acct-2"]);
      execute.mockImplementation((q: CapturedQuery) => Promise.resolve(pg.execute(q)));

      const first = await claimDueNetworkFlowAccounts(2, ["aws"]);
      const second = await claimDueNetworkFlowAccounts(2, ["aws"]);

      expect(first.map((r) => r.accountId)).toEqual(["acct-1", "acct-2"]);
      expect(second).toEqual([]);
    });

    // The lease is a lease, not a lock: a replica that dies mid-pass must not
    // strand the account forever.
    it("re-offers the account once the lease has expired", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000);
      pg.beginRound(["acct-1"]);
      execute.mockImplementation((q: CapturedQuery) => Promise.resolve(pg.execute(q)));
      await claimDueNetworkFlowAccounts(2, ["aws"]);

      pg.now += NETWORK_FLOW_LEASE_MS + 1;
      pg.beginRound(["acct-1"]);

      await expect(claimDueNetworkFlowAccounts(2, ["aws"])).resolves.toEqual([
        { accountId: "acct-1", organizationId: "org-1", failureCount: 0 },
      ]);
    });
  });
});
