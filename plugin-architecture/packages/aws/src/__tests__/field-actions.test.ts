import { describe, it, expect, vi, beforeEach } from "vitest";

const ec2Call = vi.fn();
const generateServiceRole = vi.fn();
vi.mock("../client-transport.js", () => ({ ec2Call: (...a: unknown[]) => ec2Call(...a) }));
vi.mock("../iam-role-generator.js", () => ({
  generateServiceRole: (...a: unknown[]) => generateServiceRole(...a),
}));

import { executeFieldAction } from "../field-actions.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

beforeEach(() => {
  ec2Call.mockReset();
  generateServiceRole.mockReset();
});

describe("executeFieldAction generate-role entries", () => {
  const roleFields: Array<[string, string, string]> = [
    ["lambda-function", "role", "lambda.amazonaws.com"],
    ["step-function", "roleArn", "states.amazonaws.com"],
    ["codebuild-project", "serviceRole", "codebuild.amazonaws.com"],
    ["ecs-service", "taskRoleArn", "ecs-tasks.amazonaws.com"],
    ["eks-cluster", "roleArn", "eks.amazonaws.com"],
    ["eks-cluster", "nodeRoleArn", "ec2.amazonaws.com"],
    ["sagemaker-endpoint", "roleArn", "sagemaker.amazonaws.com"],
  ];
  for (const [typeId, fieldKey, principal] of roleFields) {
    it(`${typeId}.${fieldKey} mints a role for ${principal}`, async () => {
      generateServiceRole.mockResolvedValue({ roleArn: "arn:role/x", roleName: "x" });
      const out = await executeFieldAction(creds, typeId, fieldKey, "generate-role", {}, {});
      expect(out.value).toBe("arn:role/x");
      expect(out.option).toEqual({ id: "arn:role/x", label: "x" });
      expect(generateServiceRole.mock.calls[0]![1]).toMatchObject({ principalService: principal });
    });
  }
});

describe("executeFieldAction create-sg", () => {
  it("creates an SG in the picked VPC and authorizes selected ports", async () => {
    ec2Call.mockImplementation(async (_c, action) => {
      if (action === "CreateSecurityGroup") return { groupId: "sg-new" };
      return {};
    });
    const out = await executeFieldAction(
      creds,
      "ec2-instance",
      "securityGroup",
      "create-sg",
      { region: "us-west-2", network: "vpc-1" },
      {
        sgName: "my-sg",
        sgAllowSsh: "true",
        sgAllowHttp: "true",
        sgAllowHttps: "true",
        sgSourceCidr: "1.2.3.4/32",
      },
    );
    expect(out.value).toBe("sg-new");
    const auth = ec2Call.mock.calls.find((c) => c[1] === "AuthorizeSecurityGroupIngress")!;
    const params = auth[2] as Record<string, string>;
    expect(params["IpPermissions.1.FromPort"]).toBe("22");
    expect(params["IpPermissions.3.ToPort"]).toBe("443");
    expect(params["IpPermissions.1.IpRanges.1.CidrIp"]).toBe("1.2.3.4/32");
  });

  it("falls back to the default VPC when none picked", async () => {
    ec2Call.mockImplementation(async (_c, action) => {
      if (action === "DescribeVpcs") return { vpcSet: { item: { vpcId: "vpc-default" } } };
      if (action === "CreateSecurityGroup") return { groupId: "sg-2" };
      return {};
    });
    const out = await executeFieldAction(
      creds,
      "ec2-instance",
      "securityGroup",
      "create-sg",
      {},
      {},
    );
    expect(out.value).toBe("sg-2");
    const create = ec2Call.mock.calls.find((c) => c[1] === "CreateSecurityGroup")!;
    expect((create[2] as Record<string, string>)["VpcId"]).toBe("vpc-default");
    // no ports authorized
    expect(ec2Call.mock.calls.some((c) => c[1] === "AuthorizeSecurityGroupIngress")).toBe(false);
  });

  it("throws when no VPC and no default VPC found", async () => {
    ec2Call.mockImplementation(async (_c, action) => {
      if (action === "DescribeVpcs") return { vpcSet: {} };
      return {};
    });
    await expect(
      executeFieldAction(creds, "ec2-instance", "securityGroup", "create-sg", {}, {}),
    ).rejects.toThrow(/No VPC selected/);
  });

  it("throws when CreateSecurityGroup returns no groupId", async () => {
    ec2Call.mockImplementation(async (_c, action) => {
      if (action === "CreateSecurityGroup") return {};
      return {};
    });
    await expect(
      executeFieldAction(
        creds,
        "ec2-instance",
        "securityGroup",
        "create-sg",
        { network: "vpc-1" },
        {},
      ),
    ).rejects.toThrow(/no groupId/);
  });
});

describe("executeFieldAction unknown", () => {
  it("throws for an unregistered action", async () => {
    await expect(executeFieldAction(creds, "x", "y", "z", {}, {})).rejects.toThrow(
      /no field action registered/,
    );
  });
});
