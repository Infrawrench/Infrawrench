/**
 * The rules that decide who gets a shell on somebody else's production box.
 *
 * These are the tests that matter in this feature. The fan-out, the letterbox
 * and the participant list are all recoverable if they are wrong; a bad answer
 * here is somebody typing into a machine they should not be able to reach. So
 * each case below is written as the question a reviewer would actually ask,
 * and the assertions are on the *reason* as well as the outcome — a join that
 * fails for the right reason and one that fails by accident are the same
 * `false` and very different code.
 */
import { describe, expect, it } from "vitest";

import {
  CONSOLE_PERMISSION,
  evaluateAttached,
  evaluateHandover,
  evaluateHandoverRequest,
  evaluateInput,
  evaluateJoin,
  evaluateOwnerAction,
  resolvePtySize,
  type ParticipantState,
  type SharedConsoleState,
} from "../shared-console/arbitration";

const NOW = new Date("2026-08-11T12:00:00Z");
const TOKEN_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function share(overrides: Partial<SharedConsoleState> = {}): SharedConsoleState {
  return {
    id: "share-1",
    organizationId: "org-1",
    status: "active",
    ownerUserId: "owner",
    allowHandover: true,
    inviteTokenHash: TOKEN_HASH,
    inviteExpiresAt: new Date(NOW.getTime() + 10 * 60_000),
    inviteConsumedAt: null,
    ...overrides,
  };
}

function participant(overrides: Partial<ParticipantState> = {}): ParticipantState {
  return { id: "p-1", userId: "guest", role: "observer", status: "joined", ...overrides };
}

const guest = { userId: "guest", organizationId: "org-1", permissions: [CONSOLE_PERMISSION] };
const owner = { userId: "owner", organizationId: "org-1", permissions: [CONSOLE_PERMISSION] };

describe("evaluateJoin — the invite is a locator, not a capability", () => {
  it("admits a member holding the terminal permission, as an observer", () => {
    const decision = evaluateJoin({
      share: share(),
      caller: guest,
      presentedTokenHash: TOKEN_HASH,
      existing: null,
      now: NOW,
    });
    expect(decision).toEqual({
      ok: true,
      rejoin: false,
      consumesInvite: true,
      // Never a driver on first admission, whatever the link said.
      role: "observer",
    });
  });

  it("refuses a perfectly valid token when the caller lacks the permission", () => {
    const decision = evaluateJoin({
      share: share(),
      caller: { ...guest, permissions: ["resources:read"] },
      presentedTokenHash: TOKEN_HASH,
      existing: null,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe("no-permission");
    expect(decision.status).toBe(403);
  });

  it("refuses somebody who is no longer in the org at all (empty permission set)", () => {
    const decision = evaluateJoin({
      share: share(),
      caller: { ...guest, permissions: [] },
      presentedTokenHash: TOKEN_HASH,
      existing: null,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("no-permission");
  });

  it("refuses a token from a different organization's share", () => {
    const decision = evaluateJoin({
      share: share({ organizationId: "org-2" }),
      caller: guest,
      presentedTokenHash: TOKEN_HASH,
      existing: null,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    // 404, not 403: confirming the share exists is itself information.
    if (!decision.ok) expect(decision.status).toBe(404);
  });

  it("checks the permission before the token, so a refusal does not grade the link", () => {
    const decision = evaluateJoin({
      share: share(),
      caller: { ...guest, permissions: [] },
      presentedTokenHash: OTHER_HASH,
      existing: null,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("no-permission");
  });

  it("refuses an expired invite", () => {
    const decision = evaluateJoin({
      share: share({ inviteExpiresAt: new Date(NOW.getTime() - 1000) }),
      caller: guest,
      presentedTokenHash: TOKEN_HASH,
      existing: null,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("invite-expired");
  });

  it("treats an invite expiring exactly now as expired", () => {
    const decision = evaluateJoin({
      share: share({ inviteExpiresAt: NOW }),
      caller: guest,
      presentedTokenHash: TOKEN_HASH,
      existing: null,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("invite-expired");
  });

  it("refuses a mismatched token", () => {
    const decision = evaluateJoin({
      share: share(),
      caller: guest,
      presentedTokenHash: OTHER_HASH,
      existing: null,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("invite-mismatch");
  });

  it("refuses a new person once the invite has been consumed", () => {
    const decision = evaluateJoin({
      share: share({ inviteTokenHash: null, inviteConsumedAt: NOW }),
      caller: guest,
      presentedTokenHash: TOKEN_HASH,
      existing: null,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("invite-consumed");
  });

  it("readmits somebody already on the console without a token, and without spending one", () => {
    const decision = evaluateJoin({
      share: share({ inviteTokenHash: null, inviteConsumedAt: NOW }),
      caller: guest,
      presentedTokenHash: null,
      existing: participant({ role: "driver" }),
      now: NOW,
    });
    expect(decision).toEqual({ ok: true, rejoin: true, consumesInvite: false, role: "driver" });
  });

  it("refuses somebody who was ejected, even with a fresh valid token", () => {
    const decision = evaluateJoin({
      share: share(),
      caller: guest,
      presentedTokenHash: TOKEN_HASH,
      existing: participant({ status: "removed" }),
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("removed");
  });

  it("refuses every join once the share is revoked", () => {
    for (const status of ["revoked", "ended"] as const) {
      const decision = evaluateJoin({
        share: share({ status }),
        caller: guest,
        presentedTokenHash: TOKEN_HASH,
        existing: participant(),
        now: NOW,
      });
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.reason).toBe("not-active");
    }
  });

  it("honours a wildcard permission grant", () => {
    expect(
      evaluateJoin({
        share: share(),
        caller: { ...guest, permissions: ["*"] },
        presentedTokenHash: TOKEN_HASH,
        existing: null,
        now: NOW,
      }).ok,
    ).toBe(true);
    expect(
      evaluateJoin({
        share: share(),
        caller: { ...guest, permissions: ["resources:*"] },
        presentedTokenHash: TOKEN_HASH,
        existing: null,
        now: NOW,
      }).ok,
    ).toBe(true);
  });
});

describe("evaluateInput — an observer's keystrokes never reach the host", () => {
  it("accepts the driver", () => {
    expect(evaluateInput({ share: share(), participant: participant({ role: "driver" }) })).toBe(
      true,
    );
  });

  it("rejects an observer", () => {
    expect(evaluateInput({ share: share(), participant: participant() })).toBe(false);
  });

  it("rejects a driver who has left, so a stale socket cannot type", () => {
    expect(
      evaluateInput({
        share: share(),
        participant: participant({ role: "driver", status: "left" }),
      }),
    ).toBe(false);
  });

  it("rejects a removed participant regardless of role", () => {
    expect(
      evaluateInput({
        share: share(),
        participant: participant({ role: "driver", status: "removed" }),
      }),
    ).toBe(false);
  });

  it("rejects everyone once the share is revoked, before any role is consulted", () => {
    expect(
      evaluateInput({
        share: share({ status: "revoked" }),
        participant: participant({ role: "driver" }),
      }),
    ).toBe(false);
  });

  it("rejects a socket with no participant row at all", () => {
    expect(evaluateInput({ share: share(), participant: null })).toBe(false);
  });
});

describe("evaluateHandover — who may move the keyboard", () => {
  const driver = participant({ id: "p-driver", userId: "owner", role: "driver" });
  const target = participant({ id: "p-guest", userId: "guest" });

  it("lets the current driver hand it over", () => {
    const decision = evaluateHandover({
      share: share(),
      actor: owner,
      actorParticipant: driver,
      target,
      currentDriver: driver,
    });
    expect(decision).toEqual({ ok: true, forced: false, demote: "p-driver", promote: "p-guest" });
  });

  it("lets the sharer take it back by force when somebody else is driving", () => {
    const other = participant({ id: "p-other", userId: "other", role: "driver" });
    const decision = evaluateHandover({
      share: share(),
      actor: owner,
      // The owner is on the console but is not the driver.
      actorParticipant: participant({ id: "p-owner", userId: "owner" }),
      target: participant({ id: "p-owner-target", userId: "guest" }),
      currentDriver: other,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.forced).toBe(true);
      expect(decision.demote).toBe("p-other");
    }
  });

  it("refuses an observer trying to promote themselves", () => {
    const observer = participant({ id: "p-guest", userId: "guest" });
    const decision = evaluateHandover({
      share: share(),
      actor: guest,
      actorParticipant: observer,
      target: observer,
      currentDriver: driver,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-driver");
  });

  it("refuses any handover on a read-only share", () => {
    const decision = evaluateHandover({
      share: share({ allowHandover: false }),
      actor: owner,
      actorParticipant: driver,
      target,
      currentDriver: driver,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("handover-disabled");
  });

  it("refuses handing the keyboard to somebody who has left", () => {
    const decision = evaluateHandover({
      share: share(),
      actor: owner,
      actorParticipant: driver,
      target: participant({ id: "p-gone", status: "left" }),
      currentDriver: driver,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-participant");
  });

  it("refuses handing it to whoever already has it", () => {
    const decision = evaluateHandover({
      share: share(),
      actor: owner,
      actorParticipant: driver,
      target: driver,
      currentDriver: driver,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("already-driver");
  });

  it("refuses an actor whose console permission was withdrawn mid-session", () => {
    const decision = evaluateHandover({
      share: share(),
      actor: { ...owner, permissions: [] },
      actorParticipant: driver,
      target,
      currentDriver: driver,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("no-permission");
  });

  /**
   * The race. Two grants are authorised against the same state — this function
   * is pure and says yes to both, which is correct: it decides *authority*.
   * Order is decided by the partial unique index in the database, and the
   * loser surfaces as a 409. This test exists to pin that division of labour,
   * because the tempting alternative (make this function "resolve" the race)
   * would be a lock that only works within one process, and there are two.
   */
  it("authorises two simultaneous grants and leaves the ordering to the database", () => {
    const a = evaluateHandover({
      share: share(),
      actor: owner,
      actorParticipant: driver,
      target: participant({ id: "p-a", userId: "a" }),
      currentDriver: driver,
    });
    const b = evaluateHandover({
      share: share(),
      actor: owner,
      actorParticipant: driver,
      target: participant({ id: "p-b", userId: "b" }),
      currentDriver: driver,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Both demote the same row, which is exactly why only one can commit.
    if (a.ok && b.ok) {
      expect(a.demote).toBe("p-driver");
      expect(b.demote).toBe("p-driver");
      expect(a.promote).not.toBe(b.promote);
    }
  });

  it("does not demote anybody when nobody is driving", () => {
    const decision = evaluateHandover({
      share: share(),
      actor: owner,
      actorParticipant: participant({ id: "p-owner", userId: "owner", role: "driver" }),
      target,
      currentDriver: null,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.demote).toBeNull();
  });
});

describe("evaluateHandoverRequest — asking is not taking", () => {
  it("lets an observer ask", () => {
    const decision = evaluateHandoverRequest({
      share: share(),
      actor: guest,
      actorParticipant: participant({ id: "p-guest" }),
    });
    expect(decision).toEqual({ ok: true, participantId: "p-guest" });
  });

  it("refuses somebody who is not on the console", () => {
    const decision = evaluateHandoverRequest({
      share: share(),
      actor: guest,
      actorParticipant: null,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-participant");
  });

  it("refuses on a read-only share, rather than raising a flag nobody can act on", () => {
    const decision = evaluateHandoverRequest({
      share: share({ allowHandover: false }),
      actor: guest,
      actorParticipant: participant(),
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("handover-disabled");
  });
});

describe("evaluateOwnerAction — revocation is not gated on still holding access", () => {
  it("lets the sharer act with no console permission at all", () => {
    const decision = evaluateOwnerAction({
      share: share(),
      actor: { userId: "owner", organizationId: "org-1", permissions: [] },
      isOrgAdmin: false,
    });
    expect(decision.ok).toBe(true);
  });

  it("lets an org administrator pull the plug on somebody else's share", () => {
    const decision = evaluateOwnerAction({
      share: share(),
      actor: { userId: "someone-else", organizationId: "org-1", permissions: [] },
      isOrgAdmin: true,
    });
    expect(decision.ok).toBe(true);
  });

  it("refuses an unrelated member", () => {
    const decision = evaluateOwnerAction({
      share: share(),
      actor: { userId: "nosy", organizationId: "org-1", permissions: [CONSOLE_PERMISSION] },
      isOrgAdmin: false,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-owner");
  });

  it("refuses across organizations even for an administrator", () => {
    const decision = evaluateOwnerAction({
      share: share({ organizationId: "org-2" }),
      actor: { userId: "owner", organizationId: "org-1", permissions: [] },
      isOrgAdmin: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(404);
  });

  it("still works when the share has no owner left (the user row was deleted)", () => {
    const decision = evaluateOwnerAction({
      share: share({ ownerUserId: null }),
      actor: { userId: "owner", organizationId: "org-1", permissions: [] },
      isOrgAdmin: false,
    });
    // Nobody is the owner of an ownerless share — only an admin can end it.
    expect(decision.ok).toBe(false);
  });
});

describe("evaluateAttached — authority is re-derived while somebody is attached", () => {
  it("keeps a participant who still holds the permission", () => {
    expect(
      evaluateAttached({
        share: share(),
        participant: participant(),
        permissions: [CONSOLE_PERMISSION],
      }),
    ).toEqual({ keep: true });
  });

  it("detaches a participant whose permission was withdrawn mid-session", () => {
    const verdict = evaluateAttached({
      share: share(),
      participant: participant({ role: "driver" }),
      permissions: ["resources:read"],
    });
    expect(verdict.keep).toBe(false);
    if (!verdict.keep) expect(verdict.reason).toBe("permission-lost");
  });

  it("detaches somebody removed from the org entirely", () => {
    const verdict = evaluateAttached({
      share: share(),
      participant: participant(),
      permissions: [],
    });
    expect(verdict.keep).toBe(false);
    if (!verdict.keep) expect(verdict.reason).toBe("permission-lost");
  });

  it("detaches everybody when the share is revoked, before looking at permissions", () => {
    const verdict = evaluateAttached({
      share: share({ status: "revoked" }),
      participant: participant(),
      permissions: ["*"],
    });
    expect(verdict.keep).toBe(false);
    if (!verdict.keep) expect(verdict.reason).toBe("share-revoked");
  });

  it("detaches an ejected participant whose socket is still open", () => {
    const verdict = evaluateAttached({
      share: share(),
      participant: participant({ status: "removed" }),
      permissions: [CONSOLE_PERMISSION],
    });
    expect(verdict.keep).toBe(false);
    if (!verdict.keep) expect(verdict.reason).toBe("removed");
  });
});

describe("resolvePtySize — one pty, one size, and it is the driver's", () => {
  it("uses the driver's viewport", () => {
    expect(resolvePtySize({ cols: 160, rows: 48 }, { cols: 80, rows: 24 })).toEqual({
      cols: 160,
      rows: 48,
    });
  });

  it("keeps the current size when the driver has not reported one", () => {
    expect(resolvePtySize(null, { cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(resolvePtySize({ cols: null, rows: null }, { cols: 120, rows: 40 })).toEqual({
      cols: 120,
      rows: 40,
    });
  });

  it("never produces a degenerate pty from a hidden or unmounted terminal", () => {
    // A terminal that is not laid out reports 0x0; passing that to setWindow
    // is how a shared session ends up with a shell nobody can read.
    expect(resolvePtySize({ cols: 0, rows: 0 }, { cols: 0, rows: 0 })).toEqual({
      cols: 80,
      rows: 24,
    });
  });

  it("clamps absurd values rather than trusting a client's number", () => {
    expect(resolvePtySize({ cols: 99999, rows: -5 }, { cols: 80, rows: 24 })).toEqual({
      cols: 1000,
      rows: 24,
    });
  });

  it("truncates fractional dimensions", () => {
    expect(resolvePtySize({ cols: 100.9, rows: 30.2 }, { cols: 80, rows: 24 })).toEqual({
      cols: 100,
      rows: 30,
    });
  });
});
