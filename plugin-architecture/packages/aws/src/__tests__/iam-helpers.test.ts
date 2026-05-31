import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ec2QueryCall = vi.fn();
const queryPostCall = vi.fn();
vi.mock("../client-transport.js", () => ({
  ec2QueryCall: (...a: unknown[]) => ec2QueryCall(...a),
  queryPostCall: (...a: unknown[]) => queryPostCall(...a),
}));

import { listAllIAMPolicies, policiesToOptions } from "../iam-policies.js";
import { generateServiceRole } from "../iam-role-generator.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

beforeEach(() => {
  ec2QueryCall.mockReset();
  queryPostCall.mockReset();
});

describe("listAllIAMPolicies", () => {
  it("paginates until not truncated", async () => {
    ec2QueryCall
      .mockResolvedValueOnce({
        ListPoliciesResult: {
          Policies: { member: [{ Arn: "arn:1", PolicyName: "p1" }] },
          IsTruncated: "true",
          Marker: "m1",
        },
      })
      .mockResolvedValueOnce({
        ListPoliciesResult: {
          Policies: { member: [{ Arn: "arn:2", PolicyName: "p2" }] },
          IsTruncated: "false",
        },
      });
    const out = await listAllIAMPolicies(creds, "AWS");
    expect(out.length).toBe(2);
    expect(ec2QueryCall).toHaveBeenCalledTimes(2);
    expect((ec2QueryCall.mock.calls[1]![4] as Record<string, string>)["Marker"]).toBe("m1");
  });
  it("stops when truncated but no marker", async () => {
    ec2QueryCall.mockResolvedValue({
      ListPoliciesResult: { Policies: { member: [] }, IsTruncated: "true" },
    });
    const out = await listAllIAMPolicies(creds, "Local");
    expect(out).toEqual([]);
    expect(ec2QueryCall).toHaveBeenCalledTimes(1);
  });
});

describe("policiesToOptions", () => {
  it("maps, filters empty arns, sorts by label, includes description", () => {
    const out = policiesToOptions(
      [
        { Arn: "arn:b", PolicyName: "Beta", Description: "d" },
        { Arn: "arn:a", PolicyName: "Alpha" },
        { Arn: "", PolicyName: "Skip" },
      ],
      "AWS Managed",
    );
    expect(out.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
    expect(out[1]!.description).toBe("d");
    expect(out.every((o) => o.category === "AWS Managed")).toBe(true);
  });
});

describe("generateServiceRole", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("creates role, attaches policies, waits for settle", async () => {
    queryPostCall.mockImplementation(async (_c, _s, action) => {
      if (action === "CreateRole") return { CreateRoleResult: { Role: { Arn: "arn:role/x" } } };
      return {};
    });
    const promise = generateServiceRole(creds, {
      principalService: "lambda.amazonaws.com",
      managedPolicyArns: ["arn:policy/a", "arn:policy/b"],
      namePrefix: "iw-",
      description: "desc",
    });
    await vi.advanceTimersByTimeAsync(8000);
    const result = await promise;
    expect(result.roleArn).toBe("arn:role/x");
    expect(result.roleName).toMatch(/^iw-/);
    const attaches = queryPostCall.mock.calls.filter((c) => c[2] === "AttachRolePolicy");
    expect(attaches.length).toBe(2);
    // trust policy includes the principal
    const createParams = queryPostCall.mock.calls.find((c) => c[2] === "CreateRole")![4] as Record<
      string,
      string
    >;
    expect(createParams["AssumeRolePolicyDocument"]).toContain("lambda.amazonaws.com");
    expect(createParams["Description"]).toBe("desc");
  });

  it("handles array principal and no policies", async () => {
    queryPostCall.mockResolvedValue({ CreateRoleResult: { Role: { Arn: "arn:role/y" } } });
    const promise = generateServiceRole(creds, {
      principalService: ["a.amazonaws.com", "b.amazonaws.com"],
      managedPolicyArns: [],
      namePrefix: "p-",
    });
    await vi.advanceTimersByTimeAsync(8000);
    const result = await promise;
    expect(result.roleArn).toBe("arn:role/y");
    const createParams = queryPostCall.mock.calls[0]![4] as Record<string, string>;
    expect(createParams["AssumeRolePolicyDocument"]).toContain("a.amazonaws.com");
    expect(createParams["AssumeRolePolicyDocument"]).toContain("b.amazonaws.com");
  });

  it("throws when no Arn returned", async () => {
    queryPostCall.mockResolvedValue({ CreateRoleResult: { Role: {} } });
    await expect(
      generateServiceRole(creds, {
        principalService: "x",
        managedPolicyArns: [],
        namePrefix: "p-",
      }),
    ).rejects.toThrow(/did not return an Arn/);
  });
});
