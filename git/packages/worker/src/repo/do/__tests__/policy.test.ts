import type { ReceiveUpdate } from "@infrawrench/git-protocol";
import { describe, expect, it } from "vitest";
import type { ProtectedBranchRule } from "../../../db/policy-rules";
import { type PushPolicy, checkPush, onlyRefOf, refusal } from "../policy";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

const rule = (settings: Partial<ProtectedBranchRule> = {}): ProtectedBranchRule => ({
  pattern: "main",
  requirePullRequest: false,
  requiredApprovals: 0,
  dismissStaleApprovals: false,
  requiredStatusContexts: [],
  allowForcePush: false,
  allowDeletion: false,
  restrictPushers: false,
  pusherUserIds: [],
  enforceAdmins: false,
  ...settings,
});

const policy = (rules: ProtectedBranchRule[], who: Partial<PushPolicy> = {}): PushPolicy => ({
  rules,
  userId: "user-1",
  admin: false,
  ...who,
});

const update = (name: string, kind: ReceiveUpdate["kind"], forced = false): ReceiveUpdate => ({
  name,
  oldOid: kind === "create" ? ZERO : A,
  newOid: kind === "delete" ? ZERO : B,
  kind,
  forced,
});

describe("push policy", () => {
  it("lets anything through where no rule matches", () => {
    const rules = policy([rule()]);
    expect(refusal(rules, update("refs/heads/topic", "update", true))).toBeNull();
    expect(refusal(rules, update("refs/heads/topic", "delete"))).toBeNull();
    expect(refusal(rules, update("refs/tags/v1", "update", true))).toBeNull();
  });

  it("allows a fast-forward to a protected branch and refuses a forced push or a deletion", () => {
    const rules = policy([rule()]);
    expect(refusal(rules, update("refs/heads/main", "update"))).toBeNull();
    expect(refusal(rules, update("refs/heads/main", "update", true))).toMatch(/force pushes/);
    expect(refusal(rules, update("refs/heads/main", "delete"))).toMatch(/deletion/);
    const lenient = policy([rule({ allowForcePush: true, allowDeletion: true })]);
    expect(refusal(lenient, update("refs/heads/main", "update", true))).toBeNull();
    expect(refusal(lenient, update("refs/heads/main", "delete"))).toBeNull();
  });

  it("refuses a direct push where changes must come by pull request", () => {
    for (const settings of [
      { requirePullRequest: true },
      { requiredApprovals: 1 },
      { requiredStatusContexts: ["Infrawrench CI / pull request"] },
    ]) {
      expect(refusal(policy([rule(settings)]), update("refs/heads/main", "update"))).toMatch(
        /pull request/,
      );
    }
  });

  it("restricts pushers to the listed people, which nothing without a person can be", () => {
    const rules = [rule({ restrictPushers: true, pusherUserIds: ["user-1"] })];
    expect(refusal(policy(rules), update("refs/heads/main", "update"))).toBeNull();
    expect(
      refusal(policy(rules, { userId: "user-2" }), update("refs/heads/main", "update")),
    ).toMatch(/not allowed to push/);
    // A deploy key or a job token pushes as nobody.
    expect(refusal(policy(rules, { userId: null }), update("refs/heads/main", "update"))).toMatch(
      /not allowed to push/,
    );
  });

  it("binds administrators only when the rule says so", () => {
    const forced = update("refs/heads/main", "update", true);
    expect(refusal(policy([rule()], { admin: true }), forced)).toBeNull();
    expect(refusal(policy([rule({ enforceAdmins: true })], { admin: true }), forced)).toMatch(
      /force pushes/,
    );
  });

  it("applies patterns, the strictest of several", () => {
    const rules = policy([
      rule({ pattern: "release/*", allowForcePush: true }),
      rule({ pattern: "release/**", allowForcePush: false }),
    ]);
    expect(refusal(rules, update("refs/heads/release/1.0", "update", true))).toMatch(
      /force pushes/,
    );
    expect(refusal(rules, update("refs/heads/releases", "update", true))).toBeNull();
  });

  it("keeps the refs the server manages out of reach of every pusher", () => {
    const admin = policy([], { admin: true });
    expect(refusal(admin, update("refs/pull/7/head", "update"))).toMatch(/managed by the server/);
    expect(refusal(admin, update("refs/pull/7/head", "delete"))).toMatch(/managed by the server/);
    expect(refusal(admin, update("refs/infrawrench/merge/7", "create"))).toMatch(/managed/);
  });

  it("takes only branches and tags from a push, with or without rules", () => {
    const admin = policy([], { admin: true });
    for (const name of ["refs/notes/commits", "refs/remotes/origin/main", "refs/meta/config"]) {
      expect(refusal(admin, update(name, "create"))).toMatch(/only branches and tags/);
      expect(checkPush(null, [update(name, "create")]).get(name)).toMatch(/only branches/);
    }
    expect(checkPush(null, [update("refs/pull/1/head", "create")]).get("refs/pull/1/head")).toMatch(
      /managed by the server/,
    );
    expect(
      checkPush(null, [update("refs/heads/a", "create"), update("refs/tags/v1", "create")]),
    ).toEqual(new Map());
  });

  it("answers for a whole push by ref name", () => {
    const refused = checkPush(policy([rule()]), [
      update("refs/heads/main", "delete"),
      update("refs/heads/topic", "create"),
    ]);
    expect([...refused.keys()]).toEqual(["refs/heads/main"]);
  });

  it("refuses every addition while the owner is over its storage quota, admins included", () => {
    const over = policy([], {
      admin: true,
      quotaRefusal: "storage quota exceeded: 1.2 GiB of 1 GiB",
    });
    expect(refusal(over, update("refs/heads/topic", "create"))).toMatch(/storage quota exceeded/);
    expect(refusal(over, update("refs/heads/main", "update"))).toMatch(/storage quota exceeded/);
    expect(refusal(over, update("refs/tags/v1", "create"))).toMatch(/storage quota exceeded/);
    // Deleting is how someone makes room.
    expect(refusal(over, update("refs/heads/topic", "delete"))).toBeNull();
    expect(
      refusal(policy([], { quotaRefusal: null }), update("refs/heads/x", "create")),
    ).toBeNull();
  });

  it("confines a branch-bound job to creating and updating its own branch", () => {
    const own = "refs/heads/work/fix";
    const agent = policy([], { userId: null, onlyRef: own });
    expect(refusal(agent, update(own, "create"))).toBeNull();
    expect(refusal(agent, update(own, "update"))).toBeNull();
    expect(refusal(agent, update(own, "update", true))).toBeNull();
    expect(refusal(agent, update(own, "delete"))).toMatch(/may not delete/);
    expect(refusal(agent, update("refs/heads/main", "update"))).toMatch(/its own branch/);
    expect(refusal(agent, update("refs/heads/work/fix-2", "create"))).toMatch(/its own branch/);
    expect(refusal(agent, update("refs/heads/work", "create"))).toMatch(/its own branch/);
    expect(refusal(agent, update("refs/tags/v1", "create"))).toMatch(/its own branch/);
    // Even as an administrator would be: the confinement is the credential's.
    expect(refusal({ ...agent, admin: true }, update("refs/heads/main", "update"))).toMatch(
      /its own branch/,
    );
    // Protected-branch rules still apply on top.
    const guarded = policy([rule({ pattern: "work/*" })], { userId: null, onlyRef: own });
    expect(refusal(guarded, update(own, "update", true))).toMatch(/force pushes/);
    expect(refusal(guarded, update(own, "update"))).toBeNull();
    const refused = checkPush(agent, [
      update(own, "update"),
      update("refs/heads/main", "update"),
      update("refs/tags/v2", "create"),
    ]);
    expect([...refused.keys()]).toEqual(["refs/heads/main", "refs/tags/v2"]);
  });

  it("confines only a job bound to a branch", () => {
    const base = { userId: null, admin: false, rules: [] };
    expect(onlyRefOf({ kind: "job", repositoryId: "r", write: true, runId: null })).toBeNull();
    expect(
      onlyRefOf({ kind: "job", repositoryId: "r", write: true, runId: null, ref: "refs/heads/x" }),
    ).toBe("refs/heads/x");
    expect(onlyRefOf({ kind: "deploy-key", keyId: "k", repositoryId: "r", readOnly: false })).toBe(
      null,
    );
    expect(refusal({ ...base, onlyRef: null }, update("refs/heads/main", "update"))).toBeNull();
  });
});
