import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { MetricsContext } from "../metrics/cw-helpers.js";

import {
  ec2InstanceMetrics,
  lambdaFunctionMetrics,
  autoScalingGroupMetrics,
  ebsVolumeMetrics,
  ecsServiceMetrics,
  appRunnerServiceMetrics,
} from "../metrics/compute-metrics.js";
import {
  rdsInstanceMetrics,
  rdsClusterMetrics,
  dynamoDbTableMetrics,
  elastiCacheClusterMetrics,
  redshiftClusterMetrics,
  openSearchDomainMetrics,
  documentDbClusterMetrics,
  neptuneClusterMetrics,
} from "../metrics/db-metrics.js";
import {
  albMetrics,
  targetGroupMetrics,
  cloudFrontDistributionMetrics,
  apiGatewayMetrics,
  natGatewayMetrics,
  route53HealthCheckMetrics,
} from "../metrics/networking-metrics.js";
import {
  sqsQueueMetrics,
  snsTopicMetrics,
  kinesisStreamMetrics,
  mskClusterMetrics,
  mqBrokerMetrics,
  stepFunctionMetrics,
} from "../metrics/messaging-metrics.js";
import { efsFileSystemMetrics, backupVaultMetrics } from "../metrics/storage-metrics.js";
import {
  sageMakerEndpointMetrics,
  codeBuildProjectMetrics,
  cloudWatchLogGroupMetrics,
  wafWebAclMetrics,
} from "../metrics/misc-metrics.js";

// s3 metrics use callGetMetricStatistics directly, so mock the cw-helpers module
// for that one test rather than supplying a fetchCw.
const callGetMetricStatistics = vi.fn();
vi.mock("../metrics/cw-helpers.js", async (orig) => {
  const actual = await orig<typeof import("../metrics/cw-helpers.js")>();
  return {
    ...actual,
    callGetMetricStatistics: (...a: unknown[]) => callGetMetricStatistics(...a),
  };
});

import { s3BucketMetrics } from "../metrics/storage-metrics.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

/** A MetricsContext whose fetchCw always returns one datapoint, recording calls. */
function ctxWithData(): { ctx: MetricsContext; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fetchCw = vi.fn(async (ns, metric, dims, stat, options) => {
    calls.push([ns, metric, dims, stat, options]);
    return {
      label: metric,
      unit: "Count",
      points: [{ timestamp: 1, value: 5 }],
    };
  });
  const ctx: MetricsContext = {
    creds,
    start: 0,
    end: 3600_000,
    period: 60,
    fetchCw: fetchCw as unknown as MetricsContext["fetchCw"],
  };
  return { ctx, calls };
}

/** A MetricsContext whose fetchCw returns empty series (drops everything). */
function ctxEmpty(): MetricsContext {
  return {
    creds,
    start: 0,
    end: 3600_000,
    period: 60,
    fetchCw: (async (_ns, metric) => ({
      label: metric,
      unit: "",
      points: [],
    })) as MetricsContext["fetchCw"],
  };
}

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

describe("compute metrics", () => {
  it("ec2InstanceMetrics returns every series when data present", async () => {
    const { ctx } = ctxWithData();
    const out = await ec2InstanceMetrics(ctx, res({}, {}, "i-1"));
    expect(out.length).toBeGreaterThan(10);
    expect(out.some((s) => s.unit === "%")).toBe(true);
  });
  it("lambdaFunctionMetrics empty when no name", async () => {
    const { ctx } = ctxWithData();
    expect(await lambdaFunctionMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("lambdaFunctionMetrics returns series with name", async () => {
    const { ctx } = ctxWithData();
    const out = await lambdaFunctionMetrics(ctx, res({ name: "fn" }));
    expect(out.find((s) => s.label === "Invocations")).toBeTruthy();
  });
  it("autoScalingGroupMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await autoScalingGroupMetrics(ctx, res({ name: "asg" }))).length).toBe(3);
    expect(await autoScalingGroupMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("ebsVolumeMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await ebsVolumeMetrics(ctx, res({ volumeId: "vol-1" }))).length).toBe(5);
    expect(await ebsVolumeMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("ecsServiceMetrics needs both cluster + service", async () => {
    const { ctx } = ctxWithData();
    expect(await ecsServiceMetrics(ctx, res({ serviceName: "s" }))).toEqual([]);
    const out = await ecsServiceMetrics(ctx, res({ clusterName: "c", serviceName: "s" }));
    expect(out.length).toBe(2);
  });
  it("appRunnerServiceMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await appRunnerServiceMetrics(ctx, res({ serviceName: "svc" }))).length).toBe(8);
    expect(await appRunnerServiceMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("drops empty series", async () => {
    const out = await ec2InstanceMetrics(ctxEmpty(), res({}, {}, "i-1"));
    expect(out).toEqual([]);
  });
});

describe("db metrics", () => {
  it("rdsInstanceMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await rdsInstanceMetrics(ctx, res({ dbInstanceId: "db" }))).length).toBeGreaterThan(10);
    expect(await rdsInstanceMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("rdsClusterMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await rdsClusterMetrics(ctx, res({ clusterIdentifier: "c" }))).length).toBeGreaterThan(
      10,
    );
    expect(await rdsClusterMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("dynamoDbTableMetrics uses tableName or externalId", async () => {
    const { ctx } = ctxWithData();
    expect((await dynamoDbTableMetrics(ctx, res({ tableName: "T" }))).length).toBe(4);
  });
  it("elastiCacheClusterMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await elastiCacheClusterMetrics(ctx, res({ clusterId: "c" }))).length).toBeGreaterThan(
      10,
    );
    expect(await elastiCacheClusterMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("redshiftClusterMetrics", async () => {
    const { ctx } = ctxWithData();
    expect(
      (await redshiftClusterMetrics(ctx, res({ clusterIdentifier: "c" }))).length,
    ).toBeGreaterThan(10);
    expect(await redshiftClusterMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("openSearchDomainMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await openSearchDomainMetrics(ctx, res({ domainName: "d" }))).length).toBeGreaterThan(
      10,
    );
    expect(await openSearchDomainMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("documentDbClusterMetrics", async () => {
    const { ctx } = ctxWithData();
    expect(
      (await documentDbClusterMetrics(ctx, res({ clusterIdentifier: "c" }))).length,
    ).toBeGreaterThan(10);
    expect(await documentDbClusterMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("neptuneClusterMetrics", async () => {
    const { ctx } = ctxWithData();
    expect(
      (await neptuneClusterMetrics(ctx, res({ clusterIdentifier: "c" }))).length,
    ).toBeGreaterThan(10);
    expect(await neptuneClusterMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
});

describe("networking metrics", () => {
  it("albMetrics parses arn", async () => {
    const { ctx } = ctxWithData();
    const out = await albMetrics(
      ctx,
      res({}, { loadBalancerArn: "arn:...:loadbalancer/app/lb/abc" }),
    );
    expect(out.length).toBeGreaterThan(10);
    expect(await albMetrics(ctx, res({}, { loadBalancerArn: "" }))).toEqual([]);
  });
  it("targetGroupMetrics with and without LB arn", async () => {
    const { ctx, calls } = ctxWithData();
    const withLb = await targetGroupMetrics(
      ctx,
      res(
        { loadBalancerArn: "x:loadbalancer/app/lb/abc" },
        { targetGroupArn: "y:targetgroup/tg/def" },
      ),
    );
    expect(withLb.length).toBe(5);
    expect((calls[0]![2] as unknown[]).length).toBe(2); // both dims
    const { ctx: ctx2 } = ctxWithData();
    const noLb = await targetGroupMetrics(
      ctx2,
      res({}, { targetGroupArn: "y:targetgroup/tg/def" }),
    );
    expect(noLb.length).toBe(5);
    expect(await targetGroupMetrics(ctx, res({}, { targetGroupArn: "" }))).toEqual([]);
  });
  it("cloudFrontDistributionMetrics uses us-east-1 override", async () => {
    const { ctx, calls } = ctxWithData();
    const out = await cloudFrontDistributionMetrics(ctx, res({}, {}, "D1"));
    expect(out.length).toBeGreaterThan(5);
    expect(calls[0]![4]).toEqual({ regionOverride: "us-east-1" });
    expect(await cloudFrontDistributionMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("apiGatewayMetrics REST vs HTTP dims", async () => {
    const { ctx, calls } = ctxWithData();
    await apiGatewayMetrics(ctx, res({ protocolType: "REST", name: "MyApi" }));
    expect((calls[0]![2] as { Name: string }[])[0]!.Name).toBe("ApiName");
    const { ctx: c2, calls: calls2 } = ctxWithData();
    await apiGatewayMetrics(c2, res({ apiId: "abc" }, {}, ""));
    expect((calls2[0]![2] as { Name: string }[])[0]!.Name).toBe("ApiId");
    const { ctx: c3 } = ctxWithData();
    expect(await apiGatewayMetrics(c3, res({}, {}, ""))).toEqual([]);
  });
  it("natGatewayMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await natGatewayMetrics(ctx, res({}, {}, "nat-1"))).length).toBe(3);
    expect(await natGatewayMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("route53HealthCheckMetrics", async () => {
    const { ctx, calls } = ctxWithData();
    const out = await route53HealthCheckMetrics(ctx, res({ healthCheckId: "hc" }));
    expect(out.length).toBe(4);
    expect(calls[0]![4]).toEqual({ regionOverride: "us-east-1" });
    expect(await route53HealthCheckMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
});

describe("messaging metrics", () => {
  it("sqsQueueMetrics derives name from url", async () => {
    const { ctx } = ctxWithData();
    expect((await sqsQueueMetrics(ctx, res({ queueUrl: "https://sqs/acct/q1" }))).length).toBe(9);
    expect(await sqsQueueMetrics(ctx, res({}))).toEqual([]);
  });
  it("snsTopicMetrics derives name from arn", async () => {
    const { ctx } = ctxWithData();
    expect((await snsTopicMetrics(ctx, res({}, { topicArn: "arn:aws:sns:r:1:t1" }))).length).toBe(
      6,
    );
    expect(await snsTopicMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("kinesisStreamMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await kinesisStreamMetrics(ctx, res({ streamName: "s" }))).length).toBe(11);
    expect(await kinesisStreamMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("mskClusterMetrics", async () => {
    const { ctx, calls } = ctxWithData();
    expect((await mskClusterMetrics(ctx, res({ clusterName: "c" }))).length).toBe(4);
    expect((calls[0]![2] as { Name: string }[])[0]!.Name).toBe("Cluster Name");
    expect(await mskClusterMetrics(ctx, res({}))).toEqual([]);
  });
  it("mqBrokerMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await mqBrokerMetrics(ctx, res({ brokerName: "b" }))).length).toBe(3);
    expect(await mqBrokerMetrics(ctx, res({}))).toEqual([]);
  });
  it("stepFunctionMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await stepFunctionMetrics(ctx, res({}, { stateMachineArn: "arn:sm" }))).length).toBe(7);
    expect(await stepFunctionMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
});

describe("storage metrics", () => {
  beforeEach(() => callGetMetricStatistics.mockReset());

  it("efsFileSystemMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await efsFileSystemMetrics(ctx, res({ fileSystemId: "fs" }))).length).toBe(4);
    expect(await efsFileSystemMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("backupVaultMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await backupVaultMetrics(ctx, res({ backupVaultName: "v" }))).length).toBe(5);
    expect(await backupVaultMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("s3BucketMetrics calls callGetMetricStatistics with daily period", async () => {
    callGetMetricStatistics.mockResolvedValue({
      label: "Bytes",
      datapoints: [{ Timestamp: "2020-01-01T00:00:00Z", Average: "100" }],
    });
    const { ctx } = ctxWithData();
    const out = await s3BucketMetrics(ctx, res({ name: "bucket" }));
    expect(out.length).toBe(2);
    expect(out.find((s) => s.label === "Bucket Size")).toBeTruthy();
    const callArgs = callGetMetricStatistics.mock.calls[0]![1] as { Period: number };
    expect(callArgs.Period).toBe(86_400);
  });
  it("s3BucketMetrics empty when no bucket name", async () => {
    const { ctx } = ctxWithData();
    expect(await s3BucketMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("s3BucketMetrics drops series when datapoints empty", async () => {
    callGetMetricStatistics.mockResolvedValue({ label: "", datapoints: [] });
    const { ctx } = ctxWithData();
    expect(await s3BucketMetrics(ctx, res({ name: "bucket" }))).toEqual([]);
  });
});

describe("misc metrics", () => {
  it("sageMakerEndpointMetrics", async () => {
    const { ctx, calls } = ctxWithData();
    const out = await sageMakerEndpointMetrics(ctx, res({ endpointName: "ep" }));
    expect(out.length).toBe(5);
    expect((calls[0]![2] as { Name: string }[])[1]!.Name).toBe("VariantName");
    expect(await sageMakerEndpointMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("codeBuildProjectMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await codeBuildProjectMetrics(ctx, res({ name: "p" }))).length).toBe(4);
    expect(await codeBuildProjectMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("cloudWatchLogGroupMetrics", async () => {
    const { ctx } = ctxWithData();
    expect((await cloudWatchLogGroupMetrics(ctx, res({ logGroupName: "lg" }))).length).toBe(2);
    expect(await cloudWatchLogGroupMetrics(ctx, res({}, {}, ""))).toEqual([]);
  });
  it("wafWebAclMetrics regional + cloudfront scope", async () => {
    const { ctx, calls } = ctxWithData();
    await wafWebAclMetrics(ctx, res({ name: "acl", scope: "REGIONAL", region: "us-west-2" }));
    expect((calls[0]![2] as { Name: string; Value: string }[])[2]!.Value).toBe("us-west-2");
    const { ctx: c2, calls: calls2 } = ctxWithData();
    await wafWebAclMetrics(c2, res({ name: "acl", scope: "CLOUDFRONT" }));
    expect((calls2[0]![2] as { Name: string; Value: string }[])[2]!.Value).toBe("CloudFront");
    const { ctx: c3 } = ctxWithData();
    expect(await wafWebAclMetrics(c3, res({}))).toEqual([]);
  });
});
