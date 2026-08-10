import { beforeEach, describe, expect, it, vi } from "vitest";

import { estimateAwsCost } from "../cost-estimate.js";
import type { AwsCredentials } from "../auth.js";

const fetchEc2MonthlyPrice = vi.fn<(...a: unknown[]) => Promise<number | null>>();
const fetchEbsGbMonthPrice = vi.fn<(...a: unknown[]) => Promise<number | null>>();
const fetchRdsMonthlyPrice = vi.fn<(...a: unknown[]) => Promise<number | null>>();
const fetchRdsStorageGbMonthPrice = vi.fn<(...a: unknown[]) => Promise<number | null>>();

vi.mock("../pricing.js", () => ({
  fetchEc2MonthlyPrice: (...a: unknown[]) => fetchEc2MonthlyPrice(...a),
  fetchEbsGbMonthPrice: (...a: unknown[]) => fetchEbsGbMonthPrice(...a),
  fetchRdsMonthlyPrice: (...a: unknown[]) => fetchRdsMonthlyPrice(...a),
  fetchRdsStorageGbMonthPrice: (...a: unknown[]) => fetchRdsStorageGbMonthPrice(...a),
}));

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" } as AwsCredentials;

beforeEach(() => {
  vi.resetAllMocks();
  fetchEc2MonthlyPrice.mockResolvedValue(null);
  fetchEbsGbMonthPrice.mockResolvedValue(null);
  fetchRdsMonthlyPrice.mockResolvedValue(null);
  fetchRdsStorageGbMonthPrice.mockResolvedValue(null);
});

describe("estimateAwsCost — ec2-instance", () => {
  it("itemizes the instance and its root volume, and totals to their sum", async () => {
    fetchEc2MonthlyPrice.mockResolvedValue(30.37);
    fetchEbsGbMonthPrice.mockResolvedValue(0.08);
    const est = await estimateAwsCost(creds, "ec2-instance", {
      region: "eu-central-1",
      instanceType: "t3.medium",
      diskSizeGb: "40",
    });
    expect(est?.monthlyAmount).toBeCloseTo(30.37 + 40 * 0.08, 2);
    expect(est?.lineItems.map((l) => l.label)).toEqual([
      "Instance (t3.medium)",
      "Root volume (gp3)",
    ]);
    expect(est?.partial).toBeUndefined();
  });

  it("prices per selected region, not the account's home region", async () => {
    fetchEc2MonthlyPrice.mockResolvedValue(1);
    await estimateAwsCost(creds, "ec2-instance", {
      region: "ap-northeast-1",
      instanceType: "t3.medium",
    });
    expect(fetchEc2MonthlyPrice).toHaveBeenCalledWith(creds, "ap-northeast-1", "t3.medium");
  });

  it("falls back to the account's region when the form has none", async () => {
    fetchEc2MonthlyPrice.mockResolvedValue(1);
    await estimateAwsCost(creds, "ec2-instance", { instanceType: "t3.medium" });
    expect(fetchEc2MonthlyPrice).toHaveBeenCalledWith(creds, "us-east-1", "t3.medium");
  });

  it("quotes the volume alone and flags itself partial when the instance rate is unknown", async () => {
    fetchEbsGbMonthPrice.mockResolvedValue(0.08);
    const est = await estimateAwsCost(creds, "ec2-instance", {
      instanceType: "zz.huge",
      diskSizeGb: "40",
    });
    expect(est?.monthlyAmount).toBeCloseTo(3.2, 2);
    expect(est?.partial).toBe(true);
  });

  it("returns null rather than a zero when nothing can be priced", async () => {
    const est = await estimateAwsCost(creds, "ec2-instance", { instanceType: "zz.huge" });
    expect(est).toBeNull();
  });
});

describe("estimateAwsCost — ebs-volume", () => {
  it("multiplies size by the selected volume type's rate", async () => {
    fetchEbsGbMonthPrice.mockResolvedValue(0.125);
    const est = await estimateAwsCost(creds, "ebs-volume", { sizeGb: "100", volumeType: "io2" });
    expect(est?.monthlyAmount).toBeCloseTo(12.5, 2);
    expect(fetchEbsGbMonthPrice).toHaveBeenCalledWith(creds, "us-east-1", "io2");
    // Provisioned-IOPS volumes bill for IOPS on top of capacity; say so.
    expect(est?.notes?.[0]).toMatch(/IOPS/);
  });

  it("does not substitute another volume type's rate for an unknown one", async () => {
    // The static table this replaced fell back to gp3, which quoted a
    // confidently wrong number for anything it did not recognise.
    const est = await estimateAwsCost(creds, "ebs-volume", { sizeGb: "100", volumeType: "weird" });
    expect(est).toBeNull();
  });

  it("returns null for a non-positive size", async () => {
    fetchEbsGbMonthPrice.mockResolvedValue(0.08);
    expect(await estimateAwsCost(creds, "ebs-volume", { sizeGb: "0" })).toBeNull();
    expect(await estimateAwsCost(creds, "ebs-volume", { sizeGb: "-5" })).toBeNull();
  });
});

describe("estimateAwsCost — rds-instance", () => {
  it("itemizes the instance and its allocated storage", async () => {
    fetchRdsMonthlyPrice.mockResolvedValue(12.41);
    fetchRdsStorageGbMonthPrice.mockResolvedValue(0.115);
    const est = await estimateAwsCost(creds, "rds-instance", {
      instanceClass: "db.t3.micro",
      allocatedStorage: "20",
      engine: "postgres",
    });
    expect(est?.monthlyAmount).toBeCloseTo(12.41 + 20 * 0.115, 2);
    expect(fetchRdsMonthlyPrice).toHaveBeenCalledWith(
      creds,
      "us-east-1",
      "db.t3.micro",
      "postgres",
      false,
    );
  });

  it("prices an existing Multi-AZ instance from its stored fields", async () => {
    fetchRdsMonthlyPrice.mockResolvedValue(50);
    fetchRdsStorageGbMonthPrice.mockResolvedValue(0.23);
    const est = await estimateAwsCost(creds, "rds-instance", {
      region: "us-west-2",
      instanceClass: "db.t3.medium",
      allocatedStorage: "100",
      engine: "mysql",
      multiAZ: "true",
    });
    expect(fetchRdsMonthlyPrice).toHaveBeenCalledWith(
      creds,
      "us-west-2",
      "db.t3.medium",
      "mysql",
      true,
    );
    expect(est?.lineItems[1]?.detail).toContain("Multi-AZ");
  });

  it("does not invent allocated storage for Aurora, whose volume is consumption-billed", async () => {
    fetchRdsMonthlyPrice.mockResolvedValue(100);
    fetchRdsStorageGbMonthPrice.mockResolvedValue(0.115);
    const est = await estimateAwsCost(creds, "rds-instance", {
      instanceClass: "db.r6g.large",
      allocatedStorage: "20",
      engine: "aurora-postgresql",
    });
    expect(est?.monthlyAmount).toBe(100);
    expect(est?.lineItems).toHaveLength(1);
    expect(est?.partial).toBe(true);
    expect(fetchRdsStorageGbMonthPrice).not.toHaveBeenCalled();
  });
});

describe("estimateAwsCost — eks-cluster", () => {
  it("scales nodes and node volumes by the node count", async () => {
    fetchEc2MonthlyPrice.mockResolvedValue(30);
    fetchEbsGbMonthPrice.mockResolvedValue(0.08);
    const est = await estimateAwsCost(creds, "eks-cluster", {
      instanceType: "t3.medium",
      nodeCount: "3",
      diskSizeGb: "20",
    });
    expect(est?.monthlyAmount).toBeCloseTo(3 * 30 + 3 * 20 * 0.08, 2);
    expect(est?.lineItems[0]).toMatchObject({ quantity: 3, unit: "nodes" });
    // The control-plane hourly charge is real and deliberately unpriced.
    expect(est?.partial).toBe(true);
  });

  it("accepts the lister's instanceTypes field (plural, comma-joined)", async () => {
    fetchEc2MonthlyPrice.mockResolvedValue(30);
    fetchEbsGbMonthPrice.mockResolvedValue(0.08);
    const est = await estimateAwsCost(creds, "eks-cluster", {
      instanceTypes: "t3.large, t3.medium",
      nodeCount: "2",
      diskSizeGb: "20",
    });
    expect(fetchEc2MonthlyPrice).toHaveBeenCalledWith(creds, "us-east-1", "t3.large");
    expect(est?.monthlyAmount).toBeCloseTo(2 * 30 + 2 * 20 * 0.08, 2);
    expect(est?.lineItems[0]?.label).toContain("t3.large");
  });
});

it("returns null for a type it cannot price", async () => {
  expect(await estimateAwsCost(creds, "s3-bucket", {})).toBeNull();
});
