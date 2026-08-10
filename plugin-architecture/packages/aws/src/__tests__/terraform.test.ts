import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { awsTerraformExport } from "../terraform.js";

function resource(
  resourceTypeId: string,
  fields: Record<string, string | number | boolean>,
): ResourceInstance {
  return {
    id: `account:${resourceTypeId}:example`,
    pluginId: "aws",
    resourceTypeId,
    accountId: "account",
    displayName: "example",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: "example-id",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("awsTerraformExport", () => {
  it("maps an S3 bucket", () => {
    expect(
      awsTerraformExport.mapResource(resource("s3-bucket", { name: "logs-example" })),
    ).toMatchObject({
      resource: { type: "aws_s3_bucket", attributes: { bucket: { value: "logs-example" } } },
    });
  });

  it("maps a VPC with its CIDR", () => {
    expect(
      awsTerraformExport.mapResource(resource("vpc", { name: "main", cidrBlock: "10.0.0.0/16" })),
    ).toMatchObject({
      resource: { type: "aws_vpc", attributes: { cidr_block: { value: "10.0.0.0/16" } } },
    });
  });

  it("maps EC2 security groups as a structured list", () => {
    expect(
      awsTerraformExport.mapResource(
        resource("ec2-instance", {
          name: "web",
          instanceType: "t3.micro",
          imageId: "ami-123",
          securityGroupIds: "sg-1, sg-2",
        }),
      ),
    ).toMatchObject({
      resource: {
        attributes: { vpc_security_group_ids: { items: [{ value: "sg-1" }, { value: "sg-2" }] } },
      },
    });
  });
});
