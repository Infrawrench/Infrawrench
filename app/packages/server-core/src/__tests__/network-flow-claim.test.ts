import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
const update = vi.fn();
vi.mock("../db/client", () => ({
  db: {
    execute: (q: unknown) => execute(q),
    update: (t: unknown) => update(t),
  },
}));
// The pass imports the collector and the plugin registry at module load; the
// claim needs neither, and loading the real registry would drag every plugin
// in. One flow-capable stub is enough for the pass-level tests below.
vi.mock("../plugin-loader", () => ({
  loadPlugins: async () => [{ plugin: { manifest: { id: "aws", networkFlows: {} } } }],
}));
const collect = vi.fn(async () => ({}));
vi.mock("../network-flow/collect", () => ({
  collectAccountNetworkFlows: (...args: unknown[]) =>
    (collect as unknown as (...a: unknown[]) => unknown)(...args),
}));

// Capture the sql tag's inputs so tests can assert on — and execute — the raw
// statement. `eq`/`and` become inspectable descriptors for the same reason: the
// lease renewal is a compare-and-swap issued through the query builder, and the
// fake below has to be able to read its predicate. Everything else in drizzle
// stays real, since the schema module this pass imports is built out of it.
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  }),
  eq: (column: { name: string }, value: unknown) => ({
    op: "eq" as const,
    column: column.name,
    value,
  }),
  and: (...conditions: unknown[]) => ({ op: "and" as const, conditions }),
}));

import {
  NETWORK_FLOW_HEARTBEAT_MS,
  NetworkFlowLeaseLostError,
  startNetworkFlowLease,
} from "../network-flow/lease";
import {
  claimDueNetworkFlowAccounts,
  NETWORK_FLOW_INTERVAL_MS,
  NETWORK_FLOW_LEASE_MS,
  runNetworkFlowPass,
} from "../network-flow/pass";

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

/** A mocked `eq`/`and`, as the fake update below reads them back. */
type FakeCondition =
  { op: "eq"; column: string; value: unknown } | { op: "and"; conditions: unknown[] };

function conditionMatches(cond: unknown, row: Record<string, unknown>): boolean {
  if (cond === undefined || cond === null) return true;
  const c = cond as FakeCondition;
  if (c.op === "and") return c.conditions.every((inner) => conditionMatches(inner, row));
  const actual = row[c.column];
  // Timestamps live in the fake as epoch ms; the query builder compares Dates.
  if (c.value instanceof Date) return actual !== null && actual === c.value.getTime();
  return actual === c.value;
}

/**
 * Just enough Postgres to run this claim and the lease renewal that keeps it
 * alive, modelling the three behaviours the exclusivity argument rests on:
 *
 * - the `SELECT` half reads a **snapshot**, so every replica in a round sees
 *   the same accounts as due however many of them have already claimed;
 * - `ON CONFLICT DO UPDATE` re-checks its `WHERE` against the **latest**
 *   committed version of the conflicting row, under a lock;
 * - a renewal is a plain conditional `UPDATE`, so it touches nothing when the
 *   owner token it names is no longer the one in the row.
 *
 * Nothing else about either statement is interpreted, so this can only ever
 * prove a claim non-exclusive for the reason a real deployment would.
 */
class FakePostgres {
  now = Date.parse("2026-08-11T12:00:00.000Z");
  /** account_id → next_poll_at (epoch ms), or null. Absent means no poll row. */
  rows = new Map<string, number | null>();
  /**
   * account_id → lease_owner. The row's other half, kept beside {@link rows}
   * rather than folded into it so that the deadline — which is what due-ness
   * and every reschedule are about — stays directly readable in the assertions.
   */
  owners = new Map<string, string | null>();
  /** Distinct per claim, as `randomUUID` is in the real one. */
  private claims = 0;
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
    const owner = `lease-${(this.claims += 1)}`;
    const claimed: Record<string, unknown>[] = [];
    for (const id of this.snapshot) {
      if (this.rows.has(id)) {
        // Conflict: the row is re-read at its latest version and the predicate
        // decides. A row the predicate rejects is neither updated nor returned.
        if (predicate && !predicate(this.rows.get(id)!, this.now)) continue;
      }
      this.rows.set(id, this.now + NETWORK_FLOW_LEASE_MS);
      // Claiming an account replaces whatever identity it was held under, so
      // the previous holder's renewals stop matching from here on.
      this.owners.set(id, owner);
      claimed.push({
        account_id: id,
        organization_id: "org-1",
        failure_count: 0,
        // The claim hands the winner the token it wrote; that value is what
        // every later renewal and the terminal write are checked against.
        lease_owner: owner,
      });
    }
    return claimed;
  };

  /** `db.update(...).set(...).where(...)`, optionally `.returning(...)`. */
  update = () => {
    let values: Record<string, unknown> = {};
    const run = (cond: unknown) => {
      const updated: Record<string, unknown>[] = [];
      for (const [id, next] of [...this.rows]) {
        if (
          !conditionMatches(cond, {
            account_id: id,
            organization_id: "org-1",
            next_poll_at: next,
            lease_owner: this.owners.get(id) ?? null,
          })
        )
          continue;
        const raw = values["nextPollAt"];
        // A `sql` template in the SET is the renewal's server-side
        // `now() + lease`; a Date is the pass's own reschedule.
        const written =
          raw instanceof Date
            ? raw.getTime()
            : raw && typeof raw === "object"
              ? this.now + NETWORK_FLOW_LEASE_MS
              : next;
        this.rows.set(id, written);
        // Only the pass's terminal writes name this column, and they name it to
        // hand the lease back.
        if ("leaseOwner" in values) this.owners.set(id, values["leaseOwner"] as string | null);
        updated.push({ accountId: id });
      }
      return updated;
    };
    const builder = {
      set: (v: Record<string, unknown>) => {
        values = v;
        return builder;
      },
      where: (cond: unknown) => ({
        returning: () => Promise.resolve(run(cond)),
        then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
          Promise.resolve(run(cond)).then(onOk, onErr),
      }),
    };
    return builder;
  };
}

/** Point both halves of the mocked `db` at one fake. */
function wire(pg: FakePostgres) {
  execute.mockImplementation((q: CapturedQuery) => Promise.resolve(pg.execute(q)));
  update.mockImplementation(() => pg.update());
}

/** Knobs for {@link wireWithRenewals}, and what it observed. */
interface RenewalControl {
  /**
   * Writes the *pass* made. Renewals are excluded: they are the lease's own
   * bookkeeping, whereas these are the reschedule and the failure record, which
   * is exactly the difference the tests below are about.
   */
  passWrites: Record<string, unknown>[];
  /** Fail this many renewals the way a dropped connection does. */
  failRenewals: number;
  /**
   * Lose the *answer* to this many renewals, after the write has committed.
   *
   * The third outcome, and the one the holder cannot tell apart from the
   * second: the `UPDATE` reached the row and took effect, and the connection
   * died before the reply came back. The rejection the caller sees is
   * byte-for-byte the one {@link failRenewals} produces; only the row differs.
   */
  dropAnswers: number;
  /**
   * Keep each renewal's promise pending for this long on the fake clock *after*
   * it has already reached the row — which is how a real one behaves, since an
   * `UPDATE` in flight cannot be recalled by the process that sent it.
   */
  renewalDelayMs: number;
}

/**
 * {@link wire}, plus control over how a renewal fails or how long it takes.
 *
 * The renewal is the only write here whose `next_poll_at` is a server-side
 * `sql` template — everything the pass writes is a JS `Date` — so the two are
 * told apart the same way the fake itself tells them apart.
 */
function wireWithRenewals(pg: FakePostgres, control: Partial<RenewalControl> = {}): RenewalControl {
  const state: RenewalControl = {
    passWrites: [],
    failRenewals: 0,
    dropAnswers: 0,
    renewalDelayMs: 0,
    ...control,
  };
  execute.mockImplementation((q: CapturedQuery) => Promise.resolve(pg.execute(q)));
  update.mockImplementation(() => {
    const inner = pg.update();
    let renewal = false;
    return {
      set(values: Record<string, unknown>) {
        renewal = Boolean(values["nextPollAt"]) && !(values["nextPollAt"] instanceof Date);
        if (!renewal) state.passWrites.push(values);
        inner.set(values);
        return this;
      },
      where(cond: unknown) {
        if (renewal && state.failRenewals > 0) {
          state.failRenewals -= 1;
          // Rejected without reaching the row: the deadline in there is
          // untouched, and still this holder's.
          const fail = () => Promise.reject(new Error("connection terminated unexpectedly"));
          return {
            returning: fail,
            then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
              fail().then(ok, err),
          };
        }
        if (renewal && state.dropAnswers > 0) {
          state.dropAnswers -= 1;
          // Committed, and then the connection died. The row has moved; the
          // holder is told only that its renewal did not come back.
          const committed = inner.where(cond).returning();
          const drop = () =>
            committed.then(() => Promise.reject(new Error("connection terminated unexpectedly")));
          return {
            returning: drop,
            then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
              drop().then(ok, err),
          };
        }
        const applied = inner.where(cond).returning();
        const settled =
          renewal && state.renewalDelayMs > 0
            ? new Promise<void>((resolve) => setTimeout(resolve, state.renewalDelayMs)).then(
                () => applied,
              )
            : applied;
        return {
          returning: () => settled,
          then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
            settled.then(ok, err),
        };
      },
    };
  });
  return state;
}

/** A successful collection, as `collectAccountNetworkFlows` reports one. */
function collected(daysCollected: number) {
  return {
    daysCollected,
    rowsWritten: 0,
    queryBytesScanned: 0,
    droppedPairs: 0,
    degraded: false,
    sources: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue([]);
  update.mockImplementation(() => new FakePostgres().update());
  collect.mockResolvedValue({});
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
        {
          accountId: "acct-1",
          organizationId: "org-1",
          failureCount: 0,
          // A fresh identity, not the one the dead replica held.
          leaseOwner: "lease-2",
        },
      ]);
      expect(pg.owners.get("acct-1")).toBe("lease-2");
      expect(pg.rows.get("acct-1")).toBe(pg.now + NETWORK_FLOW_LEASE_MS);
    });
  });

  /*
   * Regression: the claim was exclusive, and then quietly stopped being so.
   *
   * `NETWORK_FLOW_LEASE_MS` was a flat thirty minutes and nothing renewed it,
   * while the work under it was three days per account, each day a serial walk
   * over every usable flow log with its own multi-minute query timeout — hours,
   * arithmetically. Half an hour in, the due-ness predicate above did exactly
   * what it is written to do and handed the account to a second replica, which
   * started the same Logs Insights scans of the same days. Those scans are
   * billed to the *customer's* cloud account per gigabyte, so the overlap is a
   * duplicate charge on somebody else's bill, not wasted CPU on ours.
   */
  describe("while a claimed collection is still running", () => {
    it("returns the owner token it wrote, as the token renewals check", async () => {
      execute.mockResolvedValue([
        {
          account_id: "acct-1",
          organization_id: "org-1",
          failure_count: 0,
          lease_owner: "lease-abc",
        },
      ]);

      // Pinned: `startNetworkFlowLease` degrades to a no-op lease without this
      // column, which would put the overlap back without failing anything. And
      // it has to be written as well as returned, or every renewal matches a
      // null token and the lease is nobody's.
      await claimDueNetworkFlowAccounts(2, ["aws"]);
      const text = statementText();
      expect(text).toContain("lease_owner = ");
      expect(/RETURNING[\s\S]*lease_owner/.test(text)).toBe(true);

      await expect(claimDueNetworkFlowAccounts(2, ["aws"])).resolves.toEqual([
        {
          accountId: "acct-1",
          organizationId: "org-1",
          failureCount: 0,
          leaseOwner: "lease-abc",
        },
      ]);
    });

    it("hands out no second claim for an hour-long collection", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000);
      pg.beginRound(["acct-1"]);
      wire(pg);

      // Three days at twenty minutes each — an hour of billable scanning under
      // a lease that is only ever thirty minutes long. A second replica ticks
      // after every day, which from the second day on is past the point where
      // the lease the claim wrote would have lapsed.
      const secondReplica: unknown[][] = [];
      collect.mockImplementation((async (
        _accountId: string,
        _organizationId: string,
        options: { lease?: { checkpoint(): Promise<boolean> } },
      ) => {
        for (let day = 0; day < 3; day += 1) {
          await options.lease?.checkpoint();
          pg.now += 20 * 60 * 1000;
          pg.beginRound(["acct-1"]);
          secondReplica.push(await claimDueNetworkFlowAccounts(2, ["aws"]));
        }
        return {
          daysCollected: 3,
          rowsWritten: 0,
          queryBytesScanned: 0,
          droppedPairs: 0,
          degraded: false,
          sources: [],
        };
      }) as unknown as () => Promise<Record<string, unknown>>);

      await expect(runNetworkFlowPass()).resolves.toEqual({ claimed: 1 });
      expect(secondReplica).toEqual([[], [], []]);
    });

    it("renews on the heartbeat, so a single long query does not lose the lease", async () => {
      vi.useFakeTimers();
      try {
        const pg = new FakePostgres();
        pg.rows.set("acct-1", pg.now - 60_000);
        pg.beginRound(["acct-1"]);
        wire(pg);

        const [claimed] = await claimDueNetworkFlowAccounts(2, ["aws"]);
        const lease = startNetworkFlowLease("acct-1", "org-1", claimed!.leaseOwner ?? null);

        // No checkpoint at all — this is the one query that runs long, with no
        // day boundary to hang a renewal off.
        pg.now += 5 * 60 * 1000;
        await vi.advanceTimersByTimeAsync(NETWORK_FLOW_HEARTBEAT_MS);
        expect(pg.rows.get("acct-1")).toBe(pg.now + NETWORK_FLOW_LEASE_MS);

        await lease.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    // The renewal is a compare-and-swap, and this is what the "compare" is for:
    // a blind `SET next_poll_at = now() + lease` from a replica that had already
    // lost the account would extend the *new* holder's lease on its behalf —
    // the same overlap, one layer down, and harder to see.
    it("refuses to renew for a replica that has already lost the lease", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000);
      pg.beginRound(["acct-1"]);
      wire(pg);

      const [first] = await claimDueNetworkFlowAccounts(2, ["aws"]);
      const stale = startNetworkFlowLease("acct-1", "org-1", first!.leaseOwner ?? null);

      // The first replica stalls long enough to lose the lease, and a second
      // one takes the account over.
      pg.now += NETWORK_FLOW_LEASE_MS + 1;
      pg.beginRound(["acct-1"]);
      const [second] = await claimDueNetworkFlowAccounts(2, ["aws"]);
      expect(second?.accountId).toBe("acct-1");

      const heldBySecond = pg.rows.get("acct-1");
      await expect(stale.checkpoint()).rejects.toBeInstanceOf(NetworkFlowLeaseLostError);
      expect(pg.rows.get("acct-1")).toBe(heldBySecond);
      await stale.stop();
    });

    // The heartbeat and a checkpoint can be renewing at the same moment, and
    // one write is enough. This used to be load-bearing rather than tidy: two
    // renewals issued from the same expected *deadline* had the second match
    // nothing and report a loss that never happened. Against the owner token
    // both would match, so what is pinned here is only that the two collapse
    // into one renewal and both callers are told the lease is held.
    it("coalesces concurrent renewals rather than issuing the same write twice", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000);
      pg.beginRound(["acct-1"]);
      wire(pg);

      const [claimed] = await claimDueNetworkFlowAccounts(2, ["aws"]);
      const lease = startNetworkFlowLease("acct-1", "org-1", claimed!.leaseOwner ?? null);

      // Move the clock on, so the renewal actually writes a different deadline
      // and a second one issued from the stale expected value would miss.
      pg.now += 60_000;
      await expect(Promise.all([lease.checkpoint(), lease.checkpoint()])).resolves.toEqual([
        true,
        true,
      ]);
      expect(pg.rows.get("acct-1")).toBe(pg.now + NETWORK_FLOW_LEASE_MS);
      await lease.stop();
    });

    // A lease is a lease, not a lock — renewing it must not turn it into one.
    it("still frees the account when the holder dies mid-collection", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000);
      pg.beginRound(["acct-1"]);
      wire(pg);

      const [claimed] = await claimDueNetworkFlowAccounts(2, ["aws"]);
      // The holder starts work and the pod is then killed: no checkpoint ever
      // runs, no heartbeat ever fires, nothing writes the row again.
      startNetworkFlowLease("acct-1", "org-1", claimed!.leaseOwner ?? null);

      pg.now += NETWORK_FLOW_LEASE_MS + 1;
      pg.beginRound(["acct-1"]);

      await expect(claimDueNetworkFlowAccounts(2, ["aws"])).resolves.toEqual([
        {
          accountId: "acct-1",
          organizationId: "org-1",
          failureCount: 0,
          leaseOwner: "lease-2",
        },
      ]);
      expect(pg.rows.get("acct-1")).toBe(pg.now + NETWORK_FLOW_LEASE_MS);
    });

    // The other half of the answer to an overrun: work that cannot be made to
    // fit stops at a day boundary rather than running on under a lease it is
    // renewing indefinitely.
    it("stops the collection once the pass has spent its runtime budget", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000);
      pg.beginRound(["acct-1"]);
      wire(pg);

      const [claimed] = await claimDueNetworkFlowAccounts(2, ["aws"]);
      const leased = pg.rows.get("acct-1");
      const lease = startNetworkFlowLease("acct-1", "org-1", claimed!.leaseOwner ?? null, {
        maxRuntimeMs: 0,
      });

      await expect(lease.checkpoint()).resolves.toBe(false);
      // Out of budget means "do not start another billable query", not "push
      // the lease out further" — the row is untouched.
      expect(pg.rows.get("acct-1")).toBe(leased);
      await lease.stop();
    });

    /*
     * Regression: the fence that keeps a *lost* holder from writing was also
     * blocking the legitimate one.
     *
     * A collection that finished while a heartbeat renewal was in flight had
     * `stop()` return without waiting, so the terminal update fenced on the
     * deadline from before that renewal. The renewal then landed, the fenced
     * update matched no row, and the reschedule to tomorrow was silently
     * dropped — leaving the account holding nothing but the renewed lease,
     * coming due again the moment it lapsed, and re-running the whole
     * customer-billed scan. Which is the exact failure the lease exists to
     * prevent, arrived at by way of the fix for it.
     *
     * The fence is the owner token now, so the write no longer depends on
     * having tracked that renewal; the draining is still what keeps the pass
     * from returning with a write of its own outstanding, and both halves are
     * pinned here.
     */
    it("lands its terminal write when the collection ends with a renewal in flight", async () => {
      vi.useFakeTimers();
      try {
        const pg = new FakePostgres();
        vi.setSystemTime(pg.now);
        const started = Date.now();
        pg.rows.set("acct-1", pg.now - 60_000);
        pg.beginRound(["acct-1"]);
        // The renewal reaches the row promptly and then takes a further minute
        // to answer — comfortably still outstanding when the collection ends.
        const control = wireWithRenewals(pg, { renewalDelayMs: 60_000 });

        collect.mockImplementation((async () => {
          // One provider call that outlives a heartbeat, with no day boundary
          // in it to hang a checkpoint off. Moving the fake's clock first means
          // the beat's renewal writes a deadline genuinely different from the
          // one the claim handed out, so a stale fence can be seen to miss.
          pg.now += 60_000;
          await new Promise((resolve) => setTimeout(resolve, NETWORK_FLOW_HEARTBEAT_MS + 1_000));
          return collected(1);
        }) as unknown as () => Promise<Record<string, unknown>>);

        const pass = runNetworkFlowPass();
        await vi.advanceTimersByTimeAsync(NETWORK_FLOW_HEARTBEAT_MS + 120_000);
        await expect(pass).resolves.toEqual({ claimed: 1 });

        // The reschedule landed, and handed the lease back with it.
        const write = control.passWrites.at(-1);
        expect(write).toMatchObject({ failureCount: 0, lastError: null, leaseOwner: null });
        expect(pg.owners.get("acct-1")).toBeNull();
        expect(pg.rows.get("acct-1")).toBe((write!["nextPollAt"] as Date).getTime());
        expect(pg.rows.get("acct-1")).toBeGreaterThan(started + NETWORK_FLOW_INTERVAL_MS);

        // And so the account is not claimable again when the renewed lease
        // would have lapsed, which is what re-ran the scan.
        pg.now = Date.now() + NETWORK_FLOW_LEASE_MS + 1;
        pg.beginRound(["acct-1"]);
        await expect(claimDueNetworkFlowAccounts(2, ["aws"])).resolves.toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    /*
     * Regression: a renewal that failed to *execute* was being read as a lost
     * lease.
     *
     * The heartbeat has always drawn the distinction — a connection blip leaves
     * the deadline in the row, still ours, so it retries on the next beat — and
     * `checkpoint` did not: the exception escaped into the pass, which could
     * only take it for an account failure and record one, with backoff, against
     * an account that had done nothing. The two conditions are told apart in
     * one place now; these two tests are the two sides of it.
     */
    it("rides out a renewal the database never answered, and keeps collecting", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000);
      pg.beginRound(["acct-1"]);
      const control = wireWithRenewals(pg, { failRenewals: 1 });
      const claimDeadline = pg.now + NETWORK_FLOW_LEASE_MS;

      // The deadline in the row as each day's checkpoint left it.
      const afterCheckpoint: (number | null | undefined)[] = [];
      collect.mockImplementation((async (
        _accountId: string,
        _organizationId: string,
        options: { lease?: { checkpoint(): Promise<boolean> } },
      ) => {
        for (let day = 0; day < 2; day += 1) {
          // Between the days, so the renewal that does land writes a visibly
          // different deadline from the one the claim wrote.
          if (day > 0) pg.now += 60_000;
          await options.lease?.checkpoint();
          afterCheckpoint.push(pg.rows.get("acct-1"));
        }
        return collected(2);
      }) as unknown as () => Promise<Record<string, unknown>>);

      await expect(runNetworkFlowPass()).resolves.toEqual({ claimed: 1 });

      // The blip cost nothing. Both days ran, the first under the deadline the
      // claim had already written — untouched, because the renewal that failed
      // never reached the row — and the second under a renewal that did land.
      expect(afterCheckpoint).toEqual([claimDeadline, pg.now + NETWORK_FLOW_LEASE_MS]);
      // And the pass recorded a success, not a failure with backoff against an
      // account that had done nothing wrong.
      expect(control.passWrites).toHaveLength(1);
      expect(control.passWrites[0]).toMatchObject({ failureCount: 0, lastError: null });
      expect(pg.rows.get("acct-1")).toBe((control.passWrites[0]!["nextPollAt"] as Date).getTime());
    });

    it("still stops dead, and writes nothing, when a renewal proves the lease is gone", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000);
      pg.beginRound(["acct-1"]);
      const control = wireWithRenewals(pg);

      let days = 0;
      let heldBySecond: number | null | undefined;
      let ownedBySecond: string | null | undefined;
      collect.mockImplementation((async (
        _accountId: string,
        _organizationId: string,
        options: { lease?: { checkpoint(): Promise<boolean> } },
      ) => {
        days += 1;
        // Between the claim and the next day's query this replica stalled long
        // enough to lose the lease, and a second one took the account over.
        pg.now += NETWORK_FLOW_LEASE_MS + 1;
        pg.beginRound(["acct-1"]);
        await claimDueNetworkFlowAccounts(2, ["aws"]);
        heldBySecond = pg.rows.get("acct-1");
        ownedBySecond = pg.owners.get("acct-1");
        await options.lease?.checkpoint();
        days += 1;
        return collected(2);
      }) as unknown as () => Promise<Record<string, unknown>>);

      await expect(runNetworkFlowPass()).resolves.toEqual({ claimed: 1 });

      // Stopped at the first checkpoint after the loss, and the new holder's
      // row is untouched: no reschedule, no failure, no lease pushed forward,
      // and its claim on the account not released on its behalf.
      expect(days).toBe(1);
      expect(control.passWrites).toEqual([]);
      expect(pg.rows.get("acct-1")).toBe(heldBySecond);
      expect(pg.owners.get("acct-1")).toBe(ownedBySecond);
    });

    /*
     * Regression: a renewal that committed and then lost its answer was read as
     * a lost lease.
     *
     * The two outcomes above are the two the holder can prove. This is the
     * third, and it is the reason the lease cannot be identified by its own
     * deadline: the write landed, the reply did not, and a holder that keeps
     * the deadline it had is now holding a value the row has stopped having.
     * Its next renewal matches nothing and reports a loss that never happened —
     * so the collection is abandoned with no terminal write, the committed
     * renewal lapses on schedule, and the account comes back due to re-run
     * every day it had already paid to collect.
     */
    it("carries on through a renewal that committed but never answered", async () => {
      const pg = new FakePostgres();
      pg.rows.set("acct-1", pg.now - 60_000);
      pg.beginRound(["acct-1"]);
      const control = wireWithRenewals(pg, { dropAnswers: 1 });
      const claimedAt = pg.now;

      // The deadline in the row as each day's checkpoint left it.
      const afterCheckpoint: (number | null | undefined)[] = [];
      collect.mockImplementation((async (
        _accountId: string,
        _organizationId: string,
        options: { lease?: { checkpoint(): Promise<boolean> } },
      ) => {
        for (let day = 0; day < 2; day += 1) {
          // Before each, so every renewal writes a visibly different deadline —
          // otherwise the dropped answer would be indistinguishable from a
          // renewal that never reached the row.
          pg.now += 60_000;
          await options.lease?.checkpoint();
          afterCheckpoint.push(pg.rows.get("acct-1"));
        }
        return collected(2);
      }) as unknown as () => Promise<Record<string, unknown>>);

      await expect(runNetworkFlowPass()).resolves.toEqual({ claimed: 1 });

      // Both days ran, and both renewals landed: the first one's *answer* was
      // lost, not its write, and the second was not thrown off by that.
      expect(afterCheckpoint).toEqual([
        claimedAt + 60_000 + NETWORK_FLOW_LEASE_MS,
        claimedAt + 120_000 + NETWORK_FLOW_LEASE_MS,
      ]);
      // And the pass finished: a success recorded, and tomorrow's schedule in
      // the row rather than a lease that is about to lapse.
      expect(control.passWrites).toHaveLength(1);
      expect(control.passWrites[0]).toMatchObject({ failureCount: 0, lastError: null });
      expect(pg.rows.get("acct-1")).toBe((control.passWrites[0]!["nextPollAt"] as Date).getTime());
    });
  });
});
