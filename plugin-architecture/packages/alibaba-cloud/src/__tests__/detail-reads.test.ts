import { describe, expect, it } from "vitest";
import { makeClient, type Recorded, type Reply } from "./helpers.js";

const ONE_REGION = { regions: "ap-southeast-1" };
const FAILED: Reply = { status: 500, body: { Code: "InternalError", Message: "boom" } };
const REFUSED: Reply = { status: 403, body: { Code: "Forbidden.RAM", Message: "no" } };
const GONE: Reply = {
  status: 404,
  body: { Code: "InvalidSecurityGroupId.NotFound", Message: "gone" },
};
const BAD_KEY: Reply = {
  status: 404,
  body: { Code: "InvalidAccessKeyId.NotFound", Message: "no" },
};

const OSS_LIST = `<ListAllMyBucketsResult><Buckets><Bucket><Name>b</Name><Region>eu-central-1</Region></Bucket></Buckets></ListAllMyBucketsResult>`;

function securityGroups(detail: Reply) {
  return makeClient((req) => {
    if (req.action === "DescribeSecurityGroups") {
      return { body: { SecurityGroups: { SecurityGroup: [{ SecurityGroupId: "sg-1" }] } } };
    }
    return req.action === "DescribeSecurityGroupAttribute" ? detail : undefined;
  }, ONE_REGION);
}

function rds(detail: Reply) {
  return makeClient((req) => {
    if (req.action === "DescribeDBInstances") {
      return { body: { Items: { DBInstance: [{ DBInstanceId: "rm-1" }] }, TotalRecordCount: 1 } };
    }
    return req.action === "DescribeDBInstanceAttribute" ? detail : undefined;
  }, ONE_REGION);
}

function buckets(detail: Reply) {
  return makeClient((req) => {
    if (req.url.host === "oss-ap-southeast-1.aliyuncs.com") return { raw: OSS_LIST };
    return req.url.host === "b.oss-eu-central-1.aliyuncs.com" ? detail : undefined;
  }, ONE_REGION);
}

function ramUsers(action: string, detail: Reply) {
  return makeClient((req: Recorded) => {
    if (req.action === "ListUsers") {
      return { body: { Users: { User: [{ UserName: "ci" }] }, IsTruncated: false } };
    }
    if (req.action === action) return detail;
    return { body: {} };
  }, ONE_REGION);
}

describe("a detail read during a list", () => {
  it("fails the type on a security group's rules, so stored rows stay", async () => {
    await expect(
      securityGroups(FAILED).client.listResources("security-group", "acct"),
    ).rejects.toThrow("InternalError");
  });

  it("fails the type on an RDS attribute", async () => {
    await expect(rds(FAILED).client.listResources("rds-instance", "acct")).rejects.toThrow(
      "InternalError",
    );
  });

  it("fails the type on a bucket's info", async () => {
    const failed = { status: 500, raw: "<Error><Code>InternalError</Code></Error>" };
    await expect(buckets(failed).client.listResources("oss-bucket", "acct")).rejects.toThrow(
      "InternalError",
    );
  });

  it.each(["ListAccessKeys", "ListPoliciesForUser", "GetUser"])(
    "fails the type on a RAM user's %s",
    async (action) => {
      await expect(
        ramUsers(action, FAILED).client.listResources("ram-user", "acct"),
      ).rejects.toThrow("InternalError");
    },
  );

  it("leaves the fields out on a refusal or a row gone since the list", async () => {
    for (const reply of [REFUSED, GONE]) {
      const [group] = await securityGroups(reply).client.listResources("security-group", "acct");
      expect(group!.externalId).toBe("ap-southeast-1/sg-1");
      expect(group!.fields).not.toHaveProperty("adminPortsOpen");
    }
    const [db] = await rds(REFUSED).client.listResources("rds-instance", "acct");
    expect(db!.externalId).toBe("ap-southeast-1/rm-1");
    const [bucket] = await buckets({
      status: 403,
      raw: "<Error><Code>AccessDenied</Code></Error>",
    }).client.listResources("oss-bucket", "acct");
    expect(bucket!.fields).not.toHaveProperty("acl");
    const [user] = await ramUsers("ListAccessKeys", REFUSED).client.listResources(
      "ram-user",
      "acct",
    );
    expect(user!.fields).not.toHaveProperty("activeKeyCount");
  });

  it("still answers a single read of a RAM user, which may follow a write", async () => {
    const { client } = ramUsers("ListAccessKeys", FAILED);
    const user = await client.getResource("ram-user", "acct:ram-user:ci", "acct");
    expect(user.externalId).toBe("ci");
    expect(user.fields).not.toHaveProperty("activeKeyCount");
  });

  it("does not read a bad AccessKey's 404 as a row gone", async () => {
    await expect(
      securityGroups(BAD_KEY).client.listResources("security-group", "acct"),
    ).rejects.toThrow("InvalidAccessKeyId.NotFound");
  });
});
