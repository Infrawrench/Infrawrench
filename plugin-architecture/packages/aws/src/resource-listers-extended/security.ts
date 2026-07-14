import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../xml.js";
import type { ListerContext } from "../resource-listers.js";

export async function listIAMRoles(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>("iam", "ListRoles", "2010-05-08");
  const listResult = data["ListRolesResult"] as Record<string, unknown> | undefined;
  const roles = ensureArray(
    (listResult?.["Roles"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];
  return roles.map((r) => {
    const roleName = String(r["RoleName"] ?? "");
    return {
      id: ctx.id(accountId, "iam-role", roleName),
      pluginId: "aws",
      resourceTypeId: "iam-role",
      accountId,
      displayName: roleName,
      fields: {
        roleName,
        roleId: String(r["RoleId"] ?? ""),
        path: String(r["Path"] ?? "/"),
        createDate: String(r["CreateDate"] ?? ""),
        description: String(r["Description"] ?? ""),
        maxSessionDuration: Number(r["MaxSessionDuration"] ?? 3600),
      },
      resolvedOutputs: {
        roleArn: String(r["Arn"] ?? ""),
      },
      secretStates: [],
      externalId: roleName,
      createdAt: String(r["CreateDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listACMCertificates(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{
    CertificateSummaryList?: Record<string, unknown>[];
  }>("acm", "CertificateManager.ListCertificates", {});
  const certs = data.CertificateSummaryList ?? [];
  const results: ResourceInstance[] = [];

  for (const cert of certs) {
    const arn = String(cert["CertificateArn"] ?? "");
    try {
      const detail = await ctx.json<{
        Certificate: Record<string, unknown>;
      }>("acm", "CertificateManager.DescribeCertificate", { CertificateArn: arn });
      const c = detail.Certificate;
      const sans = c["SubjectAlternativeNames"] as string[] | undefined;
      const inUseBy = c["InUseBy"] as string[] | undefined;

      results.push({
        id: ctx.id(accountId, "acm-certificate", arn),
        pluginId: "aws",
        resourceTypeId: "acm-certificate",
        accountId,
        displayName: String(c["DomainName"] ?? ""),
        fields: {
          domainName: String(c["DomainName"] ?? ""),
          region: ctx.region,
          status: String(c["Status"] ?? ""),
          type: String(c["Type"] ?? ""),
          issuer: String(c["Issuer"] ?? ""),
          notBefore: String(c["NotBefore"] ?? ""),
          notAfter: String(c["NotAfter"] ?? ""),
          keyAlgorithm: String(c["KeyAlgorithm"] ?? ""),
          subjectAlternativeNames: sans?.join(", ") ?? "",
          inUseBy: inUseBy?.length ?? 0,
        },
        resolvedOutputs: { certificateArn: arn },
        secretStates: [],
        externalId: arn,
        createdAt: String(c["CreatedAt"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      results.push({
        id: ctx.id(accountId, "acm-certificate", arn),
        pluginId: "aws",
        resourceTypeId: "acm-certificate",
        accountId,
        displayName: String(cert["DomainName"] ?? ""),
        fields: {
          domainName: String(cert["DomainName"] ?? ""),
          region: ctx.region,
          status: String(cert["Status"] ?? ""),
          type: String(cert["Type"] ?? ""),
          issuer: "",
          notBefore: "",
          notAfter: "",
          keyAlgorithm: String(cert["KeyAlgorithm"] ?? ""),
          subjectAlternativeNames: "",
          inUseBy: 0,
        },
        resolvedOutputs: { certificateArn: arn },
        secretStates: [],
        externalId: arn,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listWAFWebACLs(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{
    WebACLs?: Record<string, unknown>[];
  }>("wafv2", "AWSWAF_20190729.ListWebACLs", { Scope: "REGIONAL", Limit: 100 });
  const acls = data.WebACLs ?? [];
  const results: ResourceInstance[] = [];

  for (const acl of acls) {
    const name = String(acl["Name"] ?? "");
    const aclId = String(acl["Id"] ?? "");
    const arn = String(acl["ARN"] ?? "");

    try {
      const detail = await ctx.json<{
        WebACL: Record<string, unknown>;
      }>("wafv2", "AWSWAF_20190729.GetWebACL", { Name: name, Scope: "REGIONAL", Id: aclId });
      const w = detail.WebACL;
      const rules = w["Rules"] as unknown[] | undefined;
      const defaultAction = w["DefaultAction"] as Record<string, unknown> | undefined;

      results.push({
        id: ctx.id(accountId, "waf-web-acl", name),
        pluginId: "aws",
        resourceTypeId: "waf-web-acl",
        accountId,
        displayName: name,
        fields: {
          name,
          region: ctx.region,
          scope: "REGIONAL",
          description: String(w["Description"] ?? ""),
          ruleCount: rules?.length ?? 0,
          defaultAction: defaultAction?.["Allow"] ? "ALLOW" : "BLOCK",
          capacity: Number(w["Capacity"] ?? 0),
        },
        resolvedOutputs: {
          webAclArn: arn,
          webAclId: aclId,
        },
        secretStates: [],
        externalId: name,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    } catch {
      results.push({
        id: ctx.id(accountId, "waf-web-acl", name),
        pluginId: "aws",
        resourceTypeId: "waf-web-acl",
        accountId,
        displayName: name,
        fields: {
          name,
          region: ctx.region,
          scope: "REGIONAL",
          description: String(acl["Description"] ?? ""),
          ruleCount: 0,
          defaultAction: "ALLOW",
          capacity: 0,
        },
        resolvedOutputs: { webAclArn: arn, webAclId: aclId },
        secretStates: [],
        externalId: name,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

export async function listSSMParameters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ Parameters?: Record<string, unknown>[] }>(
    "ssm",
    "AmazonSSM.DescribeParameters",
    {},
  );
  const params = data.Parameters ?? [];
  return params.map((p) => {
    const name = String(p["Name"] ?? "");
    return {
      id: ctx.id(accountId, "ssm-parameter", name),
      pluginId: "aws",
      resourceTypeId: "ssm-parameter",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        type: String(p["Type"] ?? ""),
        version: Number(p["Version"] ?? 0),
        tier: String(p["Tier"] ?? "Standard"),
        lastModifiedDate: String(p["LastModifiedDate"] ?? ""),
        dataType: String(p["DataType"] ?? "text"),
      },
      resolvedOutputs: {
        parameterArn: `arn:aws:ssm:${ctx.region}:${accountId}:parameter${name.startsWith("/") ? "" : "/"}${name}`,
        parameterValue: "",
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCognitoUserPools(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const listData = await ctx.json<{
    UserPools?: Array<Record<string, unknown>>;
  }>("cognito-idp", "AWSCognitoIdentityProviderService.ListUserPools", { MaxResults: 60 });
  const pools = listData.UserPools ?? [];
  const results: ResourceInstance[] = [];

  for (const pool of pools) {
    const poolId = String(pool["Id"] ?? "");
    const name = String(pool["Name"] ?? "");
    try {
      const detail = await ctx.json<{
        UserPool: Record<string, unknown>;
      }>("cognito-idp", "AWSCognitoIdentityProviderService.DescribeUserPool", {
        UserPoolId: poolId,
      });
      const up = detail.UserPool;
      results.push({
        id: ctx.id(accountId, "cognito-user-pool", poolId),
        pluginId: "aws",
        resourceTypeId: "cognito-user-pool",
        accountId,
        displayName: name,
        fields: {
          name,
          userPoolId: poolId,
          status: String(pool["Status"] ?? ""),
          mfaConfiguration: String(up["MfaConfiguration"] ?? "OFF"),
          estimatedNumberOfUsers: Number(up["EstimatedNumberOfUsers"] ?? 0),
          creationDate: String(up["CreationDate"] ?? ""),
          lastModifiedDate: String(up["LastModifiedDate"] ?? ""),
          domain: String(up["Domain"] ?? ""),
        },
        resolvedOutputs: {
          userPoolId: poolId,
          userPoolArn: String(up["Arn"] ?? ""),
        },
        secretStates: [],
        externalId: poolId,
        createdAt: String(up["CreationDate"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      results.push({
        id: ctx.id(accountId, "cognito-user-pool", poolId),
        pluginId: "aws",
        resourceTypeId: "cognito-user-pool",
        accountId,
        displayName: name,
        fields: {
          name,
          userPoolId: poolId,
          status: String(pool["Status"] ?? ""),
          mfaConfiguration: "OFF",
          estimatedNumberOfUsers: 0,
          creationDate: String(pool["CreationDate"] ?? ""),
          lastModifiedDate: String(pool["LastModifiedDate"] ?? ""),
          domain: "",
        },
        resolvedOutputs: {
          userPoolId: poolId,
          userPoolArn: "",
        },
        secretStates: [],
        externalId: poolId,
        createdAt: String(pool["CreationDate"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}
