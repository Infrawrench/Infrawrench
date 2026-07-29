import { describe, it, expect, vi } from "vitest";
import type { AwsCreateContext } from "../create-handlers/shared.js";
import { createEksCluster } from "../create-handlers/eks.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

function trustDoc(principal: string): string {
  return encodeURIComponent(
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: principal }, Action: "sts:AssumeRole" }],
    }),
  );
}

function getRoleResponse(principal: string): Record<string, unknown> {
  return {
    GetRoleResult: { Role: { AssumeRolePolicyDocument: trustDoc(principal) } },
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): AwsCreateContext {
  const ctx = {
    creds,
    hostForService: (service: string) => `${service}.us-east-1.amazonaws.com`,
    // Default: no subnets anywhere, so the create path stops at the
    // "needs at least two subnets" error after the preflight passes.
    ec2: vi.fn(async () => ({}) as Record<string, unknown>),
    json: vi.fn(),
    ec2Query: vi.fn(async () => ({}) as Record<string, unknown>),
    queryPost: vi.fn(),
    xmlGet: vi.fn(),
    makeId: (accountId: string, typeId: string, externalId: string) =>
      `${accountId}:${typeId}:${externalId}`,
    listAllIAMPolicies: vi.fn(),
    policiesToOptions: vi.fn(),
    getResource: vi.fn(),
    withRegion: () => ctx,
    ...overrides,
  } as unknown as AwsCreateContext;
  return ctx;
}

const fields = {
  name: "my-cluster",
  roleArn: "arn:aws:iam::123456789012:role/eks-cluster-role",
  nodeRoleArn: "arn:aws:iam::123456789012:role/my-node-role",
};

describe("createEksCluster node-role preflight", () => {
  it("rejects at create time when the node role is not EC2-trusted", async () => {
    const ec2Query = vi.fn(async () => getRoleResponse("lambda.amazonaws.com"));
    const ctx = makeCtx({ ec2Query });
    await expect(createEksCluster(ctx, "acct", fields)).rejects.toThrow(/not assumable by EC2/);
    expect(ec2Query).toHaveBeenCalledWith("iam", "GetRole", "2010-05-08", {
      RoleName: "my-node-role",
    });
  });

  it("passes the preflight for an EC2-trusted node role", async () => {
    const ec2Query = vi.fn(async () => getRoleResponse("ec2.amazonaws.com"));
    const ctx = makeCtx({ ec2Query });
    // Preflight passes; with no subnets available the next failure is the
    // subnet check — proving the role was accepted.
    await expect(createEksCluster(ctx, "acct", fields)).rejects.toThrow(/at least two subnets/);
  });

  it("skips the preflight (best-effort) when iam:GetRole is denied", async () => {
    const ec2Query = vi.fn(async () => {
      throw new Error("AccessDenied");
    });
    const ctx = makeCtx({ ec2Query });
    await expect(createEksCluster(ctx, "acct", fields)).rejects.toThrow(/at least two subnets/);
  });

  it("still requires cluster and node roles", async () => {
    await expect(createEksCluster(makeCtx(), "acct", { ...fields, roleArn: "" })).rejects.toThrow(
      /Cluster Role is required/,
    );
    await expect(
      createEksCluster(makeCtx(), "acct", { ...fields, nodeRoleArn: "" }),
    ).rejects.toThrow(/Node Role is required/);
  });
});
