import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";

const fetchSigned = vi.fn();
const ec2Call = vi.fn();
const ec2QueryCall = vi.fn();
const jsonCall = vi.fn();
const jsonGetCall = vi.fn();
const queryPostCall = vi.fn();
const hostForService = vi.fn((_c: unknown, s: string) => `${s}.us-east-1.amazonaws.com`);

vi.mock("../signed-request.js", () => ({ fetchSigned: (...a: unknown[]) => fetchSigned(...a) }));
vi.mock("../client-transport.js", () => ({
  ec2Call: (...a: unknown[]) => ec2Call(...a),
  ec2QueryCall: (...a: unknown[]) => ec2QueryCall(...a),
  jsonCall: (...a: unknown[]) => jsonCall(...a),
  jsonGetCall: (...a: unknown[]) => jsonGetCall(...a),
  queryPostCall: (...a: unknown[]) => queryPostCall(...a),
  hostForService: (...a: unknown[]) => hostForService(a[0], a[1] as string),
}));

import { deleteResource } from "../delete-handlers.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

function res(
  externalId: string,
  fields: Record<string, unknown> = {},
  ro: Record<string, unknown> = {},
): ResourceInstance {
  return {
    id: "id",
    pluginId: "aws",
    resourceTypeId: "t",
    accountId: "acct",
    displayName: "d",
    fields,
    resolvedOutputs: ro,
    secretStates: [],
    externalId,
    createdAt: "",
    updatedAt: "",
  } as ResourceInstance;
}

function ctx(resource: ResourceInstance) {
  return {
    creds,
    credsFor: (region: string) => ({ ...creds, region }),
    getResource: vi.fn(async () => resource),
  };
}

beforeEach(() => {
  fetchSigned.mockReset();
  ec2Call.mockReset();
  ec2QueryCall.mockReset();
  jsonCall.mockReset();
  jsonGetCall.mockReset();
  queryPostCall.mockReset();
  fetchSigned.mockResolvedValue({});
  ec2Call.mockResolvedValue({});
  ec2QueryCall.mockResolvedValue({});
  jsonCall.mockResolvedValue({});
  jsonGetCall.mockResolvedValue({});
  queryPostCall.mockResolvedValue({});
});

describe("deleteResource ec2-family (ec2Call)", () => {
  const cases: Array<[string, string]> = [
    ["ec2-instance", "TerminateInstances"],
    ["ebs-volume", "DeleteVolume"],
    ["vpc", "DeleteVpc"],
    ["subnet", "DeleteSubnet"],
    ["security-group", "DeleteSecurityGroup"],
    ["nat-gateway", "DeleteNatGateway"],
    ["elastic-ip", "ReleaseAddress"],
    ["internet-gateway", "DeleteInternetGateway"],
  ];
  for (const [typeId, action] of cases) {
    it(`${typeId} → ${action}`, async () => {
      await deleteResource(ctx(res("x-1", { region: "us-east-1" })), typeId, "rid", "acct");
      expect(ec2Call.mock.calls.some((c) => c[1] === action)).toBe(true);
    });
  }
});

describe("deleteResource json-rpc + query-post types", () => {
  it("s3-bucket", async () => {
    await deleteResource(ctx(res("bucket")), "s3-bucket", "rid", "acct");
    expect(jsonCall.mock.calls[0]![2]).toBe("AmazonS3.DeleteBucket");
  });
  it("sqs-queue uses queueUrl field", async () => {
    await deleteResource(ctx(res("q", { queueUrl: "https://q" })), "sqs-queue", "rid", "acct");
    expect((jsonCall.mock.calls[0]![3] as Record<string, string>)["QueueUrl"]).toBe("https://q");
  });
  it("sns-topic / dynamodb-table / secrets / ecr / cloudformation / ssm / logs / glue / acm / step / events / kinesis / apprunner / codebuild / codepipeline", async () => {
    const types = [
      "sns-topic",
      "dynamodb-table",
      "secrets-manager-secret",
      "ecr-repository",
      "cloudformation-stack",
      "ssm-parameter",
      "cloudwatch-log-group",
      "glue-database",
      "acm-certificate",
      "eventbridge-rule",
      "kinesis-stream",
      "codebuild-project",
      "codepipeline-pipeline",
    ];
    for (const t of types) {
      jsonCall.mockClear();
      await deleteResource(ctx(res("ext", { topicArn: "arn:t" })), t, "rid", "acct");
      expect(jsonCall).toHaveBeenCalled();
    }
  });
  it("step-function uses stateMachineArn", async () => {
    await deleteResource(
      ctx(res("ext", {}, { stateMachineArn: "arn:sm" })),
      "step-function",
      "rid",
      "acct",
    );
    expect((jsonCall.mock.calls[0]![3] as Record<string, string>)["stateMachineArn"]).toBe(
      "arn:sm",
    );
  });
  it("apprunner-service uses serviceArn", async () => {
    await deleteResource(
      ctx(res("ext", {}, { serviceArn: "arn:svc" })),
      "apprunner-service",
      "rid",
      "acct",
    );
    expect((jsonCall.mock.calls[0]![3] as Record<string, string>)["ServiceArn"]).toBe("arn:svc");
  });
  it("ecs-service splits cluster/service", async () => {
    await deleteResource(ctx(res("cluster/service")), "ecs-service", "rid", "acct");
    const body = jsonCall.mock.calls[0]![3] as Record<string, string>;
    expect(body["cluster"]).toBe("cluster");
    expect(body["service"]).toBe("service");
  });
  it("batch-job-queue disables then deletes", async () => {
    await deleteResource(ctx(res("jq")), "batch-job-queue", "rid", "acct");
    expect(jsonCall.mock.calls[0]![2]).toContain("UpdateJobQueue");
    expect(jsonCall.mock.calls[1]![2]).toContain("DeleteJobQueue");
  });
  it("queryPost types: elasticache / rds-instance / rds-cluster / neptune / documentdb / iam-user / iam-role", async () => {
    const types = [
      "elasticache-cluster",
      "rds-instance",
      "rds-cluster",
      "neptune-cluster",
      "documentdb-cluster",
      "iam-user",
      "iam-role",
    ];
    for (const t of types) {
      queryPostCall.mockClear();
      await deleteResource(ctx(res("ext")), t, "rid", "acct");
      expect(queryPostCall).toHaveBeenCalled();
    }
  });
  it("ec2QueryCall types: redshift / alb / target-group / auto-scaling-group", async () => {
    await deleteResource(ctx(res("c")), "redshift-cluster", "rid", "acct");
    await deleteResource(ctx(res("e", {}, { loadBalancerArn: "arn:lb" })), "alb", "rid", "acct");
    await deleteResource(
      ctx(res("e", {}, { targetGroupArn: "arn:tg" })),
      "target-group",
      "rid",
      "acct",
    );
    await deleteResource(ctx(res("asg")), "auto-scaling-group", "rid", "acct");
    expect(ec2QueryCall.mock.calls.map((c) => c[2])).toEqual(
      expect.arrayContaining([
        "DeleteCluster",
        "DeleteLoadBalancer",
        "DeleteTargetGroup",
        "DeleteAutoScalingGroup",
      ]),
    );
  });
  it("waf-web-acl fetches LockToken first", async () => {
    jsonCall.mockImplementation(async (_c, _s, target) => {
      if (String(target).endsWith("GetWebACL")) return { WebACL: {}, LockToken: "lock-1" };
      return {};
    });
    await deleteResource(ctx(res("acl", {}, { webAclId: "id-1" })), "waf-web-acl", "rid", "acct");
    const del = jsonCall.mock.calls.find((c) =>
      String(c[2]).endsWith("DeleteWebACL"),
    )![3] as Record<string, string>;
    expect(del["LockToken"]).toBe("lock-1");
  });
});

describe("deleteResource fetchSigned (REST) types", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["lambda-function", {}, {}],
    ["sagemaker-endpoint", {}, {}],
    ["opensearch-domain", {}, {}],
    ["route53-hosted-zone", {}, {}],
    ["efs-file-system", {}, {}],
    ["api-gateway", {}, {}],
    ["mq-broker", {}, {}],
    ["msk-cluster", {}, { clusterArn: "arn:msk" }],
  ];
  for (const [typeId, fields, ro] of cases) {
    it(`${typeId} issues a signed request`, async () => {
      await deleteResource(ctx(res("ext", fields, ro)), typeId, "rid", "acct");
      expect(fetchSigned).toHaveBeenCalled();
    });
  }
  it("route53-record-set builds a DELETE change batch", async () => {
    await deleteResource(
      ctx(res("zone:name:A", { ttl: 300, values: "1.2.3.4, 5.6.7.8" })),
      "route53-record-set",
      "rid",
      "acct",
    );
    const body = (fetchSigned.mock.calls[0]![0] as { body: string }).body;
    expect(body).toContain("<Action>DELETE</Action>");
    expect(body).toContain("1.2.3.4");
  });
});

describe("deleteResource eks-cluster", () => {
  afterEach(() => vi.useRealTimers());

  it("deletes inline when there are no node groups", async () => {
    jsonGetCall.mockResolvedValue({ nodegroups: [] });
    await deleteResource(ctx(res("my-cluster")), "eks-cluster", "rid", "acct");
    // a single signed DELETE to /clusters/my-cluster
    expect(fetchSigned).toHaveBeenCalledTimes(1);
    expect((fetchSigned.mock.calls[0]![0] as { url: string }).url).toContain(
      "/clusters/my-cluster",
    );
  });

  it("initiates node-group deletes and schedules background cluster delete", async () => {
    vi.useFakeTimers();
    jsonGetCall.mockResolvedValue({ nodegroups: ["ng1", "ng2"] });
    await deleteResource(ctx(res("c2")), "eks-cluster", "rid", "acct");
    // two node-group DELETEs initiated synchronously, cluster delete deferred
    const ngDeletes = fetchSigned.mock.calls.filter((c) =>
      (c[0] as { url: string }).url.includes("/node-groups/"),
    );
    expect(ngDeletes.length).toBe(2);
  });
});

describe("deleteResource unsupported", () => {
  it("throws", async () => {
    await expect(deleteResource(ctx(res("x")), "totally-unknown", "rid", "acct")).rejects.toThrow(
      /not supported/,
    );
  });
});
