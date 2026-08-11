import { describe, expect, it, vi } from "vitest";
import { QuotaAccessError } from "@infrawrench/plugin-base";
import {
  AWS_QUOTA_TARGETS,
  fetchAwsQuotas,
  pickQuotaUnit,
  resolveQuotaLimit,
  type AwsQuotaContext,
} from "../quotas.js";

/**
 * Recorded verbatim from the AWS CLI reference for `get-service-quota`
 * (https://docs.aws.amazon.com/cli/latest/reference/service-quotas/get-service-quota.html).
 * `GetAWSDefaultServiceQuota` returns the identical `ServiceQuota` object, so
 * this fixture stands in for both. Note `Unit: "None"` on a quota measured in
 * vCPUs — that is the norm, not an oddity, and it is why `pickQuotaUnit`
 * exists.
 */
const EC2_VCPU_QUOTA = {
  ServiceCode: "ec2",
  ServiceName: "Amazon Elastic Compute Cloud (Amazon EC2)",
  QuotaArn: "arn:aws:servicequotas:us-east-2:123456789012:ec2/L-1216C47A",
  QuotaCode: "L-1216C47A",
  QuotaName: "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances",
  Value: 1920.0,
  Unit: "None",
  Adjustable: true,
  GlobalQuota: false,
  UsageMetric: {
    MetricNamespace: "AWS/Usage",
    MetricName: "ResourceCount",
    MetricDimensions: {
      Class: "Standard/OnDemand",
      Resource: "vCPU",
      Service: "EC2",
      Type: "Resource",
    },
    MetricStatisticRecommendation: "Maximum",
  },
};

/** Same reference page, `list-service-quotas` — a quota with no usage metric. */
const VPC_QUOTA = {
  ServiceCode: "vpc",
  ServiceName: "Amazon Virtual Private Cloud (Amazon VPC)",
  QuotaArn: "arn:aws:servicequotas:us-east-2:123456789012:vpc/L-F678F1CE",
  QuotaCode: "L-F678F1CE",
  QuotaName: "VPCs per Region",
  Value: 5.0,
  Unit: "None",
  Adjustable: true,
  GlobalQuota: false,
};

const EIP_QUOTA = {
  ServiceCode: "ec2",
  ServiceName: "Amazon Elastic Compute Cloud (Amazon EC2)",
  QuotaCode: "L-0263D0A3",
  QuotaName: "EC2-VPC Elastic IPs",
  Value: 5.0,
  Unit: "None",
  Adjustable: true,
  GlobalQuota: false,
};

const QUOTAS_BY_CODE: Record<string, unknown> = {
  "L-1216C47A": EC2_VCPU_QUOTA,
  "L-F678F1CE": VPC_QUOTA,
  "L-0263D0A3": EIP_QUOTA,
};

interface CtxOverrides {
  regions?: string[];
  applied?: (region: string, quotaCode: string) => unknown[];
  usage?: number | null;
  addresses?: number;
  vpcs?: number;
}

function makeCtx(overrides: CtxOverrides = {}) {
  const listServiceQuotas = vi.fn(
    async (region: string, _serviceCode: string, quotaCode: string) => ({
      Quotas: overrides.applied
        ? overrides.applied(region, quotaCode)
        : [QUOTAS_BY_CODE[quotaCode]].filter(Boolean),
    }),
  );
  const getDefaultServiceQuota = vi.fn(
    async (_region: string, _serviceCode: string, quotaCode: string) => ({
      Quota: QUOTAS_BY_CODE[quotaCode],
    }),
  );
  const ctx: AwsQuotaContext = {
    regions: overrides.regions ?? ["eu-west-1"],
    listServiceQuotas: listServiceQuotas as never,
    getDefaultServiceQuota: getDefaultServiceQuota as never,
    usageMetric: vi.fn(async () => (overrides.usage === undefined ? 912 : overrides.usage)),
    countAddresses: vi.fn(async () => overrides.addresses ?? 4),
    countVpcs: vi.fn(async () => overrides.vpcs ?? 2),
  };
  return { ctx, listServiceQuotas, getDefaultServiceQuota };
}

describe("AWS_QUOTA_TARGETS", () => {
  // Getting the service code wrong returns an *empty list*, not an error, so
  // the failure mode is a quota that silently never appears. Elastic IPs live
  // under `ec2` despite the name; VPCs per Region live under `vpc`.
  it("pins the service code each quota actually lives under", () => {
    const byCode = new Map(AWS_QUOTA_TARGETS.map((t) => [t.quotaCode, t.serviceCode]));
    expect(byCode.get("L-1216C47A")).toBe("ec2");
    expect(byCode.get("L-0263D0A3")).toBe("ec2");
    expect(byCode.get("L-F678F1CE")).toBe("vpc");
  });
});

describe("pickQuotaUnit", () => {
  // "1,920 None" is what happens if the provider unit is trusted blindly.
  it("replaces AWS's placeholder unit with the target's own word", () => {
    expect(pickQuotaUnit("None", "vCPUs")).toBe("vCPUs");
    expect(pickQuotaUnit(undefined, "vCPUs")).toBe("vCPUs");
  });

  it("keeps a provider unit that says something real", () => {
    expect(pickQuotaUnit("Bytes", "vCPUs")).toBe("Bytes");
  });
});

describe("resolveQuotaLimit", () => {
  it("prefers the applied quota over the default", async () => {
    const { ctx, getDefaultServiceQuota } = makeCtx();
    const target = AWS_QUOTA_TARGETS.find((t) => t.quotaCode === "L-1216C47A")!;
    const quota = await resolveQuotaLimit(ctx, "eu-west-1", target);
    expect(quota?.Value).toBe(1920);
    expect(getDefaultServiceQuota).not.toHaveBeenCalled();
  });

  // AWS documents that ListServiceQuotas omits a quota whose applied value is
  // unavailable — which is every account that has never had an increase
  // approved. Reading that empty list as "no such quota" would switch the
  // radar off for exactly those accounts.
  it("falls back to the default quota when the applied list comes back empty", async () => {
    const { ctx, getDefaultServiceQuota } = makeCtx({ applied: () => [] });
    const target = AWS_QUOTA_TARGETS.find((t) => t.quotaCode === "L-1216C47A")!;
    const quota = await resolveQuotaLimit(ctx, "eu-west-1", target);
    expect(quota?.Value).toBe(1920);
    expect(getDefaultServiceQuota).toHaveBeenCalledOnce();
  });

  it("returns null when neither call names a usable ceiling", async () => {
    const ctx: AwsQuotaContext = {
      ...makeCtx().ctx,
      listServiceQuotas: (async () => ({ Quotas: [] })) as never,
      getDefaultServiceQuota: (async () => ({})) as never,
    };
    const target = AWS_QUOTA_TARGETS.find((t) => t.quotaCode === "L-1216C47A")!;
    await expect(resolveQuotaLimit(ctx, "eu-west-1", target)).resolves.toBeNull();
  });
});

describe("fetchAwsQuotas", () => {
  it("assembles the Service Quotas limit with the CloudWatch and describe usage", async () => {
    const { ctx } = makeCtx();
    const readings = await fetchAwsQuotas(ctx);

    expect(readings).toContainEqual({
      id: "ec2/L-1216C47A/eu-west-1",
      service: "ec2",
      name: "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances",
      region: "eu-west-1",
      limit: 1920,
      used: 912,
      unit: "vCPUs",
      adjustable: true,
      docsUrl: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-resource-limits.html",
    });
    expect(readings).toContainEqual(
      expect.objectContaining({ id: "ec2/L-0263D0A3/eu-west-1", used: 4, limit: 5 }),
    );
    expect(readings).toContainEqual(
      expect.objectContaining({ id: "vpc/L-F678F1CE/eu-west-1", used: 2, limit: 5 }),
    );
  });

  // The same quota code is a different ceiling in every region; one series per
  // code would average four regions into a number describing none of them.
  it("keys the reading on the region as well as the quota code", async () => {
    const { ctx } = makeCtx({ regions: ["eu-west-1", "us-east-1"] });
    const readings = await fetchAwsQuotas(ctx);
    const ids = readings.map((r) => r.id);
    expect(ids).toContain("ec2/L-1216C47A/eu-west-1");
    expect(ids).toContain("ec2/L-1216C47A/us-east-1");
    expect(new Set(ids).size).toBe(ids.length);
  });

  // An account with 30 enabled regions uses two or three. Storing 120 quotas
  // at 0% buries the four that matter, and a quota at zero usage is the one
  // case where the ceiling structurally cannot be the problem.
  it("skips a quota nothing is using, without asking for its limit", async () => {
    const { ctx, listServiceQuotas } = makeCtx({ usage: 0, addresses: 0, vpcs: 0 });
    await expect(fetchAwsQuotas(ctx)).resolves.toEqual([]);
    expect(listServiceQuotas).not.toHaveBeenCalled();
  });

  // Null is "CloudWatch published no datapoint" — the account has never run
  // one of these. Same outcome as zero, different reason, neither alertable.
  it("treats an absent CloudWatch datapoint as nothing to report", async () => {
    const { ctx } = makeCtx({ usage: null, addresses: 0, vpcs: 0 });
    await expect(fetchAwsQuotas(ctx)).resolves.toEqual([]);
  });

  it("raises a fixable access error when no regions could be resolved", async () => {
    const { ctx } = makeCtx({ regions: [] });
    await expect(fetchAwsQuotas(ctx)).rejects.toBeInstanceOf(QuotaAccessError);
  });

  // The host replaces its stored readings with what this returns, so a partial
  // list reads as quotas having disappeared — and a disappeared quota is one
  // nobody is watching any more.
  it("fails the whole fetch when one region fails", async () => {
    const { ctx } = makeCtx({ regions: ["eu-west-1", "us-east-1"] });
    ctx.countVpcs = (async (region: string) => {
      if (region === "us-east-1") throw new Error("AccessDenied");
      return 2;
    }) as never;
    await expect(fetchAwsQuotas(ctx)).rejects.toThrow("AccessDenied");
  });
});
