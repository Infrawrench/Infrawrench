import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { awsInstancePricing } from "../instance-pricing.js";

const resource = (resourceTypeId: string, fields: Record<string, unknown>) =>
  ({ resourceTypeId, fields }) as unknown as ResourceInstance;

describe("awsInstancePricing", () => {
  it("reads an EC2 instance as plain Linux in its region", () => {
    expect(
      awsInstancePricing(resource("ec2-instance", { instanceType: "m7g.large" }), "eu-west-1"),
    ).toMatchObject({
      platform: "ec2",
      instanceTypes: ["m7g.large"],
      region: "eu-west-1",
      selection: { operating_system: "Linux", tenancy: "Shared" },
    });
  });

  it("maps RDS engine ids and Multi-AZ onto the price list's values", () => {
    expect(
      awsInstancePricing(
        resource("rds-instance", {
          instanceClass: "db.r6g.large",
          engine: "oracle-se2",
          multiAZ: true,
        }),
        "us-east-1",
      )?.selection,
    ).toEqual({
      deployment_option: "Multi-AZ",
      database_engine: "Oracle",
      database_edition: "Standard Two",
    });
  });

  it("lists every node type of an EKS cluster", () => {
    expect(
      awsInstancePricing(
        resource("eks-cluster", { instanceTypes: "m5.large, t3.small" }),
        "us-east-1",
      )?.instanceTypes,
    ).toEqual(["m5.large", "t3.small"]);
  });

  it("has nothing for a type without prices, or a resource without an instance type", () => {
    expect(awsInstancePricing(resource("s3-bucket", {}), "us-east-1")).toBeUndefined();
    expect(awsInstancePricing(resource("eks-cluster", {}), "us-east-1")).toBeUndefined();
  });
});
