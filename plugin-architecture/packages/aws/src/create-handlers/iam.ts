import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCreateContext } from "./shared.js";

function parsePolicyArns(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function iamGetCreateConfig(
  ctx: AwsCreateContext,
  typeId: string,
  _parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "iam-role") {
    const [awsManaged, customerManaged] = await Promise.all([
      ctx.listAllIAMPolicies("AWS").catch(() => []),
      ctx.listAllIAMPolicies("Local").catch(() => []),
    ]);
    const policies = [
      ...ctx.policiesToOptions(awsManaged, "AWS Managed"),
      ...ctx.policiesToOptions(customerManaged, "Customer Managed"),
    ];
    return {
      fields: [
        { key: "roleName", label: "Role Name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "text", required: false },
        {
          key: "assumeRolePolicyDocument",
          label: "Assume Role Policy (JSON)",
          kind: "text",
          required: false,
          multiline: true,
          description: "Trust policy JSON (defaults to EC2 assume role)",
          defaultValue:
            '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}',
        },
        {
          key: "attachedPolicies",
          label: "Attached Policies",
          kind: "policy-picker",
          required: false,
          description: "Managed IAM policies to attach to this role",
          policies,
        },
      ],
    };
  }
  if (typeId === "iam-user") {
    const [awsManaged, customerManaged] = await Promise.all([
      ctx.listAllIAMPolicies("AWS").catch(() => []),
      ctx.listAllIAMPolicies("Local").catch(() => []),
    ]);
    const policies = [
      ...ctx.policiesToOptions(awsManaged, "AWS Managed"),
      ...ctx.policiesToOptions(customerManaged, "Customer Managed"),
    ];
    return {
      fields: [
        { key: "userName", label: "User Name", kind: "text", required: true },
        {
          key: "attachedPolicies",
          label: "Attached Policies",
          kind: "policy-picker",
          required: false,
          description: "Managed IAM policies to attach to this user",
          policies,
        },
      ],
    };
  }
  return null;
}

export async function iamCreateResource(
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  _parentResourceId?: string,
): Promise<ResourceInstance | null> {
  if (typeId === "iam-role") {
    const roleName = fields["roleName"] ?? "";
    const defaultPolicy =
      '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}';
    const createParams: Record<string, string> = {
      RoleName: roleName,
      AssumeRolePolicyDocument: fields["assumeRolePolicyDocument"] || defaultPolicy,
    };
    if (fields["description"]) createParams["Description"] = fields["description"];
    const data = await ctx.queryPost<Record<string, unknown>>(
      "iam",
      "CreateRole",
      "2010-05-08",
      createParams,
    );
    const createResult = data["CreateRoleResult"] as Record<string, unknown> | undefined;
    const role = (createResult?.["Role"] as Record<string, unknown>) ?? {};
    const policyArns = parsePolicyArns(fields["attachedPolicies"]);
    if (policyArns.length > 0) {
      await Promise.all(
        policyArns.map((arn) =>
          ctx.queryPost<Record<string, unknown>>("iam", "AttachRolePolicy", "2010-05-08", {
            RoleName: roleName,
            PolicyArn: arn,
          }),
        ),
      );
    }
    return {
      id: ctx.makeId(accountId, "iam-role", roleName),
      pluginId: "aws",
      resourceTypeId: "iam-role",
      accountId,
      displayName: roleName,
      fields: {
        roleName,
        roleId: String(role["RoleId"] ?? ""),
        path: String(role["Path"] ?? "/"),
        createDate: new Date().toISOString(),
        description: fields["description"] ?? "",
        maxSessionDuration: 3600,
      },
      resolvedOutputs: {
        roleArn: String(role["Arn"] ?? ""),
      },
      secretStates: [],
      externalId: roleName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "iam-user") {
    const userName = fields["userName"] ?? "";
    const data = await ctx.queryPost<Record<string, unknown>>("iam", "CreateUser", "2010-05-08", {
      UserName: userName,
    });
    const createResult = data["CreateUserResult"] as Record<string, unknown> | undefined;
    const user = (createResult?.["User"] as Record<string, unknown>) ?? {};
    const policyArns = parsePolicyArns(fields["attachedPolicies"]);
    if (policyArns.length > 0) {
      await Promise.all(
        policyArns.map((arn) =>
          ctx.queryPost<Record<string, unknown>>("iam", "AttachUserPolicy", "2010-05-08", {
            UserName: userName,
            PolicyArn: arn,
          }),
        ),
      );
    }
    return {
      id: ctx.makeId(accountId, "iam-user", userName),
      pluginId: "aws",
      resourceTypeId: "iam-user",
      accountId,
      displayName: userName,
      fields: {
        userName,
        userId: String(user["UserId"] ?? ""),
        path: String(user["Path"] ?? "/"),
        createDate: new Date().toISOString(),
        passwordLastUsed: "",
      },
      resolvedOutputs: {
        userArn: String(user["Arn"] ?? ""),
      },
      secretStates: [],
      externalId: userName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
}
