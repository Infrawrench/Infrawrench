import { describe, it, expect, vi } from "vitest";
import {
  capacityDeclarations,
  resolveCapacityLimit,
  type MetricSeries,
  type ResourceInstance,
  type ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import type { ListerContext } from "../resource-listers.js";
import type { MetricsContext } from "../metrics/cw-helpers.js";

// Listers sign their own requests; nothing here may reach AWS.
vi.mock("../signed-request.js", () => ({
  fetchSigned: () => {
    throw new Error("network disabled in tests");
  },
}));

import { listEKSClusters, listRDSInstances } from "../resource-listers.js";
import {
  listOpenSearchDomains,
  listRDSClusters,
  listSubnets,
  listWAFWebACLs,
} from "../resource-listers-extended.js";
import { subnetIpUsage } from "../resource-listers-extended/networking.js";
import {
  documentDbClusterMetrics,
  elastiCacheClusterMetrics,
  elastiCacheServerlessCacheMetrics,
  neptuneClusterMetrics,
  openSearchDomainMetrics,
  rdsClusterMetrics,
  rdsInstanceMetrics,
  redshiftClusterMetrics,
} from "../metrics/db-metrics.js";
import { eksClusterMetrics, lambdaFunctionMetrics } from "../metrics/compute-metrics.js";
import { mqBrokerMetrics, mskClusterMetrics } from "../metrics/messaging-metrics.js";
import { efsFileSystemMetrics } from "../metrics/storage-metrics.js";
import { RDSInstanceResourceType } from "../resources/rds-instance.js";
import { RDSClusterResourceType } from "../resources/rds-cluster.js";
import { ElastiCacheClusterResourceType } from "../resources/elasticache-cluster.js";
import { ElastiCacheServerlessCacheResourceType } from "../resources/elasticache-serverless-cache.js";
import { OpenSearchDomainResourceType } from "../resources/opensearch-domain.js";
import { MSKClusterResourceType } from "../resources/msk-cluster.js";
import { MQBrokerResourceType } from "../resources/mq-broker.js";
import { DocumentDBClusterResourceType } from "../resources/documentdb-cluster.js";
import { NeptuneClusterResourceType } from "../resources/neptune-cluster.js";
import { EKSClusterResourceType } from "../resources/eks-cluster.js";
import { LambdaFunctionResourceType } from "../resources/lambda-function.js";
import { EFSFileSystemResourceType } from "../resources/efs-file-system.js";
import { RedshiftClusterResourceType } from "../resources/redshift-cluster.js";
import { AutoScalingGroupResourceType } from "../resources/auto-scaling-group.js";
import { SubnetResourceType } from "../resources/subnet.js";
import { SQSQueueResourceType } from "../resources/sqs-queue.js";
import { Route53HostedZoneResourceType } from "../resources/route53-hosted-zone.js";
import { CloudWatchLogGroupResourceType } from "../resources/cloudwatch-log-group.js";
import { WAFWebACLResourceType } from "../resources/waf-web-acl.js";

const GIB = 1024 ** 3;
const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

function makeCtx(r: {
  ec2?: (action: string) => unknown;
  json?: (service: string, target: string) => unknown;
  jsonGet?: (service: string, path: string) => unknown;
  ec2Query?: (service: string, action: string) => unknown;
}): ListerContext {
  return {
    ec2: vi.fn(async (action) => r.ec2?.(action) ?? {}) as never,
    json: vi.fn(async (service, target) => r.json?.(service, target) ?? {}) as never,
    jsonGet: vi.fn(async (service, path) => r.jsonGet?.(service, path) ?? {}) as never,
    restJson: vi.fn(async () => ({})) as never,
    ec2Query: vi.fn(async (service, action) => r.ec2Query?.(service, action) ?? {}) as never,
    xmlGet: vi.fn(async () => ({})) as never,
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-11-23T00:00:00Z",
    region: "us-east-1",
    creds,
  };
}

/** A metrics context that answers each metric from `values` (one point at t=1). */
function metricsCtx(values: Record<string, number> = {}, fallback = 5): MetricsContext {
  return {
    creds,
    start: 0,
    end: 3600_000,
    period: 60,
    fetchCw: (async (_ns: string, metric: string) => ({
      label: metric,
      unit: "",
      points: [{ timestamp: 1, value: values[metric] ?? fallback }],
    })) as unknown as MetricsContext["fetchCw"],
  };
}

function res(
  fields: Record<string, unknown>,
  resolvedOutputs: Record<string, unknown> = {},
): ResourceInstance {
  return {
    id: "id",
    pluginId: "aws",
    resourceTypeId: "t",
    accountId: "acct",
    displayName: "d",
    fields,
    resolvedOutputs,
    secretStates: [],
    externalId: "ext",
    createdAt: "",
    updatedAt: "",
  } as ResourceInstance;
}

function series(out: MetricSeries[], label: string): MetricSeries {
  const found = out.find((s) => s.label === label);
  if (!found) throw new Error(`no series "${label}" in ${out.map((s) => s.label).join(", ")}`);
  return found;
}

describe("capacity fields from the listers", () => {
  it("RDS instance: the storage limit is the autoscaling maximum, else the allocated size", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        DescribeDBInstancesResult: {
          DBInstances: {
            DBInstance: [
              {
                DBInstanceIdentifier: "auto",
                Engine: "postgres",
                AllocatedStorage: "100",
                MaxAllocatedStorage: "1000",
              },
              { DBInstanceIdentifier: "fixed", Engine: "mysql", AllocatedStorage: "20" },
              { DBInstanceIdentifier: "aurora-1", Engine: "aurora-mysql", AllocatedStorage: "1" },
            ],
          },
        },
      }),
    });
    const out = await listRDSInstances(ctx, "acct");
    expect(out.find((r) => r.externalId === "auto")!.fields.storageLimitGb).toBe(1000);
    expect(out.find((r) => r.externalId === "fixed")!.fields.storageLimitGb).toBe(20);
    expect(out.find((r) => r.externalId === "aurora-1")!.fields).not.toHaveProperty(
      "storageLimitGb",
    );
  });

  it("RDS cluster: stores the Serverless v2 maximum ACUs, absent on provisioned", async () => {
    const ctx = makeCtx({
      ec2Query: () => ({
        DescribeDBClustersResult: {
          DBClusters: {
            DBCluster: [
              {
                DBClusterIdentifier: "sls",
                Engine: "aurora-postgresql",
                ServerlessV2ScalingConfiguration: { MinCapacity: "0.5", MaxCapacity: "16.5" },
              },
              { DBClusterIdentifier: "prov", Engine: "aurora-mysql" },
            ],
          },
        },
      }),
    });
    const out = await listRDSClusters(ctx, "acct");
    expect(out.find((r) => r.externalId === "sls")!.fields.maxAcu).toBe(16.5);
    expect(out.find((r) => r.externalId === "prov")!.fields).not.toHaveProperty("maxAcu");
  });

  it("OpenSearch: data storage is the EBS volume size across the data nodes", async () => {
    const ctx = makeCtx({
      jsonGet: (_s, path) => {
        if (path === "/2021-01-01/domain")
          return { DomainNames: [{ DomainName: "logs" }, { DomainName: "nvme" }] };
        if (path.endsWith("/logs"))
          return {
            DomainStatus: {
              ARN: "arn:aws:es:us-east-1:123456789012:domain/logs",
              ClusterConfig: { InstanceType: "r6g.large.search", InstanceCount: 3 },
              EBSOptions: { EBSEnabled: true, VolumeType: "gp3", VolumeSize: 100 },
            },
          };
        return {
          DomainStatus: {
            ClusterConfig: { InstanceType: "i3.large.search", InstanceCount: 2 },
            EBSOptions: { EBSEnabled: false },
          },
        };
      },
    });
    const out = await listOpenSearchDomains(ctx, "acct");
    expect(out.find((r) => r.externalId === "logs")!.fields.dataStorageGb).toBe(300);
    expect(out.find((r) => r.externalId === "nvme")!.fields).not.toHaveProperty("dataStorageGb");
  });

  it("subnet: IPv4 addresses in use against the CIDR less the five reserved", async () => {
    const ctx = makeCtx({
      ec2: () => ({
        subnetSet: {
          item: [
            { subnetId: "subnet-a", cidrBlock: "10.0.1.0/24", availableIpAddressCount: "200" },
            { subnetId: "subnet-v6", availableIpAddressCount: "0" },
          ],
        },
      }),
    });
    const out = await listSubnets(ctx, "acct");
    expect(out[0]!.fields.usableIps).toBe(251);
    expect(out[0]!.fields.usedIps).toBe(51);
    expect(out[1]!.fields).not.toHaveProperty("usedIps");
    expect(out[1]!.fields).not.toHaveProperty("usableIps");
    expect(subnetIpUsage("10.0.0.0/28", 0)).toEqual({ usableIps: 11, usedIps: 11 });
    expect(subnetIpUsage("10.0.0.0/16", undefined)).toEqual({});
  });

  it("EKS: sums node group maximums and reads the control plane tier", async () => {
    const ctx = makeCtx({
      jsonGet: (_s, path) => {
        if (path === "/clusters?maxResults=100") return { clusters: ["prod", "plain"] };
        if (path === "/clusters/prod")
          return {
            cluster: {
              status: "ACTIVE",
              endpoint: "https://eks.example.com",
              certificateAuthority: { data: "CA" },
              controlPlaneScalingConfig: { tier: "tier-xl" },
            },
          };
        if (path === "/clusters/plain")
          return {
            cluster: { status: "ACTIVE", endpoint: "e", certificateAuthority: { data: "CA" } },
          };
        if (path === "/clusters/prod/node-groups?maxResults=100") return { nodegroups: ["a", "b"] };
        if (path === "/clusters/prod/node-groups/a")
          return { nodegroup: { scalingConfig: { minSize: 1, desiredSize: 3, maxSize: 6 } } };
        if (path === "/clusters/prod/node-groups/b")
          return { nodegroup: { scalingConfig: { minSize: 1, desiredSize: 2, maxSize: 4 } } };
        if (path === "/clusters/plain/node-groups?maxResults=100") return { nodegroups: [] };
        return {};
      },
    });
    const out = await listEKSClusters(ctx, "acct");
    const prod = out.find((r) => r.externalId === "prod")!;
    expect(prod.fields.nodeCount).toBe(5);
    expect(prod.fields.maxNodeCount).toBe(10);
    expect(prod.fields.controlPlaneTier).toBe("tier-xl");
    const plain = out.find((r) => r.externalId === "plain")!;
    expect(plain.fields).not.toHaveProperty("maxNodeCount");
    expect(plain.fields.controlPlaneTier).toBe("standard");
  });

  it("WAF: a web ACL whose detail is refused stores no capacity rather than 0", async () => {
    const ctx = makeCtx({
      json: (_s, target) => {
        if (target.endsWith("ListWebACLs"))
          return { WebACLs: [{ Name: "edge", Id: "1", ARN: "arn:waf" }] };
        throw new Error("AccessDeniedException: not allowed");
      },
    });
    const out = await listWAFWebACLs(ctx, "acct");
    expect(out[0]!.fields).not.toHaveProperty("capacity");
  });
});

describe("capacity series from the metrics handlers", () => {
  it("RDS instance: storage used is the allocated size less free storage", async () => {
    const out = await rdsInstanceMetrics(
      metricsCtx({ FreeStorageSpace: 30 * GIB }),
      res({ dbInstanceId: "db", engine: "postgres", allocatedStorage: 100 }),
    );
    expect(series(out, "Storage Used").points[0]!.value).toBe(70 * GIB);
    const aurora = await rdsInstanceMetrics(
      metricsCtx({ FreeStorageSpace: 30 * GIB }),
      res({ dbInstanceId: "db", engine: "aurora-mysql", allocatedStorage: 1 }),
    );
    expect(aurora.map((s) => s.label)).not.toContain("Storage Used");
  });

  it("Aurora: the volume share comes from used and left bytes", async () => {
    const out = await rdsClusterMetrics(
      metricsCtx({ VolumeBytesUsed: 30, AuroraVolumeBytesLeftTotal: 70 }),
      res({ clusterIdentifier: "c" }),
    );
    expect(series(out, "% Volume Used").points[0]!.value).toBe(30);
    expect(series(out, "Serverless Capacity").unit).toBe("ACU");
  });

  it("Neptune: the volume share comes from used and left bytes", async () => {
    const out = await neptuneClusterMetrics(
      metricsCtx({ VolumeBytesUsed: 25, VolumeBytesLeftTotal: 75 }),
      res({ clusterIdentifier: "c" }),
    );
    expect(series(out, "% Volume Used").points[0]!.value).toBe(25);
  });

  it("OpenSearch: used space is converted from MiB and read under ClientId", async () => {
    const calls: unknown[][] = [];
    const ctx = metricsCtx({ ClusterUsedSpace: 2048 });
    const fetchCw = ctx.fetchCw;
    ctx.fetchCw = (async (...a: Parameters<MetricsContext["fetchCw"]>) => {
      calls.push(a);
      return fetchCw(...a);
    }) as MetricsContext["fetchCw"];
    const out = await openSearchDomainMetrics(
      ctx,
      res({ domainName: "logs" }, { domainArn: "arn:aws:es:us-east-1:123456789012:domain/logs" }),
    );
    expect(series(out, "Storage Used").points[0]!.value).toBe(2 * GIB);
    expect(calls[0]![2]).toEqual([
      { Name: "ClientId", Value: "123456789012" },
      { Name: "DomainName", Value: "logs" },
    ]);
  });
});

/**
 * Every declared metric usage names a series its type's handler emits, and
 * every declared limit resolves from a realistic stored row.
 */
describe("capacity declarations", () => {
  const fetchers: Array<{
    type: ResourceTypeDefinition;
    fetch: (ctx: MetricsContext, r: ResourceInstance) => Promise<MetricSeries[]>;
    fields: Record<string, unknown>;
  }> = [
    {
      type: RDSInstanceResourceType,
      fetch: rdsInstanceMetrics,
      fields: {
        dbInstanceId: "db",
        engine: "postgres",
        allocatedStorage: 100,
        storageLimitGb: 500,
      },
    },
    {
      type: RDSClusterResourceType,
      fetch: rdsClusterMetrics,
      fields: { clusterIdentifier: "c", maxAcu: 16 },
    },
    {
      type: ElastiCacheClusterResourceType,
      fetch: elastiCacheClusterMetrics,
      fields: { clusterId: "c" },
    },
    {
      type: ElastiCacheServerlessCacheResourceType,
      fetch: elastiCacheServerlessCacheMetrics,
      fields: { name: "c", maxDataStorageGb: 10, maxEcpuPerSecond: 5000 },
    },
    {
      type: OpenSearchDomainResourceType,
      fetch: openSearchDomainMetrics,
      fields: { domainName: "d", dataStorageGb: 300 },
    },
    {
      type: MSKClusterResourceType,
      fetch: mskClusterMetrics,
      fields: { clusterName: "k", numberOfBrokerNodes: 3 },
    },
    {
      type: DocumentDBClusterResourceType,
      fetch: documentDbClusterMetrics,
      fields: { clusterIdentifier: "c", engineVersion: "5.0.0" },
    },
    {
      type: NeptuneClusterResourceType,
      fetch: neptuneClusterMetrics,
      fields: { clusterIdentifier: "c" },
    },
    {
      type: EKSClusterResourceType,
      fetch: eksClusterMetrics,
      fields: { name: "prod", controlPlaneTier: "standard" },
    },
    {
      type: LambdaFunctionResourceType,
      fetch: lambdaFunctionMetrics,
      fields: { name: "fn", timeout: 30 },
    },
    {
      type: EFSFileSystemResourceType,
      fetch: efsFileSystemMetrics,
      fields: { fileSystemId: "fs-1" },
    },
    {
      type: RedshiftClusterResourceType,
      fetch: redshiftClusterMetrics,
      fields: { clusterIdentifier: "c" },
    },
  ];

  for (const { type, fetch, fields } of fetchers) {
    it(`${type.id}: every metric usage is an emitted series with a resolvable limit`, async () => {
      const metrics = capacityDeclarations(type).filter((d) => d.source === "metric");
      expect(metrics.length).toBeGreaterThan(0);
      const emitted = (await fetch(metricsCtx(), res(fields))).map((s) => s.label);
      for (const d of metrics) {
        expect(emitted).toContain(d.valueKey);
        expect(resolveCapacityLimit(d.declaration.limit, fields)).not.toBeNull();
      }
    });
  }

  it("MQ: both engines' usages are emitted series", async () => {
    const labels = capacityDeclarations(MQBrokerResourceType).map((d) => d.valueKey);
    const active = await mqBrokerMetrics(
      metricsCtx(),
      res({ brokerName: "b", engineType: "ACTIVEMQ" }),
    );
    const rabbit = await mqBrokerMetrics(
      metricsCtx(),
      res({ brokerName: "b", engineType: "RABBITMQ" }),
    );
    const emitted = [...active, ...rabbit].map((s) => s.label);
    for (const label of labels) expect(emitted).toContain(label);
  });

  it("limits resolve to the documented numbers", () => {
    const limit = (type: ResourceTypeDefinition, key: string, values: Record<string, unknown>) => {
      const d = capacityDeclarations(type).find((e) => e.key === key);
      if (!d) throw new Error(`${type.id} declares no ${key}`);
      return resolveCapacityLimit(d.declaration.limit, values)?.limit ?? null;
    };
    expect(limit(RDSInstanceResourceType, "metric:Storage Used", { storageLimitGb: 500 })).toBe(
      500 * GIB,
    );
    expect(
      limit(ElastiCacheServerlessCacheResourceType, "metric:Data Stored", { maxDataStorageGb: 10 }),
    ).toBe(10e9);
    // A serverless cache without a maximum stores 0: no limit, never a guess.
    expect(
      limit(ElastiCacheServerlessCacheResourceType, "metric:Data Stored", { maxDataStorageGb: 0 }),
    ).toBeNull();
    expect(limit(LambdaFunctionResourceType, "metric:Max Duration", { timeout: 30 })).toBe(30_000);
    expect(
      limit(DocumentDBClusterResourceType, "metric:Volume Used", { engineVersion: "8.0.0" }),
    ).toBe(256 * 1024 ** 4);
    expect(
      limit(DocumentDBClusterResourceType, "metric:Volume Used", { engineVersion: "9.9.9" }),
    ).toBeNull();
    expect(
      limit(EKSClusterResourceType, "metric:etcd Size Allocated", { controlPlaneTier: "standard" }),
    ).toBe(8 * GIB);
    expect(limit(EKSClusterResourceType, "nodeCount", { maxNodeCount: 10 })).toBe(10);
    expect(limit(AutoScalingGroupResourceType, "desiredCapacity", { maxSize: 8 })).toBe(8);
    expect(limit(SubnetResourceType, "usedIps", { usableIps: 251 })).toBe(251);
    expect(limit(SQSQueueResourceType, "approximateMessagesNotVisible", {})).toBe(120_000);
    expect(limit(Route53HostedZoneResourceType, "recordCount", {})).toBe(10_000);
    expect(limit(CloudWatchLogGroupResourceType, "metricFilterCount", {})).toBe(100);
    expect(limit(WAFWebACLResourceType, "capacity", {})).toBe(5_000);
  });
});
