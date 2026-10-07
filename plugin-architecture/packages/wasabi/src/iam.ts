import type { S3Client } from "./s3.js";
import { S3Error, xmlAll, xmlFirst } from "./s3.js";

/**
 * Wasabi IAM: the AWS IAM Query API (version 2010-05-08 only) at
 * `iam.wasabisys.com`, signed with SigV4 for service `iam` in `us-east-1`
 * ("IAM and STS Support With the Wasabi S3 API", 2026-10). Form-encoded POSTs
 * are accepted and avoid the 8,000-character query limit.
 */

export const IAM_ENDPOINT = "https://iam.wasabisys.com";

export interface IamUser {
  userName: string;
  userId: string;
  arn: string;
  path: string;
  createDate: string;
}

export interface IamAccessKey {
  accessKeyId: string;
  userName: string;
  status: string;
  createDate: string;
}

export interface IamPolicy {
  policyName: string;
  arn: string;
  description?: string;
  isAttachable?: boolean;
}

export class WasabiIam {
  constructor(private readonly s3: S3Client) {}

  async call(action: string, params: Record<string, string> = {}): Promise<string> {
    const body = new URLSearchParams({
      Action: action,
      Version: "2010-05-08",
      ...params,
    }).toString();
    const res = await this.s3.send(
      "POST",
      {
        body,
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        service: "iam",
      },
      `IAM ${action}`,
    );
    return res.body;
  }

  /** Follows `IsTruncated`/`Marker` pagination, collecting `<member>` blocks. */
  private async paged(
    action: string,
    listTag: string,
    params: Record<string, string> = {},
  ): Promise<string[]> {
    const out: string[] = [];
    let marker: string | undefined;
    for (let page = 0; page < 50; page++) {
      const xml = await this.call(action, {
        ...params,
        MaxItems: "1000",
        ...(marker ? { Marker: marker } : {}),
      });
      const list = xmlAll(xml, listTag)[0] ?? "";
      out.push(...xmlAll(list, "member"));
      marker = xmlFirst(xml, "IsTruncated") === "true" ? xmlFirst(xml, "Marker") : undefined;
      if (!marker) break;
    }
    return out;
  }

  async listUsers(): Promise<IamUser[]> {
    return (await this.paged("ListUsers", "Users")).map((m) => ({
      userName: xmlFirst(m, "UserName"),
      userId: xmlFirst(m, "UserId"),
      arn: xmlFirst(m, "Arn"),
      path: xmlFirst(m, "Path"),
      createDate: xmlFirst(m, "CreateDate"),
    }));
  }

  async createUser(userName: string): Promise<IamUser> {
    const xml = await this.call("CreateUser", { UserName: userName });
    return {
      userName: xmlFirst(xml, "UserName"),
      userId: xmlFirst(xml, "UserId"),
      arn: xmlFirst(xml, "Arn"),
      path: xmlFirst(xml, "Path"),
      createDate: xmlFirst(xml, "CreateDate"),
    };
  }

  async listAccessKeys(userName: string): Promise<IamAccessKey[]> {
    return (await this.paged("ListAccessKeys", "AccessKeyMetadata", { UserName: userName })).map(
      (m) => ({
        accessKeyId: xmlFirst(m, "AccessKeyId"),
        userName: xmlFirst(m, "UserName") || userName,
        status: xmlFirst(m, "Status"),
        createDate: xmlFirst(m, "CreateDate"),
      }),
    );
  }

  async lastUsed(accessKeyId: string): Promise<string> {
    try {
      const xml = await this.call("GetAccessKeyLastUsed", { AccessKeyId: accessKeyId });
      return xmlFirst(xml, "LastUsedDate");
    } catch {
      return "";
    }
  }

  async createAccessKey(
    userName: string,
  ): Promise<{ accessKeyId: string; secretAccessKey: string }> {
    const xml = await this.call("CreateAccessKey", { UserName: userName });
    return {
      accessKeyId: xmlFirst(xml, "AccessKeyId"),
      secretAccessKey: xmlFirst(xml, "SecretAccessKey"),
    };
  }

  async updateAccessKey(
    userName: string,
    accessKeyId: string,
    status: "Active" | "Inactive",
  ): Promise<void> {
    await this.call("UpdateAccessKey", {
      UserName: userName,
      AccessKeyId: accessKeyId,
      Status: status,
    });
  }

  async deleteAccessKey(userName: string, accessKeyId: string): Promise<void> {
    await this.call("DeleteAccessKey", { UserName: userName, AccessKeyId: accessKeyId });
  }

  async listPolicies(): Promise<IamPolicy[]> {
    return (await this.paged("ListPolicies", "Policies", { Scope: "All" })).map((m) => ({
      policyName: xmlFirst(m, "PolicyName"),
      arn: xmlFirst(m, "Arn"),
      description: xmlFirst(m, "Description"),
      isAttachable: xmlFirst(m, "IsAttachable") !== "false",
    }));
  }

  async attachedPolicies(userName: string): Promise<Array<{ name: string; arn: string }>> {
    return (
      await this.paged("ListAttachedUserPolicies", "AttachedPolicies", { UserName: userName })
    ).map((m) => ({
      name: xmlFirst(m, "PolicyName"),
      arn: xmlFirst(m, "PolicyArn"),
    }));
  }

  async inlinePolicies(userName: string): Promise<string[]> {
    const xml = await this.call("ListUserPolicies", { UserName: userName, MaxItems: "1000" });
    return xmlAll(xmlAll(xml, "PolicyNames")[0] ?? "", "member").map((m) => m.trim());
  }

  async groupsForUser(userName: string): Promise<string[]> {
    return (await this.paged("ListGroupsForUser", "Groups", { UserName: userName })).map((m) =>
      xmlFirst(m, "GroupName"),
    );
  }

  attachPolicy(userName: string, arn: string): Promise<string> {
    return this.call("AttachUserPolicy", { UserName: userName, PolicyArn: arn });
  }

  detachPolicy(userName: string, arn: string): Promise<string> {
    return this.call("DetachUserPolicy", { UserName: userName, PolicyArn: arn });
  }

  putUserPolicy(userName: string, name: string, document: string): Promise<string> {
    return this.call("PutUserPolicy", {
      UserName: userName,
      PolicyName: name,
      PolicyDocument: document,
    });
  }

  /** Deletes a user after removing what IAM refuses to delete a user with. */
  async deleteUser(userName: string): Promise<void> {
    for (const k of await this.listAccessKeys(userName))
      await this.deleteAccessKey(userName, k.accessKeyId);
    for (const p of await this.attachedPolicies(userName)) await this.detachPolicy(userName, p.arn);
    for (const name of await this.inlinePolicies(userName)) {
      await this.call("DeleteUserPolicy", { UserName: userName, PolicyName: name });
    }
    for (const g of await this.groupsForUser(userName)) {
      await this.call("RemoveUserFromGroup", { UserName: userName, GroupName: g });
    }
    try {
      await this.call("DeleteLoginProfile", { UserName: userName });
    } catch (err) {
      if (!(err instanceof S3Error) || err.status !== 404) throw err;
    }
    await this.call("DeleteUser", { UserName: userName });
  }
}

/** Inline policy granting one bucket, read/write or read-only. */
export function bucketPolicyDocument(bucket: string, readOnly: boolean): string {
  const objectActions = readOnly
    ? ["s3:GetObject", "s3:GetObjectVersion"]
    : [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
      ];
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:ListAllMyBuckets", "s3:GetBucketLocation"], Resource: "*" },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:ListBucketVersions", "s3:ListBucketMultipartUploads"],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      { Effect: "Allow", Action: objectActions, Resource: `arn:aws:s3:::${bucket}/*` },
    ],
  });
}
