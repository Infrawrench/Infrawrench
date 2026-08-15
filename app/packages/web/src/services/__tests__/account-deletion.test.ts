import { describe, it, expect } from "vitest";
import { classifyMemberships, type MembershipRow } from "../account-deletion-plan";
import { isOwnerRole } from "../org-roles";

/**
 * What deleting an account does to each organization the user is in. The
 * cascade on `organization_members.user_id` is unconditional, so this
 * classification is the only thing standing between a deletion and an
 * ownerless — or memberless — organization with a live subscription.
 */

const ME = "user_me";

function member(
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member" | null,
  opts: { legacy?: boolean; name?: string } = {},
): MembershipRow {
  return {
    organizationId,
    organizationName: opts.name ?? organizationId,
    userId,
    // A row either carries a `roles.systemKey` (current) or falls back to the
    // legacy text column — never both, which is what `isOwnerRole` encodes.
    legacyRole: opts.legacy ? role : null,
    systemKey: opts.legacy ? null : role,
  };
}

describe("classifyMemberships", () => {
  it("deletes an organization whose only other member is an agent", () => {
    // A claimed trial keeps the agent's `organization_members` row. Counting it
    // as a person turns "you are alone in here" into "you solely own a shared
    // organization" and refuses the deletion over a principal that cannot own
    // anything — and that the user has no obvious way to remove.
    const rows = [
      member("org_claimed", ME, "owner"),
      member("org_claimed", "agent_reg-1", "member"),
    ];
    const plan = classifyMemberships(rows, ["org_claimed"], ME);

    expect(plan.organizationIdsToDelete).toEqual(["org_claimed"]);
    expect(plan.blockers).toEqual([]);
  });

  it("deletes an organization the user is the only member of", () => {
    const rows = [member("org_solo", ME, "owner")];
    const plan = classifyMemberships(rows, ["org_solo"], ME);

    expect(plan.organizationIdsToDelete).toEqual(["org_solo"]);
    expect(plan.organizationIdsToLeave).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it("blocks when the user is the only owner and others are in it", () => {
    const rows = [
      member("org_team", ME, "owner", { name: "Acme" }),
      member("org_team", "user_b", "admin"),
      member("org_team", "user_c", "member"),
    ];
    const plan = classifyMemberships(rows, ["org_team"], ME);

    expect(plan.blockers).toEqual([{ id: "org_team", name: "Acme", memberCount: 3 }]);
    expect(plan.organizationIdsToDelete).toEqual([]);
    expect(plan.organizationIdsToLeave).toEqual([]);
  });

  it("lets the user leave when another owner remains", () => {
    const rows = [
      member("org_team", ME, "owner"),
      member("org_team", "user_b", "owner"),
      member("org_team", "user_c", "member"),
    ];
    const plan = classifyMemberships(rows, ["org_team"], ME);

    expect(plan.organizationIdsToLeave).toEqual(["org_team"]);
    expect(plan.blockers).toEqual([]);
  });

  it("lets a non-owner leave regardless of how many owners there are", () => {
    const rows = [member("org_team", ME, "member"), member("org_team", "user_b", "owner")];
    const plan = classifyMemberships(rows, ["org_team"], ME);

    expect(plan.organizationIdsToLeave).toEqual(["org_team"]);
    expect(plan.blockers).toEqual([]);
  });

  it("counts legacy text-column owners, so a pre-roles org still blocks", () => {
    const rows = [
      member("org_team", ME, "owner", { legacy: true }),
      member("org_team", "user_b", "member", { legacy: true }),
    ];
    const plan = classifyMemberships(rows, ["org_team"], ME);

    expect(plan.blockers).toHaveLength(1);
  });

  it("prefers systemKey over the legacy column when both are present", () => {
    // A row demoted to member in `roles` but never cleaned up in the text
    // column must not be counted as the surviving owner.
    const demoted: MembershipRow = {
      organizationId: "org_team",
      organizationName: "Acme",
      userId: "user_b",
      legacyRole: "owner",
      systemKey: "member",
    };
    const plan = classifyMemberships([member("org_team", ME, "owner"), demoted], ["org_team"], ME);

    expect(plan.blockers).toHaveLength(1);
  });

  it("classifies a mix of organizations independently", () => {
    const rows = [
      member("org_solo", ME, "owner"),
      member("org_shared", ME, "owner"),
      member("org_shared", "user_b", "member"),
      member("org_guest", ME, "member"),
      member("org_guest", "user_b", "owner"),
    ];
    const plan = classifyMemberships(rows, ["org_solo", "org_shared", "org_guest"], ME);

    expect(plan.organizationIdsToDelete).toEqual(["org_solo"]);
    expect(plan.blockers.map((b) => b.id)).toEqual(["org_shared"]);
    expect(plan.organizationIdsToLeave).toEqual(["org_guest"]);
  });

  it("returns an empty plan for a user with no memberships", () => {
    expect(classifyMemberships([], [], ME)).toEqual({
      organizationIdsToDelete: [],
      organizationIdsToLeave: [],
      blockers: [],
    });
  });

  it("ignores an organization id with no rows rather than inventing a plan for it", () => {
    const plan = classifyMemberships([], ["org_vanished"], ME);
    expect(plan.organizationIdsToDelete).toEqual([]);
    expect(plan.organizationIdsToLeave).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });
});

describe("isOwnerRole", () => {
  it("uses systemKey when it exists", () => {
    expect(isOwnerRole("owner", "member")).toBe(true);
    expect(isOwnerRole("member", "owner")).toBe(false);
  });

  it("falls back to the legacy column only when systemKey is absent", () => {
    expect(isOwnerRole(null, "owner")).toBe(true);
    expect(isOwnerRole(undefined, "owner")).toBe(true);
    expect(isOwnerRole(null, "member")).toBe(false);
    expect(isOwnerRole(null, null)).toBe(false);
  });
});
