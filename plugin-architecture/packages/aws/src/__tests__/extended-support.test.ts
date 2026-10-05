import { describe, expect, it } from "vitest";
import { resourceTypeDefinitionSchema } from "@infrawrench/plugin-base";
import {
  EKS_EXTENDED_SUPPORT,
  RDS_EXTENDED_SUPPORT,
  classifyExtendedSupportUsageType,
  openSearchNormalizedUnits,
  rdsInstanceClassVcpus,
} from "../extended-support.js";
import { EKSClusterResourceType } from "../resources/eks-cluster.js";
import { RDSInstanceResourceType } from "../resources/rds-instance.js";
import { ElastiCacheClusterResourceType } from "../resources/elasticache-cluster.js";
import { OpenSearchDomainResourceType } from "../resources/opensearch-domain.js";

describe("rdsInstanceClassVcpus", () => {
  it("reads the vCPU count RDS Extended Support bills on", () => {
    expect(rdsInstanceClassVcpus("db.r6g.large")).toBe(2);
    expect(rdsInstanceClassVcpus("db.m5.xlarge")).toBe(4);
    expect(rdsInstanceClassVcpus("db.r6g.2xlarge")).toBe(8);
    expect(rdsInstanceClassVcpus("db.r5.24xlarge")).toBe(96);
    expect(rdsInstanceClassVcpus("db.t3.micro")).toBe(2);
    expect(rdsInstanceClassVcpus("db.t2.micro")).toBe(1);
    expect(rdsInstanceClassVcpus("db.t3.medium")).toBe(2);
  });

  it("returns null rather than guessing", () => {
    expect(rdsInstanceClassVcpus("db.serverless")).toBeNull();
    expect(rdsInstanceClassVcpus("db.m6i.metal")).toBeNull();
    expect(rdsInstanceClassVcpus("")).toBeNull();
  });
});

describe("openSearchNormalizedUnits", () => {
  it("multiplies the size factor by the node count", () => {
    expect(openSearchNormalizedUnits("r6g.large.search", 3)).toBe(12);
    expect(openSearchNormalizedUnits("m5.2xlarge.elasticsearch", 2)).toBe(32);
    expect(openSearchNormalizedUnits("t3.small.search", 1)).toBe(1);
    expect(openSearchNormalizedUnits("r6g.large.search", 0)).toBeNull();
    expect(openSearchNormalizedUnits("weird", 2)).toBeNull();
  });
});

describe("classifyExtendedSupportUsageType", () => {
  it("places the documented usage types", () => {
    expect(classifyExtendedSupportUsageType("USE1-AmazonEKS-Hours:extendedSupport")).toEqual({
      resourceTypeId: "eks-cluster",
    });
    expect(classifyExtendedSupportUsageType("AmazonEKS-Hours:extendedSupport")).toEqual({
      resourceTypeId: "eks-cluster",
    });
    expect(classifyExtendedSupportUsageType("ExtendedSupport:Yr3:MySQL5.7")).toEqual({
      resourceTypeId: "rds-instance",
      engine: "mysql",
      releaseId: "mysql-5.7",
    });
    expect(classifyExtendedSupportUsageType("EU-ExtendedSupport:Yr1-Yr2:PostgreSQL12")).toEqual({
      resourceTypeId: "rds-instance",
      engine: "postgres",
      releaseId: "postgres-12",
    });
    expect(classifyExtendedSupportUsageType("ExtendedSupport:Yr1-Yr2:AuroraMySQL2")).toEqual({
      resourceTypeId: "rds-instance",
      engine: "aurora-mysql",
      releaseId: "aurora-mysql-2",
    });
    expect(
      classifyExtendedSupportUsageType("ExtendedSupport:Yr1-Yr2:ASv2:AuroraPostgreSQL13"),
    ).toEqual({
      resourceTypeId: "rds-instance",
      engine: "aurora-postgresql",
      releaseId: "aurora-postgresql-13",
    });
  });

  it("leaves unknown shapes unplaced so the host lists them as unattributed", () => {
    expect(classifyExtendedSupportUsageType("USE1-NodeUsage:cache.m5.large")).toEqual({});
  });

  it("only names release ids the RDS calendar declares (or none)", () => {
    const ids = new Set(RDS_EXTENDED_SUPPORT.releases.map((r) => r.id));
    for (const ut of [
      "ExtendedSupport:Yr3:MySQL5.7",
      "ExtendedSupport:Yr1-Yr2:MySQL8.0",
      "ExtendedSupport:Yr1-Yr2:PostgreSQL11",
      "ExtendedSupport:Yr1-Yr2:PostgreSQL13",
      "ExtendedSupport:Yr1-Yr2:AuroraPostgreSQL12",
    ]) {
      expect(ids.has(classifyExtendedSupportUsageType(ut).releaseId!)).toBe(true);
    }
  });
});

describe("declarations", () => {
  it("validate against the manifest schema", () => {
    for (const type of [
      EKSClusterResourceType,
      RDSInstanceResourceType,
      ElastiCacheClusterResourceType,
      OpenSearchDomainResourceType,
    ]) {
      const result = resourceTypeDefinitionSchema.safeParse(type);
      expect(result.success, `${type.id}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it("price EKS extended support as the $0.50 surcharge over the standard fee", () => {
    const tiers = EKS_EXTENDED_SUPPORT.releases.map((r) => r.surcharge!.tiers[0]!);
    expect(tiers.every((t) => t.rate === 0.5)).toBe(true);
    // The surcharge starts the day after standard support ends.
    const r130 = EKS_EXTENDED_SUPPORT.releases.find((r) => r.id === "k8s-1.30")!;
    expect(r130.surcharge!.tiers[0]!.from).toBe("2025-07-23");
  });
});
