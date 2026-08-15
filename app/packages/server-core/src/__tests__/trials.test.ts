import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agent trial-org lifecycle: creation, the paid-without-a-card grant, the
 * reaper's due query, destruction ordering, and the two claim modes.
 *
 * The DB is a real Drizzle over the recording driver, so the assertions are
 * against the SQL these paths actually render rather than against a hand-shaped
 * mock. ClickHouse and WorkOS are the two stores destruction reaches outside
 * Postgres, and both are stubbed so ordering can be observed.
 */

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

// Typed with its argument so `mock.calls` carries it — an untyped `vi.fn()`
// gives back an empty tuple and every read of a call needs a cast.
interface ChCommand {
  query: string;
  query_params?: Record<string, string>;
}
const chCommand = vi.fn(async (_opts: ChCommand) => ({}));
let clickhouseConfigured = true;
vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => clickhouseConfigured,
  getClickHouseClient: () => ({ command: chCommand }),
}));

vi.mock("../permissions/resolver", () => ({
  ensureSystemRoles: vi.fn(async () => undefined),
  getSystemRole: vi.fn(async () => ({ id: "role-owner" })),
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

beforeEach(async () => {
  pg.reset();
  chCommand.mockClear();
  clickhouseConfigured = true;
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
  it("purges every org-scoped ClickHouse table before deleting the org row", async () => {
    await destroy.destroyOrganization("org-doomed");

    expect(chCommand).toHaveBeenCalledTimes(destroy.ORG_SCOPED_CLICKHOUSE_TABLES.length);
    for (const table of destroy.ORG_SCOPED_CLICKHOUSE_TABLES) {
      expect(
        chCommand.mock.calls.some(([arg]) => arg.query.includes(`ALTER TABLE ${table} DELETE`)),
      ).toBe(true);
    }
    expect(deletes("organizations")).toHaveLength(1);
  });

  it("parameterises the org id rather than interpolating it", async () => {
    await destroy.destroyOrganization("org'; drop table --");
    for (const [{ query, query_params }] of chCommand.mock.calls) {
      expect(query).not.toContain("drop table");
      expect(query_params?.["organizationId"]).toBe("org'; drop table --");
    }
  });

  it("leaves Postgres untouched when the ClickHouse purge throws", async () => {
    chCommand.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(destroy.destroyOrganization("org-doomed")).rejects.toThrow("clickhouse down");
    // The org survives to be retried next tick — half-deleted state across
    // three stores is the outcome the ordering exists to prevent.
    expect(deletes("organizations")).toHaveLength(0);
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

  it("skips ClickHouse entirely when it isn't configured", async () => {
    clickhouseConfigured = false;
    const result = await destroy.destroyOrganization("org-doomed");
    expect(chCommand).not.toHaveBeenCalled();
    expect(result.clickhouseTablesPurged).toEqual([]);
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

  /** One destroyed org's statement tail: lock, guard re-check, then the stores. */
  function queueGuardedDestroy(guardRow: { trialExpiresAt: Date | null; claimedAt: Date | null }) {
    pg.queueRows([]); // pg_advisory_xact_lock
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
    chCommand.mockRejectedValueOnce(new Error("clickhouse down")); // org-a dies here
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
    expect(chCommand).not.toHaveBeenCalled();
    expect(deletes("organizations")).toHaveLength(0);
  });

  it("backs a persistently failing org off instead of retrying it every tick", async () => {
    pg.queueRows([{ id: "org-a", displayName: "A" }]);
    queueGuardedDestroy({ trialExpiresAt: expired, claimedAt: null });
    chCommand.mockRejectedValueOnce(new Error("clickhouse down"));
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
    lastSeenAt: null,
    revokedAt: null,
    createdAt: new Date(),
  };

  /** The claim's entry statements: the org lookup, the lock, the locked re-read. */
  function queueClaimPreamble(row: Record<string, unknown> = registration) {
    pg.queueRows([{ organizationId: row["organizationId"] }]); // which org to lock
    pg.queueRows([]); // pg_advisory_xact_lock
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
    pg.queueRows([]); // pg_advisory_xact_lock — held by the reaper until the org was gone
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
      // Default merge purges the trial's ClickHouse rows with the org.
      expect(chCommand.mock.calls.some(([a]) => a.query.includes("DELETE"))).toBe(true);
    });

    it("re-parents ClickHouse history when asked, and then does not purge it", async () => {
      queueMergePreamble();
      const result = await claim.claimTrialOrg({
        registrationId: "reg_1",
        userId: "user-1",
        mode: "merge",
        targetOrganizationId: "org-target",
        moveHistory: true,
      });

      expect(result.historyMoved).toBe(true);
      const queries = chCommand.mock.calls.map(([a]) => a.query);
      expect(queries.every((q) => q.includes("UPDATE organization_id"))).toBe(true);
      // The delete is not issued at all — skipping it is what removes the
      // dependence on ClickHouse mutation ordering.
      expect(queries.some((q) => q.includes("DELETE"))).toBe(false);
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
