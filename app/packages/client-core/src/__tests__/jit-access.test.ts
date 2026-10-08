import { describe, expect, it } from "vitest";

import {
  jitCanDecide,
  jitExtensionHeadroom,
  jitIsApprover,
  jitMayRequest,
  jitRequestQuery,
} from "../jit-access";

const base = {
  decision: "approve" as const,
  requesterUserId: "dana",
  deciderUserId: "sam",
  deciderIsApprover: true,
  allowSelfApprovalDuringIncident: false,
  activeIncidentId: null,
  principalMatched: true,
};

describe("jitCanDecide", () => {
  it("lets an approver decide somebody else's request", () => {
    expect(jitCanDecide(base)).toEqual({ allowed: true, selfApproved: false });
    expect(jitCanDecide({ ...base, decision: "deny" })).toEqual({
      allowed: true,
      selfApproved: false,
    });
  });

  it("refuses anyone outside the approver set", () => {
    expect(jitCanDecide({ ...base, deciderIsApprover: false })).toEqual({
      allowed: false,
      code: "not_approver",
    });
  });

  it("refuses self-approval by default, even for an approver during an incident", () => {
    const self = { ...base, deciderUserId: "dana" };
    expect(jitCanDecide(self)).toEqual({ allowed: false, code: "self_approval" });
    expect(jitCanDecide({ ...self, activeIncidentId: "inc-1" })).toEqual({
      allowed: false,
      code: "self_approval",
    });
  });

  it("allows self-approval only when the policy opts in and an incident is open", () => {
    const self = { ...base, deciderUserId: "dana", allowSelfApprovalDuringIncident: true };
    expect(jitCanDecide(self)).toEqual({ allowed: false, code: "self_approval" });
    expect(jitCanDecide({ ...self, activeIncidentId: "inc-1" })).toEqual({
      allowed: true,
      selfApproved: true,
    });
    // Never to hand access to somebody else's principal.
    expect(jitCanDecide({ ...self, activeIncidentId: "inc-1", principalMatched: false })).toEqual({
      allowed: false,
      code: "self_approval_unmatched_principal",
    });
    // And never as a self-denial: cancelling is its own operation.
    expect(jitCanDecide({ ...self, activeIncidentId: "inc-1", decision: "deny" })).toEqual({
      allowed: false,
      code: "self_approval",
    });
  });

  it("still requires the self-approver to be an approver", () => {
    expect(
      jitCanDecide({
        ...base,
        deciderUserId: "dana",
        deciderIsApprover: false,
        allowSelfApprovalDuringIncident: true,
        activeIncidentId: "inc-1",
      }),
    ).toEqual({ allowed: false, code: "not_approver" });
  });
});

describe("approver and requester sets", () => {
  const policy = {
    enabled: true,
    requesterUserIds: [] as string[],
    requesterRoleIds: [] as string[],
    approverUserIds: ["u1"],
    approverRoleIds: ["role-admin"],
  };

  it("treats empty requester lists as everyone, and a disabled policy as nobody", () => {
    expect(jitMayRequest(policy, { userId: "x", roleId: null })).toBe(true);
    expect(jitMayRequest({ ...policy, enabled: false }, { userId: "x", roleId: null })).toBe(false);
    const narrowed = { ...policy, requesterRoleIds: ["role-sre"] };
    expect(jitMayRequest(narrowed, { userId: "x", roleId: "role-sre" })).toBe(true);
    expect(jitMayRequest(narrowed, { userId: "x", roleId: "role-dev" })).toBe(false);
  });

  it("unions users, roles and whoever is on call now", () => {
    expect(jitIsApprover(policy, { userId: "u1", roleId: null })).toBe(true);
    expect(jitIsApprover(policy, { userId: "u2", roleId: "role-admin" })).toBe(true);
    expect(jitIsApprover(policy, { userId: "u3", roleId: null })).toBe(false);
    expect(jitIsApprover(policy, { userId: "u3", roleId: null }, ["u3"])).toBe(true);
  });
});

describe("helpers", () => {
  it("caps extensions at the policy maximum for the whole window", () => {
    expect(jitExtensionHeadroom({ durationMinutes: 60, extendedMinutes: 30 }, 120)).toBe(30);
    expect(jitExtensionHeadroom({ durationMinutes: 120, extendedMinutes: 30 }, 120)).toBe(0);
  });

  it("builds request filters", () => {
    expect(jitRequestQuery()).toBe("");
    expect(jitRequestQuery({ mine: true, status: "pending" })).toBe("?status=pending&mine=1");
  });
});
