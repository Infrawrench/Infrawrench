import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agent trial-org lifecycle: creation, the paid-without-a-card grant, the
 * reaper's due query, destruction ordering, and the two claim modes.
 *
 * The DB is a real Drizzle over the recording driver, so the assertions are
 * against the SQL these paths actually render rather than against a hand-shaped
 * mock. WorkOS is the one store destruction reaches outside Postgres, and it is
 * stubbed so ordering can be observed.
 */

import { getTableConfig } from "drizzle-orm/pg-core";
import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

vi.mock("../permissions/resolver", () => ({
  ensureSystemRoles: vi.fn(async () => undefined),
  getSystemRole: vi.fn(async () => ({ id: "role-owner" })),
  resolveEffectivePermissions: vi.fn(async () => ({
    permissions: ["accounts:write", "costs:write"],
    role: null,
    elevations: [],
  })),
}));

// The trial-org lock owns a dedicated connection pool of its own (see
// `trials/lock.ts`), which is exactly what must not be reached from a suite
// running against the recording driver. Mutual exclusion is not what these
// tests are about; the statements issued inside the section are.
vi.mock("../trials/lock", () => ({
  withTrialOrgLock: async (_organizationId: string, fn: () => Promise<unknown>) => await fn(),
  closeTrialOrgLockPool: async () => undefined,
}));

let create: typeof import("../trials/create");
let destroy: typeof import("../trials/destroy");
let pass: typeof import("../trials/pass");
let claim: typeof import("../trials/claim");
let principal: typeof import("../trials/principal");
let entitlements: typeof import("../entitlements");

const inserts = (table: string) =>
  pg.queries.filter((q) => q.sql.startsWith(`insert into "${table}"`));
const updates = (table: string) => pg.queries.filter((q) => q.sql.startsWith(`update "${table}"`));
const deletes = (table: string) =>
  pg.queries.filter((q) => q.sql.startsWith(`delete from "${table}"`));

/** Every analytics table name, in the order the purge and the move walk them. */
const analyticsTables = () =>
  destroy.ORG_SCOPED_ANALYTICS_TABLES.map((table) => getTableConfig(table).name);

/**
 * Run with `db.transaction` recording which statements it wrapped, as
 * `[first, end)` indices into `pg.queries`. The fake runs a transaction flat,
 * so this is what lets a test say "these statements share one transaction".
 */
function recordTransactions(): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  vi.spyOn(pg.db, "transaction").mockImplementation((async (
    fn: (tx: typeof pg.db) => Promise<unknown>,
  ) => {
    const first = pg.queries.length;
    try {
      return await fn(pg.db);
    } finally {
      ranges.push([first, pg.queries.length]);
    }
  }) as never);
  return ranges;
}

beforeEach(async () => {
  pg.reset();
  process.env["WORKOS_API_KEY"] = "sk_test";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, text: async () => "" })),
  );
  vi.resetModules();
  create = await import("../trials/create");
  destroy = await import("../trials/destroy");
  pass = await import("../trials/pass");
  claim = await import("../trials/claim");
  principal = await import("../trials/principal");
  entitlements = await import("../entitlements");
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["WORKOS_API_KEY"];
});

describe("createTrialOrg", () => {
  const now = new Date("2026-08-14T10:00:00Z");

  it("sets a 24-hour expiry and a zero AI budget", async () => {
    const result = await create.createTrialOrg({ registrationId: "reg_1", now });

    expect(result.trialExpiresAt.getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000);

    const [orgInsert] = inserts("organizations");
    expect(orgInsert).toBeDefined();
    // Zero, not null and not a small allowance: a trial must not be able to
    // spend our inference budget at all.
    expect(orgInsert?.params).toContain(0);
  });

  it("gives the agent its own user row and membership", async () => {
    await create.createTrialOrg({ registrationId: "reg_1", now });

    const [userInsert] = inserts("users");
    // Prefixed so it can never collide with a WorkOS user id, and addressed at
    // a domain reserved by RFC 2606 so it can never receive mail.
    expect(userInsert?.params).toContain("agent_reg_1");
    expect(userInsert?.params).toContain("reg_1@agent.invalid");
    expect(inserts("organization_members")).toHaveLength(1);
  });

  it("derives the agent user id from the registration, not at random", async () => {
    // Retrying a partially-failed registration must land on the same identity.
    expect(create.agentUserId("reg_x")).toBe("agent_reg_x");
    expect(create.agentUserEmail("reg_x")).toBe("reg_x@agent.invalid");
  });

  it("binds the registration to the org it opened", async () => {
    await create.createTrialOrg({ registrationId: "reg_abc", label: "demo", now });
    const [reg] = inserts("agent_auth_registrations");
    expect(reg?.params).toContain("reg_abc");
  });
});

describe("planAccess", () => {
  it("grants the paid plan while an unclaimed trial is still running", async () => {
    pg.queueRows([{ complimentary: false, trialExpiresAt: new Date(Date.now() + 60_000) }]);
    const access = await entitlements.planAccess("org1");
    expect(access.paid).toBe(true);
    expect(access.reason).toBe("trial");
    expect(access.trialExpiresAt).toBeInstanceOf(Date);
  });

  it("does not keep granting it after expiry, even before the reaper runs", async () => {
    // An expired-but-not-yet-swept org must fall through to the normal answer,
    // or a failing reaper would silently extend free paid access indefinitely.
    // Only the org lookup is queued; every later select falls to the empty
    // default, which is "no subscription, no capacity slot".
    pg.queueRows([{ complimentary: false, trialExpiresAt: new Date(Date.now() - 60_000) }]);
    const access = await entitlements.planAccess("org1");
    expect(access.paid).toBe(false);
    expect(access.reason).toBe("none");
  });
});

describe("destroyOrganization", () => {
  /** The statements before the purge: the registration read, then the org delete. */
  function queueDeletedOrg(id = "org-doomed") {
    pg.queueRows([]); // surviving registrations
    pg.queueRows([{ id }]); // the org delete's returning row
  }

  it("purges every analytics table in the transaction that deletes the org row", async () => {
    const transactions = recordTransactions();
    queueDeletedOrg();
    const result = await destroy.destroyOrganization("org-doomed");

    expect(result.analyticsTablesPurged).toEqual(analyticsTables());
    const [orgDelete] = deletes("organizations");
    expect(orgDelete).toBeDefined();
    // The analytics tables carry no foreign key, so the cascade never reaches
    // them: each needs its own delete, and all of them have to commit or roll
    // back with the org row or a failure leaves half an org behind.
    const [range] = transactions;
    expect(range).toBeDefined();
    const inside = pg.queries.slice(range![0], range![1]);
    expect(inside[0]).toBe(orgDelete);
    for (const table of analyticsTables()) {
      const [purge] = deletes(table);
      expect(purge, table).toBeDefined();
      expect(inside).toContain(purge);
    }
  });

  it("parameterises the org id rather than interpolating it", async () => {
    queueDeletedOrg("org'; drop table --");
    await destroy.destroyOrganization("org'; drop table --");
    for (const table of analyticsTables()) {
      const [purge] = deletes(table);
      expect(purge?.sql).not.toContain("drop table");
      expect(purge?.params).toEqual(["org'; drop table --"]);
    }
  });

  it("purges nothing when the org row's delete matched nothing", async () => {
    // A concurrent sweep already deleted it (and its history, in the same
    // transaction), or the reaper's guard declined: either way the analytics
    // rows must be left exactly as they are.
    pg.queueRows([]); // surviving registrations
    pg.queueRows([]); // the org delete matched no row
    const result = await destroy.destroyOrganization("org-doomed");

    expect(result.deleted).toBe(false);
    expect(result.analyticsTablesPurged).toEqual([]);
    for (const table of analyticsTables()) expect(deletes(table)).toHaveLength(0);
  });

  it("removes the agent user rows the cascade cannot reach", async () => {
    // The registration read is the only select on this path; its rows become
    // the agent user ids to remove.
    pg.setRows([{ id: "reg_1" }]);
    const result = await destroy.destroyOrganization("org-doomed");

    expect(result.agentUsersDeleted).toBeGreaterThan(0);
    const [userDelete] = deletes("users");
    // `users` is not org-scoped, so without this every expired trial would
    // leave an orphan row behind permanently.
    expect(userDelete?.params).toContain("agent_reg_1");
  });

  it("treats a WorkOS 404 as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, text: async () => "not found" })),
    );
    const result = await destroy.destroyOrganization("org-doomed");
    expect(result.workosDeleted).toBe(true);
  });

  it("aborts before deleting the org row when WorkOS refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })),
    );
    await expect(destroy.destroyOrganization("org-doomed")).rejects.toThrow(/500/);
    expect(deletes("organizations")).toHaveLength(0);
  });
});

describe("runTrialExpiryPass", () => {
  const now = new Date("2026-08-14T10:00:00Z");
  const expired = new Date("2026-08-14T09:00:00Z");

  /** One destroyed org's statement tail: the guard re-check, then the stores. */
  function queueGuardedDestroy(guardRow: { trialExpiresAt: Date | null; claimedAt: Date | null }) {
    pg.queueRows([guardRow]); // the under-lock re-check
  }

  it("asks only for unclaimed trials whose clock has run out", async () => {
    pg.setRows([]);
    await pass.runTrialExpiryPass({ now });

    const [select] = pg.queries.filter((q) => q.sql.startsWith("select"));
    expect(select?.sql).toContain('"trial_expires_at" is not null');
    expect(select?.sql).toContain('"claimed_at" is null');
  });

  it("keeps going after one org fails to destroy", async () => {
    pg.queueRows([
      { id: "org-a", displayName: "A" },
      { id: "org-b", displayName: "B" },
    ]);
    queueGuardedDestroy({ trialExpiresAt: expired, claimedAt: null });
    pg.queueRows([]); // org-a: surviving registrations
    pg.queueRows([null as never]); // org-a dies here: its delete fails
    queueGuardedDestroy({ trialExpiresAt: expired, claimedAt: null });
    pg.queueRows([]); // org-b: surviving registrations
    pg.queueRows([{ id: "org-b" }]); // org-b: the delete's returning row

    const result = await pass.runTrialExpiryPass({ now });
    expect(result.due).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.destroyed).toBe(1);
  });

  it("skips an org claimed between the due query and the destroy", async () => {
    pg.queueRows([{ id: "org-a", displayName: "A" }]);
    // The under-lock re-check sees the claim that landed in the window.
    queueGuardedDestroy({ trialExpiresAt: null, claimedAt: new Date("2026-08-14T09:59:59Z") });

    const result = await pass.runTrialExpiryPass({ now });
    expect(result.destroyed).toBe(0);
    expect(result.failed).toBe(0);
    // Nothing irreversible happened: no purge was issued and no row deleted.
    for (const table of analyticsTables()) expect(deletes(table)).toHaveLength(0);
    expect(deletes("organizations")).toHaveLength(0);
  });

  it("backs a persistently failing org off instead of retrying it every tick", async () => {
    pg.queueRows([{ id: "org-a", displayName: "A" }]);
    queueGuardedDestroy({ trialExpiresAt: expired, claimedAt: null });
    pg.queueRows([]); // surviving registrations
    pg.queueRows([null as never]); // the delete fails
    await pass.runTrialExpiryPass({ now });

    // Same tick clock: the org is due in the table but sitting out its backoff,
    // so the slot it occupied is free for the trials queued behind it.
    pg.queueRows([{ id: "org-a", displayName: "A" }]);
    const second = await pass.runTrialExpiryPass({ now });
    expect(second.due).toBe(0);
  });
});

describe("resolveAgentPrincipal", () => {
  const unclaimed = {
    organizationId: "org-trial",
    claimedByUserId: null,
    claimedAt: null,
    revokedAt: null,
    trialExpiresAt: new Date(Date.now() + 3_600_000),
  };

  it("returns null for an unknown registration", async () => {
    pg.queueRows([]);
    expect(await principal.resolveAgentPrincipal("reg_nope")).toBeNull();
  });

  it("returns null for a revoked registration, ending access before the token expires", async () => {
    pg.queueRows([{ ...unclaimed, revokedAt: new Date() }]);
    expect(await principal.resolveAgentPrincipal("reg_1")).toBeNull();
  });

  it("acts as the agent's own user, never the registration id", async () => {
    pg.queueRows([unclaimed]);
    const p = await principal.resolveAgentPrincipal("reg_1");
    // The whole hazard this module exists for: `sub` is not a user id.
    expect(p?.userId).toBe("agent_reg_1");
    expect(p?.userId).not.toBe("reg_1");
  });

  it("withholds credential minting, billing and org deletion even unclaimed", async () => {
    pg.queueRows([unclaimed]);
    const p = await principal.resolveAgentPrincipal("reg_1");
    for (const denied of principal.AGENT_DENIED_PERMISSIONS) {
      expect(p?.permissions).not.toContain(denied);
    }
  });

  it("withholds team:invite until a real user has claimed it", async () => {
    pg.queueRows([unclaimed]);
    const preClaim = await principal.resolveAgentPrincipal("reg_1");
    // An anonymous registration that can invite is a mail relay with nobody
    // accountable behind it.
    expect(preClaim?.permissions).not.toContain("team:invite");
    expect(preClaim?.claimed).toBe(false);
  });

  it("still grants the product surface pre-claim", async () => {
    pg.queueRows([unclaimed]);
    const p = await principal.resolveAgentPrincipal("reg_1");
    expect(p?.permissions).toContain("accounts:write");
    expect(p?.permissions).toContain("resources:read");
  });

  it("reports time remaining so the agent can warn before the org is destroyed", async () => {
    pg.queueRows([unclaimed]);
    const p = await principal.resolveAgentPrincipal("reg_1");
    expect(p?.trialExpiresInMs).toBeGreaterThan(0);
  });
});

describe("claimTrialOrg", () => {
  // Keys in schema-declaration order: the fake driver decodes a `select()` with
  // no projection positionally, exactly as the real one does in raw mode, so a
  // fixture whose keys drift from the table silently reads the wrong column.
  const registration = {
    id: "reg_1",
    organizationId: "org-trial",
    claimedByUserId: null,
    claimedAt: null,
    kind: "anonymous",
    label: null,
    hashedCredential: null,
    credentialPrefix: null,
    hashedClaimCode: null,
    claimCodeExpiresAt: null,
    createdFromIp: null,
    linkId: null,
    externalId: null,
    scopes: null,
    providers: null,
    lastSeenAt: null,
    revokedAt: null,
    createdAt: new Date(),
  };

  /** The claim's entry statements: the org lookup, then the locked re-read. */
  function queueClaimPreamble(row: Record<string, unknown> = registration) {
    pg.queueRows([{ organizationId: row["organizationId"] }]); // which org to lock
    pg.queueRows([row]); // the re-read under the lock
  }

  it("adopting clears the expiry and makes the claimer owner", async () => {
    queueClaimPreamble();
    const result = await claim.claimTrialOrg({
      registrationId: "reg_1",
      userId: "user-1",
      mode: "adopt",
    });

    expect(result.mode).toBe("adopt");
    expect(result.organizationId).toBe("org-trial");
    // The clock is cleared, not merely ignored.
    expect(updates("organizations")[0]?.sql).toContain('"trial_expires_at"');
    expect(inserts("organization_members")).toHaveLength(1);
    // Nothing is destroyed on an adopt.
    expect(deletes("organizations")).toHaveLength(0);
  });

  it("adopting leaves the claimer as the only owner-shaped member", async () => {
    queueClaimPreamble();
    await claim.claimTrialOrg({ registrationId: "reg_1", userId: "user-1", mode: "adopt" });

    // The agent's membership is forced down to member. Left an owner, it would
    // satisfy the last-owner guard and let the sole human owner remove
    // themselves, stranding the tenant with nobody who can administer it.
    const demote = updates("organization_members")[0];
    expect(demote).toBeDefined();
    expect(demote?.params).toContain("agent_reg_1");
    expect(demote?.params).toContain("member");
  });

  it("refuses a second claim of the same registration", async () => {
    queueClaimPreamble({ ...registration, claimedAt: new Date() });
    await expect(
      claim.claimTrialOrg({ registrationId: "reg_1", userId: "user-1", mode: "adopt" }),
    ).rejects.toThrow(/already been claimed/);
  });

  it("refuses a revoked registration", async () => {
    queueClaimPreamble({ ...registration, revokedAt: new Date() });
    await expect(
      claim.claimTrialOrg({ registrationId: "reg_1", userId: "user-1", mode: "adopt" }),
    ).rejects.toThrow(/revoked/);
  });

  it("reports the honest outcome when the reaper won the race for the org", async () => {
    pg.queueRows([{ organizationId: "org-trial" }]); // the unlocked lookup still saw it
    pg.queueRows([]); // the re-read under the lock: cascaded away
    await expect(
      claim.claimTrialOrg({ registrationId: "reg_1", userId: "user-1", mode: "adopt" }),
    ).rejects.toThrow(/expired and has been deleted/);
    // Nothing was claimed against rows that no longer exist.
    expect(updates("agent_auth_registrations")).toHaveLength(0);
  });

  it("refuses a merge into an org the claimer does not belong to", async () => {
    // Only the preamble is queued; the membership lookup falls to the
    // empty default, which is what "not a member" looks like.
    queueClaimPreamble();
    await expect(
      claim.claimTrialOrg({
        registrationId: "reg_1",
        userId: "user-1",
        mode: "merge",
        targetOrganizationId: "org-someone-else",
      }),
    ).rejects.toThrow(/not a member/);
  });

  it("refuses a merge with no target", async () => {
    queueClaimPreamble();
    await expect(
      claim.claimTrialOrg({ registrationId: "reg_1", userId: "user-1", mode: "merge" }),
    ).rejects.toThrow(/needs a target/);
  });

  describe("merge", () => {
    /** Preamble → membership → accounts → planAccess(paid) → … */
    function queueMergePreamble() {
      queueClaimPreamble();
      pg.queueRows([{ id: "member-1" }]); // claimer's membership in the target
      pg.queueRows([{ id: "acct-1" }]); // accounts to move
      pg.queueRows([{ complimentary: true, trialExpiresAt: null }]); // target is paid
    }

    it("moves accounts and leaves history behind by default", async () => {
      queueMergePreamble();
      const result = await claim.claimTrialOrg({
        registrationId: "reg_1",
        userId: "user-1",
        mode: "merge",
        targetOrganizationId: "org-target",
      });

      expect(result.accountsMoved).toBe(1);
      expect(result.historyMoved).toBe(false);
      // Nothing is re-parented, so the destroy's purge takes the trial's
      // analytics rows with the org.
      for (const table of analyticsTables()) expect(updates(table)).toHaveLength(0);
      expect(deletes("organizations")).toHaveLength(1);
    });

    it("re-parents analytics history when asked, before the destroy purges the trial", async () => {
      const transactions = recordTransactions();
      queueMergePreamble();
      const result = await claim.claimTrialOrg({
        registrationId: "reg_1",
        userId: "user-1",
        mode: "merge",
        targetOrganizationId: "org-target",
        moveHistory: true,
      });

      expect(result.historyMoved).toBe(true);
      // The move is its own transaction, committed before the destroy starts,
      // so the purge that follows finds none of the trial's rows left.
      const [move] = transactions;
      expect(move).toBeDefined();
      const inside = pg.queries.slice(move![0], move![1]);
      for (const table of analyticsTables()) {
        const [update] = updates(table);
        expect(update, table).toBeDefined();
        expect(inside).toContain(update);
        expect(update?.params).toEqual(["org-target", "org-trial"]);
      }
      expect(deletes("organizations").every((q) => pg.queries.indexOf(q) >= move![1])).toBe(true);
    });

    it("drops a trial row whose key the target already holds instead of colliding", async () => {
      queueMergePreamble();
      await claim.claimTrialOrg({
        registrationId: "reg_1",
        userId: "user-1",
        mode: "merge",
        targetOrganizationId: "org-target",
        moveHistory: true,
      });

      // An account connected to both orgs was polled by both, so re-parenting
      // would hit the primary key on exactly those rows. Every keyed table gets
      // the dedupe first; an unkeyed append-only one has nothing to collide.
      const dedupes = pg.queries.filter((q) => q.sql.startsWith("DELETE FROM"));
      for (const table of ["metric_points_raw", "cost_daily", "network_flow_daily"]) {
        const dedupe = dedupes.find((q) => q.sql.startsWith(`DELETE FROM "${table}" AS moving`));
        expect(dedupe, table).toBeDefined();
        expect(dedupe?.params).toEqual(["org-trial", "org-target"]);
        expect(pg.queries.indexOf(dedupe!)).toBeLessThan(pg.queries.indexOf(updates(table)[0]!));
      }
      expect(dedupes.some((q) => q.sql.includes('"dashboard_stats"'))).toBe(false);
    });

    it("moves the agent's membership into the target as a member, not an owner", async () => {
      queueMergePreamble();
      await claim.claimTrialOrg({
        registrationId: "reg_1",
        userId: "user-1",
        mode: "merge",
        targetOrganizationId: "org-target",
      });

      const [memberInsert] = inserts("organization_members");
      expect(memberInsert?.params).toContain("agent_reg_1");
      expect(memberInsert?.params).toContain("member");
      expect(memberInsert?.params).not.toContain("owner");
    });

    it("refuses a claimer who cannot write accounts in the target", async () => {
      const resolver = await import("../permissions/resolver");
      vi.mocked(resolver.resolveEffectivePermissions).mockResolvedValueOnce({
        permissions: ["accounts:read"],
        role: null,
        elevations: [],
      });
      queueClaimPreamble();
      pg.queueRows([{ id: "member-1" }]); // they ARE a member of the target

      // Membership is not authorization: without this gate the ceremony is a
      // way for a read-only member to put cloud credentials into an org that
      // refuses them POST /accounts.
      await expect(
        claim.claimTrialOrg({
          registrationId: "reg_1",
          userId: "user-1",
          mode: "merge",
          targetOrganizationId: "org-target",
        }),
      ).rejects.toThrow(/do not have permission/);
      expect(updates("accounts")).toHaveLength(0);
    });

    it("refuses moving history without costs:write, even with accounts:write", async () => {
      const resolver = await import("../permissions/resolver");
      vi.mocked(resolver.resolveEffectivePermissions).mockResolvedValueOnce({
        permissions: ["accounts:write"],
        role: null,
        elevations: [],
      });
      queueClaimPreamble();
      pg.queueRows([{ id: "member-1" }]);

      // Splicing a day of foreign cost history into charts the org reports on
      // is the authority POST /costs/rows asks for, not the account write.
      await expect(
        claim.claimTrialOrg({
          registrationId: "reg_1",
          userId: "user-1",
          mode: "merge",
          targetOrganizationId: "org-target",
          moveHistory: true,
        }),
      ).rejects.toThrow(/costs:write/);
      for (const table of analyticsTables()) expect(updates(table)).toHaveLength(0);
    });

    it("refuses when the merge would put a free target over its account limit", async () => {
      queueClaimPreamble();
      pg.queueRows([{ id: "member-1" }]);
      pg.queueRows([{ id: "a" }, { id: "b" }]); // two accounts moving
      pg.queueRows([{ complimentary: false, trialExpiresAt: null }]); // target unpaid
      pg.queueRows([]); // no subscriptions
      pg.queueRows([]); // no capacity slots
      pg.queueRows([{ count: 3 }]); // target already at the free limit

      await expect(
        claim.claimTrialOrg({
          registrationId: "reg_1",
          userId: "user-1",
          mode: "merge",
          targetOrganizationId: "org-target",
        }),
      ).rejects.toThrow(/free plan's limit/);
      // Nothing moved: the check is against the post-merge total, before the
      // update, so a refusal leaves both orgs exactly as they were.
      expect(updates("accounts")).toHaveLength(0);
    });
  });
});
