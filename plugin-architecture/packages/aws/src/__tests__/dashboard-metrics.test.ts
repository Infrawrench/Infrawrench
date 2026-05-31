import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";

// Mock makeMetricsContext so fetchMetricSeries dispatch can be tested without IO.
const fetchCw = vi.fn(async (_ns: string, metric: string) => ({
  label: metric,
  unit: "",
  points: [{ timestamp: 1, value: 1 }],
}));
vi.mock("../metrics/cw-helpers.js", () => ({
  makeMetricsContext: () => ({
    creds: { accessKeyId: "A", secretAccessKey: "s", region: "us-east-1" },
    start: 0,
    end: 1,
    period: 60,
    fetchCw,
  }),
  callGetMetricStatistics: vi.fn(async () => ({
    label: "Bytes",
    datapoints: [{ Timestamp: "2020-01-01T00:00:00Z", Average: 1 }],
  })),
}));

import { fetchDashboardStats, fetchMetricSeries } from "../dashboard-metrics.js";

const creds = { accessKeyId: "A", secretAccessKey: "s", region: "us-east-1" };

function res(
  fields: Record<string, unknown>,
  ro: Record<string, unknown> = {},
  externalId = "ext",
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

describe("fetchDashboardStats", () => {
  it("ec2-instance running adds public ip when present", () => {
    const out = fetchDashboardStats(
      res(
        { state: "running", instanceType: "t3.micro", availabilityZone: "us-east-1a" },
        { publicIp: "1.2.3.4" },
      ),
      "ec2-instance",
    );
    expect(out.find((s) => s.label === "State")!.variant).toBe("status-healthy");
    expect(out.find((s) => s.label === "Public IP")!.value).toBe("1.2.3.4");
  });
  it("ec2-instance stopped is error variant, no public ip", () => {
    const out = fetchDashboardStats(res({ state: "stopped" }), "ec2-instance");
    expect(out.find((s) => s.label === "State")!.variant).toBe("status-error");
    expect(out.find((s) => s.label === "Public IP")).toBeUndefined();
  });
  it("ec2-instance pending is degraded", () => {
    const out = fetchDashboardStats(res({ state: "pending" }), "ec2-instance");
    expect(out.find((s) => s.label === "State")!.variant).toBe("status-degraded");
  });
  it("rds-instance variants", () => {
    expect(fetchDashboardStats(res({ status: "available" }), "rds-instance")[0]!.variant).toBe(
      "status-healthy",
    );
    expect(fetchDashboardStats(res({ status: "stopped" }), "rds-instance")[0]!.variant).toBe(
      "status-error",
    );
    expect(fetchDashboardStats(res({ status: "modifying" }), "rds-instance")[0]!.variant).toBe(
      "status-degraded",
    );
  });
  it("lambda-function + s3-bucket + eks-cluster", () => {
    expect(fetchDashboardStats(res({ runtime: "nodejs20.x" }), "lambda-function").length).toBe(3);
    expect(fetchDashboardStats(res({ region: "us-east-1" }), "s3-bucket").length).toBe(1);
    const eks = fetchDashboardStats(res({ status: "ACTIVE", version: "1.29" }), "eks-cluster");
    expect(eks.find((s) => s.label === "Status")!.variant).toBe("status-healthy");
    const eks2 = fetchDashboardStats(res({ status: "CREATING" }), "eks-cluster");
    expect(eks2.find((s) => s.label === "Status")!.variant).toBe("status-degraded");
  });
  it("generic fallback maps status/type/region with all variant branches", () => {
    const healthy = fetchDashboardStats(
      res({ status: "running", engine: "x", region: "r" }),
      "unknown-thing",
    );
    expect(healthy.find((s) => s.label === "Status")!.variant).toBe("status-healthy");
    expect(healthy.find((s) => s.label === "Type")).toBeTruthy();
    expect(healthy.find((s) => s.label === "Region")).toBeTruthy();
    expect(fetchDashboardStats(res({ phase: "failed" }), "x")[0]!.variant).toBe("status-error");
    expect(fetchDashboardStats(res({ state: "creating" }), "x")[0]!.variant).toBe(
      "status-degraded",
    );
    expect(fetchDashboardStats(res({ status: "weird" }), "x")[0]!.variant).toBe("default");
    expect(fetchDashboardStats(res({}), "x")).toEqual([]);
  });
  it("generic fallback uses alternate type/region keys", () => {
    const out = fetchDashboardStats(res({ machineType: "m", location: "l" }), "x");
    expect(out.find((s) => s.label === "Type")!.value).toBe("m");
    expect(out.find((s) => s.label === "Region")!.value).toBe("l");
  });
});

describe("fetchMetricSeries dispatch", () => {
  beforeEach(() => fetchCw.mockClear());

  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    ["ec2-instance", {}, {}, "i-1"],
    ["rds-instance", { dbInstanceId: "db" }, {}, "db"],
    ["lambda-function", { name: "fn" }, {}, "fn"],
    ["alb", {}, { loadBalancerArn: "x:loadbalancer/app/lb/a" }, "e"],
    ["dynamodb-table", { tableName: "T" }, {}, "T"],
    ["sqs-queue", { queueUrl: "https://q/acct/q1" }, {}, "e"],
    ["ecs-service", { clusterName: "c", serviceName: "s" }, {}, "e"],
    ["s3-bucket", { name: "b" }, {}, "b"],
    ["auto-scaling-group", { name: "asg" }, {}, "asg"],
    ["elasticache-cluster", { clusterId: "c" }, {}, "c"],
    ["rds-cluster", { clusterIdentifier: "c" }, {}, "c"],
    ["cloudfront-distribution", {}, {}, "D1"],
    ["api-gateway", { apiId: "a" }, {}, "a"],
    ["sns-topic", {}, { topicArn: "arn:aws:sns:r:1:t" }, "t"],
    ["kinesis-stream", { streamName: "s" }, {}, "s"],
    ["opensearch-domain", { domainName: "d" }, {}, "d"],
    ["nat-gateway", {}, {}, "nat-1"],
    ["ebs-volume", { volumeId: "vol" }, {}, "vol"],
    ["efs-file-system", { fileSystemId: "fs" }, {}, "fs"],
    ["step-function", {}, { stateMachineArn: "arn:sm" }, "sm"],
    ["redshift-cluster", { clusterIdentifier: "c" }, {}, "c"],
    ["documentdb-cluster", { clusterIdentifier: "c" }, {}, "c"],
    ["neptune-cluster", { clusterIdentifier: "c" }, {}, "c"],
    ["mq-broker", { brokerName: "b" }, {}, "b"],
    ["msk-cluster", { clusterName: "c" }, {}, "c"],
    ["sagemaker-endpoint", { endpointName: "ep" }, {}, "ep"],
    ["codebuild-project", { name: "p" }, {}, "p"],
    ["cloudwatch-log-group", { logGroupName: "lg" }, {}, "lg"],
    ["waf-web-acl", { name: "acl" }, {}, "acl"],
    ["apprunner-service", { serviceName: "svc" }, {}, "svc"],
    ["target-group", {}, { targetGroupArn: "y:targetgroup/tg/d" }, "tg"],
    ["route53-health-check", { healthCheckId: "hc" }, {}, "hc"],
    ["backup-vault", { backupVaultName: "v" }, {}, "v"],
  ];

  for (const [typeId, fields, ro, ext] of cases) {
    it(`dispatches ${typeId}`, async () => {
      const out = await fetchMetricSeries(creds, res(fields, ro, ext), typeId);
      expect(Array.isArray(out)).toBe(true);
      expect(out.length).toBeGreaterThan(0);
    });
  }

  it("returns [] for unknown type", async () => {
    expect(await fetchMetricSeries(creds, res({}), "nope")).toEqual([]);
  });
});
