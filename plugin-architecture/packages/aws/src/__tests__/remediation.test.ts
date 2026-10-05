import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationCommand, RemediationResource } from "@infrawrench/plugin-base";
import { awsRemediationCommands } from "../remediation.js";
import { plugin as awsPlugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

function resource(
  resourceTypeId: string,
  displayName: string,
  externalId: string | null,
  fields: Record<string, string | number | boolean>,
): RemediationResource {
  return { resourceTypeId, displayName, externalId, fields };
}

const lines = (cmds: RemediationCommand[]) =>
  cmds.map((c) => `${c.destructive ? "[destructive] " : ""}${c.command}`);

const ec2 = resource("ec2-instance", "web-1", "i-0abc12de34f567890", {
  instanceId: "i-0abc12de34f567890",
  region: "us-east-1",
  instanceType: "m5.2xlarge",
  state: "running",
});

describe("awsRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(awsPlugin.remediationCommands).toBe(awsRemediationCommands);
  });

  it("resizes an oversized EC2 instance with stop, wait, modify, start", () => {
    const cmds = awsRemediationCommands({
      kind: "oversized",
      resource: ec2,
      sizeFieldKey: "instanceType",
      currentSize: "m5.2xlarge",
      targetSize: "m5.large",
      region: "us-east-1",
    });
    expect(lines(cmds)).toMatchInlineSnapshot(`
      [
        "aws ec2 stop-instances --instance-ids i-0abc12de34f567890 --region us-east-1 --profile "$AWS_PROFILE"",
        "aws ec2 wait instance-stopped --instance-ids i-0abc12de34f567890 --region us-east-1 --profile "$AWS_PROFILE"",
        "aws ec2 modify-instance-attribute --instance-id i-0abc12de34f567890 --instance-type Value=m5.large --region us-east-1 --profile "$AWS_PROFILE"",
        "aws ec2 start-instances --instance-ids i-0abc12de34f567890 --region us-east-1 --profile "$AWS_PROFILE"",
      ]
    `);
    expect(cmds.every((c) => c.placeholders?.[0]?.name === "AWS_PROFILE")).toBe(true);
  });

  it("stops and starts an EC2 instance for a sleep schedule", () => {
    expect(lines(awsRemediationCommands({ kind: "sleep-schedule", resource: ec2 })))
      .toMatchInlineSnapshot(`
      [
        "aws ec2 stop-instances --instance-ids i-0abc12de34f567890 --region us-east-1 --profile "$AWS_PROFILE"",
        "aws ec2 start-instances --instance-ids i-0abc12de34f567890 --region us-east-1 --profile "$AWS_PROFILE"",
      ]
    `);
  });

  it("stops and starts a standalone RDS instance", () => {
    const db = resource("rds-instance", "orders-db", "orders-db", {
      dbInstanceId: "orders-db",
      region: "eu-west-1",
      status: "available",
      dbClusterIdentifier: "",
    });
    const cmds = awsRemediationCommands({ kind: "sleep-schedule", resource: db });
    expect(lines(cmds)).toMatchInlineSnapshot(`
      [
        "aws rds stop-db-instance --db-instance-identifier orders-db --region eu-west-1 --profile "$AWS_PROFILE"",
        "aws rds start-db-instance --db-instance-identifier orders-db --region eu-west-1 --profile "$AWS_PROFILE"",
      ]
    `);
    expect(cmds[0]?.description).toContain("7 days");
  });

  it("stops the cluster for an Aurora member instance", () => {
    const db = resource("rds-instance", "aurora-1", "aurora-1", {
      dbInstanceId: "aurora-1",
      region: "eu-west-1",
      dbClusterIdentifier: "aurora-prod",
    });
    expect(lines(awsRemediationCommands({ kind: "sleep-schedule", resource: db })))
      .toMatchInlineSnapshot(`
      [
        "aws rds stop-db-cluster --db-cluster-identifier aurora-prod --region eu-west-1 --profile "$AWS_PROFILE"",
        "aws rds start-db-cluster --db-cluster-identifier aurora-prod --region eu-west-1 --profile "$AWS_PROFILE"",
      ]
    `);
  });

  it("snapshots, waits for and deletes an orphaned EBS volume, quoting hostile names", () => {
    const vol = resource("ebs-volume", "data'; rm -rf ~", "vol-0a1b2c3d4e5f67890", {
      volumeId: "vol-0a1b2c3d4e5f67890",
      region: "us-west-2",
      state: "available",
    });
    const cmds = awsRemediationCommands({ kind: "orphan", resource: vol, reason: "detached" });
    expect(lines(cmds)).toMatchInlineSnapshot(`
      [
        "aws ec2 create-snapshot --volume-id vol-0a1b2c3d4e5f67890 --description 'Pre-delete snapshot of data'"'"'; rm -rf ~' --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Name,Value=data-rm--rf-pre-delete-20261004}]' --region us-west-2 --profile "$AWS_PROFILE"",
        "aws ec2 wait snapshot-completed --filters Name=volume-id,Values=vol-0a1b2c3d4e5f67890 Name=tag:Name,Values=data-rm--rf-pre-delete-20261004 --region us-west-2 --profile "$AWS_PROFILE"",
        "[destructive] aws ec2 delete-volume --volume-id vol-0a1b2c3d4e5f67890 --region us-west-2 --profile "$AWS_PROFILE"",
      ]
    `);
    expect(cmds.map((c) => c.destructive)).toEqual([false, false, true]);
  });

  it("releases an orphaned VPC Elastic IP by allocation id", () => {
    const eip = resource("elastic-ip", "203.0.113.10", "eipalloc-0123456789abcdef0", {
      allocationId: "eipalloc-0123456789abcdef0",
      publicIp: "203.0.113.10",
      region: "us-east-1",
      associationId: "",
      domain: "vpc",
    });
    const cmds = awsRemediationCommands({ kind: "orphan", resource: eip, reason: "unassociated" });
    expect(lines(cmds)).toMatchInlineSnapshot(`
      [
        "[destructive] aws ec2 release-address --allocation-id eipalloc-0123456789abcdef0 --region us-east-1 --profile "$AWS_PROFILE"",
      ]
    `);
  });

  it("covers an idle EC2 Reserved Instance", () => {
    const cmds = awsRemediationCommands({
      kind: "idle-commitment",
      commitment: {
        id: "b847fa93-e282-4f55-b59a-1342f5bd7c02",
        kind: "reservation",
        description: "EC2 Reserved Instance",
        scope: "us-east-1a",
        region: "us-east-1",
      },
    });
    expect(lines(cmds)).toMatchInlineSnapshot(`
      [
        "aws ec2 describe-reserved-instances --reserved-instances-ids b847fa93-e282-4f55-b59a-1342f5bd7c02 --region us-east-1 --profile "$AWS_PROFILE"",
        "aws ec2 modify-reserved-instances --reserved-instances-ids b847fa93-e282-4f55-b59a-1342f5bd7c02 --target-configurations "InstanceCount=$RI_INSTANCE_COUNT,InstanceType=$TARGET_INSTANCE_TYPE,Scope=Region" --client-token b847fa93-e282-4f55-b59a-1342f5bd7c02-modify-20261004 --region us-east-1 --profile "$AWS_PROFILE"",
        "aws ec2 describe-reserved-instances-offerings --offering-class convertible --instance-type "$TARGET_INSTANCE_TYPE" --region us-east-1 --profile "$AWS_PROFILE"",
        "aws ec2 get-reserved-instances-exchange-quote --reserved-instance-ids b847fa93-e282-4f55-b59a-1342f5bd7c02 --target-configurations "OfferingId=$TARGET_OFFERING_ID" --region us-east-1 --profile "$AWS_PROFILE"",
        "[destructive] aws ec2 accept-reserved-instances-exchange-quote --reserved-instance-ids b847fa93-e282-4f55-b59a-1342f5bd7c02 --target-configurations "OfferingId=$TARGET_OFFERING_ID" --region us-east-1 --profile "$AWS_PROFILE"",
        "aws ec2 create-reserved-instances-listing --reserved-instances-id b847fa93-e282-4f55-b59a-1342f5bd7c02 --instance-count "$RI_INSTANCE_COUNT" --price-schedules "CurrencyCode=USD,Price=$RI_LISTING_PRICE" --client-token b847fa93-e282-4f55-b59a-1342f5bd7c02-listing-20261004 --region us-east-1 --profile "$AWS_PROFILE"",
      ]
    `);
  });

  it("covers an idle RDS Reserved Instance by its bare id", () => {
    const cmds = awsRemediationCommands({
      kind: "idle-commitment",
      commitment: {
        id: "arn:aws:rds:us-west-2:123456789012:ri:my-reserved-db",
        kind: "reservation",
        description: "RDS Reserved Instance",
        scope: null,
        region: "us-west-2",
      },
    });
    expect(lines(cmds)).toMatchInlineSnapshot(`
      [
        "aws rds describe-reserved-db-instances --reserved-db-instance-id my-reserved-db --region us-west-2 --profile "$AWS_PROFILE"",
      ]
    `);
    expect(cmds[0]?.description).toContain("cannot be cancelled");
  });

  it("covers an idle Savings Plan", () => {
    const cmds = awsRemediationCommands({
      kind: "idle-commitment",
      commitment: {
        id: "arn:aws:savingsplans::123456789012:savingsplan/12345678-1234-4234-8234-123456789012",
        kind: "savings_plan",
        description: "Compute Savings Plan",
        scope: null,
        region: null,
      },
    });
    expect(lines(cmds)).toMatchInlineSnapshot(`
      [
        "aws savingsplans describe-savings-plans --savings-plan-arns arn:aws:savingsplans::123456789012:savingsplan/12345678-1234-4234-8234-123456789012 --region us-east-1 --profile "$AWS_PROFILE"",
        "[destructive] aws savingsplans return-savings-plan --savings-plan-id 12345678-1234-4234-8234-123456789012 --region us-east-1 --profile "$AWS_PROFILE"",
      ]
    `);
  });

  it("returns nothing for unknown types or missing ids", () => {
    expect(
      awsRemediationCommands({
        kind: "orphan",
        resource: resource("s3-bucket", "b", "b", { region: "us-east-1" }),
        reason: "x",
      }),
    ).toEqual([]);
    expect(
      awsRemediationCommands({
        kind: "sleep-schedule",
        resource: resource("ec2-instance", "x", null, { region: "us-east-1" }),
      }),
    ).toEqual([]);
  });
});
