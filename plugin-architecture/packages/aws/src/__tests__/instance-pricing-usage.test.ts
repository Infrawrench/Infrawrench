import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { awsInstancePricingUsage } from "../instance-pricing.js";
import { plugin } from "../plugin.js";

const resource = (resourceTypeId: string, fields: Record<string, unknown>) =>
  ({ resourceTypeId, fields }) as unknown as ResourceInstance;

describe("awsInstancePricingUsage", () => {
  it("is the hook the plugin declares", () => {
    expect(plugin.instancePricingUsage).toBe(awsInstancePricingUsage);
  });

  it("bills a running EC2 instance once, as plain Linux in its region", () => {
    expect(
      awsInstancePricingUsage(
        resource("ec2-instance", {
          instanceType: "m5.large",
          region: "us-east-1",
          state: "running",
        }),
      ),
    ).toEqual([
      {
        platform: "ec2",
        instanceType: "m5.large",
        region: "us-east-1",
        selection: expect.objectContaining({ operating_system: "Linux", tenancy: "Shared" }),
        units: 1,
      },
    ]);
  });

  it("bills nothing for a stopped instance or a resource with no region", () => {
    expect(
      awsInstancePricingUsage(
        resource("ec2-instance", {
          instanceType: "m5.large",
          region: "us-east-1",
          state: "stopped",
        }),
      ),
    ).toEqual([]);
    expect(awsInstancePricingUsage(resource("ec2-instance", { instanceType: "m5.large" }))).toEqual(
      [],
    );
    expect(awsInstancePricingUsage(resource("s3-bucket", { region: "us-east-1" }))).toEqual([]);
  });

  it("prices a single-type cluster at its node count", () => {
    expect(
      awsInstancePricingUsage(
        resource("eks-cluster", { instanceTypes: "m6i.xlarge", nodeCount: 6, region: "eu-west-1" }),
      ),
    ).toMatchObject([{ platform: "ec2", instanceType: "m6i.xlarge", units: 6 }]);
  });

  it("counts each type once, as a lower bound, when a cluster mixes types", () => {
    const usage = awsInstancePricingUsage(
      resource("eks-cluster", {
        instanceTypes: "m6i.xlarge, c6i.large",
        nodeCount: 6,
        region: "eu-west-1",
      }),
    );
    expect(usage.map((u) => [u.instanceType, u.units, u.approximate])).toEqual([
      ["m6i.xlarge", 1, true],
      ["c6i.large", 1, true],
    ]);
  });

  it("matches an RDS instance's engine and deployment, and skips a stopped one", () => {
    expect(
      awsInstancePricingUsage(
        resource("rds-instance", {
          instanceClass: "db.r6g.large",
          engine: "postgres",
          multiAZ: true,
          region: "us-east-1",
        }),
      )[0]?.selection,
    ).toEqual({ deployment_option: "Multi-AZ", database_engine: "PostgreSQL" });
    expect(
      awsInstancePricingUsage(
        resource("rds-instance", {
          instanceClass: "db.r6g.large",
          engine: "postgres",
          status: "stopped",
          region: "us-east-1",
        }),
      ),
    ).toEqual([]);
  });
});
