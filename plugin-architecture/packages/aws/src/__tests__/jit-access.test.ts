import { describe, expect, it } from "vitest";
import type { JitGrantSpec } from "@infrawrench/plugin-base";

import {
  checkAwsJitAccess,
  findIdentityCenterInstance,
  grantAwsJitAccess,
  resolveAwsJitPrincipal,
  revokeAwsJitAccess,
  type AwsJitContext,
} from "../jit-access.js";

const INSTANCE = "arn:aws:sso:::instance/ssoins-1234567890abcdef";
const PS = "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1234567890abcdef";

function fakeAws(opts: { instanceRegion?: string; standing?: boolean } = {}) {
  const assignments = new Set<string>(opts.standing ? ["u-1"] : []);
  const ops: string[] = [];
  const ctx: AwsJitContext = {
    homeRegion: "us-east-1",
    regions: async () => ["us-east-1", "eu-west-1"],
    callerAccountId: async () => "111122223333",
    sleep: async () => undefined,
    async call<T>({
      region,
      target,
      body,
    }: {
      region: string;
      target: string;
      body: Record<string, unknown>;
    }) {
      const op = target.split(".")[1]!;
      ops.push(`${region}:${op}`);
      switch (op) {
        case "ListInstances":
          return (
            region === (opts.instanceRegion ?? "us-east-1")
              ? {
                  Instances: [
                    { InstanceArn: INSTANCE, IdentityStoreId: "d-123", Status: "ACTIVE" },
                  ],
                }
              : { Instances: [] }
          ) as T;
        case "ListAccountAssignments":
          return {
            AccountAssignments: [...assignments].map((id) => ({
              PrincipalId: id,
              PrincipalType: "USER",
            })),
          } as T;
        case "CreateAccountAssignment":
          assignments.add(String(body["PrincipalId"]));
          return {
            AccountAssignmentCreationStatus: { RequestId: "r1", Status: "IN_PROGRESS" },
          } as T;
        case "DescribeAccountAssignmentCreationStatus":
          return { AccountAssignmentCreationStatus: { RequestId: "r1", Status: "SUCCEEDED" } } as T;
        case "DeleteAccountAssignment":
          assignments.delete(String(body["PrincipalId"]));
          return { AccountAssignmentDeletionStatus: { RequestId: "r2", Status: "SUCCEEDED" } } as T;
        case "GetUserId":
          throw new Error("AWS identitystore POST / failed: 400: ResourceNotFoundException");
        default:
          throw new Error(`unexpected ${op}`);
      }
    },
  };
  return { ctx, assignments, ops };
}

const spec: JitGrantSpec = {
  grantId: "g1",
  scopeId: "444455556666",
  roleId: PS,
  principal: { id: "u-1", name: "Dana", kind: "user" },
  expiresAt: new Date("2026-10-07T12:00:00Z"),
};

describe("aws just-in-time access", () => {
  it("finds the Identity Center instance outside the home region", async () => {
    const { ctx } = fakeAws({ instanceRegion: "eu-west-1" });
    expect((await findIdentityCenterInstance(ctx)).region).toBe("eu-west-1");
  });

  it("reports standing access as present before anything is granted", async () => {
    const { ctx } = fakeAws({ standing: true });
    expect(await checkAwsJitAccess(ctx, spec)).toBe("present");
  });

  it("creates the assignment once and waits for it to settle", async () => {
    const { ctx, assignments, ops } = fakeAws();
    const result = await grantAwsJitAccess(ctx, spec);
    expect(result.ref).toBe("r1");
    expect(assignments.has("u-1")).toBe(true);
    await grantAwsJitAccess(ctx, spec);
    expect(ops.filter((o) => o.endsWith("CreateAccountAssignment"))).toHaveLength(1);
  });

  it("revokes idempotently", async () => {
    const { ctx, assignments, ops } = fakeAws();
    await revokeAwsJitAccess(ctx, spec);
    expect(ops.some((o) => o.endsWith("DeleteAccountAssignment"))).toBe(false);
    await grantAwsJitAccess(ctx, spec);
    await revokeAwsJitAccess(ctx, spec);
    expect(assignments.size).toBe(0);
  });

  it("returns null for a member with no Identity Center user", async () => {
    const { ctx } = fakeAws();
    expect(await resolveAwsJitPrincipal(ctx, { email: "nobody@example.com" })).toBeNull();
  });
});
