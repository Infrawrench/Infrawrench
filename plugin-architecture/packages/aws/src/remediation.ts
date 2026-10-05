/**
 * AWS CLI remediation commands for savings findings.
 *
 * Pure string work over the synced `fields` (see `resource-listers.ts` and
 * `resource-listers-extended/networking.ts` for what each type stores) and the
 * commitment records from `commitments.ts`. The AWS profile is the one value a
 * row never carries, so every command reads it from `$AWS_PROFILE`.
 */
import {
  remediationDateStamp,
  remediationField,
  remediationId,
  shellQuote,
} from "@infrawrench/plugin-base";
import type {
  RemediationCommand,
  RemediationCommitment,
  RemediationFinding,
  RemediationPlaceholder,
  RemediationResource,
} from "@infrawrench/plugin-base";

const AWS_PROFILE: RemediationPlaceholder = {
  name: "AWS_PROFILE",
  description: "AWS CLI profile for this account",
};
const PROFILE_ONLY: RemediationPlaceholder[] = [AWS_PROFILE];

const RI_INSTANCE_COUNT: RemediationPlaceholder = {
  name: "RI_INSTANCE_COUNT",
  description: "How many instances of the reservation to modify or sell",
};
const TARGET_INSTANCE_TYPE: RemediationPlaceholder = {
  name: "TARGET_INSTANCE_TYPE",
  description: "Instance type the reservation should cover instead, e.g. m5.large",
};
const TARGET_OFFERING_ID: RemediationPlaceholder = {
  name: "TARGET_OFFERING_ID",
  description: "Convertible RI offering id from describe-reserved-instances-offerings",
};
const RI_LISTING_PRICE: RemediationPlaceholder = {
  name: "RI_LISTING_PRICE",
  description: "Upfront price in USD to ask on the Reserved Instance Marketplace",
};

/** Savings Plans is a global service whose endpoint lives in us-east-1. */
const SAVINGS_PLANS_REGION = "us-east-1";

function aws(service: string, operation: string, args: string[], region: string): string {
  return [
    "aws",
    service,
    operation,
    ...args,
    "--region",
    shellQuote(region),
    '--profile "$AWS_PROFILE"',
  ].join(" ");
}

function cmd(
  command: string,
  description: string,
  destructive = false,
  extra: RemediationPlaceholder[] = [],
): RemediationCommand {
  return {
    tool: "aws-cli",
    command,
    description,
    destructive,
    placeholders: [...PROFILE_ONLY, ...extra],
  };
}

export function awsRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  switch (finding.kind) {
    case "orphan":
      return orphanCommands(finding.resource);
    case "oversized":
      return oversizedCommands(finding.resource, finding.targetSize, finding.region);
    case "sleep-schedule":
      return sleepCommands(finding.resource);
    case "idle-commitment":
      return commitmentCommands(finding.commitment);
  }
}

function regionOf(resource: RemediationResource, fallback: string | null = null): string {
  return remediationField(resource, "region") || (fallback ?? "").trim();
}

// ─── Orphans ────────────────────────────────────────────────────────────────

function orphanCommands(resource: RemediationResource): RemediationCommand[] {
  switch (resource.resourceTypeId) {
    case "ebs-volume":
      return ebsVolumeOrphan(resource);
    case "elastic-ip":
      return elasticIpOrphan(resource);
    default:
      return [];
  }
}

/** Snapshot names go into a shorthand tag value, so keep them to safe characters. */
function snapshotName(resource: RemediationResource, fallback: string): string {
  const base = resource.displayName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || fallback}-pre-delete-${remediationDateStamp()}`;
}

// https://docs.aws.amazon.com/cli/latest/reference/ec2/create-snapshot.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/wait/snapshot-completed.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/delete-volume.html
function ebsVolumeOrphan(resource: RemediationResource): RemediationCommand[] {
  const volumeId = remediationId(resource, "volumeId");
  const region = regionOf(resource);
  if (!volumeId || !region) return [];
  const name = snapshotName(resource, volumeId);
  const id = shellQuote(volumeId);
  return [
    cmd(
      aws(
        "ec2",
        "create-snapshot",
        [
          `--volume-id ${id}`,
          `--description ${shellQuote(`Pre-delete snapshot of ${resource.displayName}`)}`,
          `--tag-specifications ${shellQuote(`ResourceType=snapshot,Tags=[{Key=Name,Value=${name}}]`)}`,
        ],
        region,
      ),
      "Snapshots the volume so its data can be restored after deletion.",
    ),
    cmd(
      aws(
        "ec2 wait",
        "snapshot-completed",
        [`--filters Name=volume-id,Values=${id} ${shellQuote(`Name=tag:Name,Values=${name}`)}`],
        region,
      ),
      "Waits until the snapshot has finished copying.",
    ),
    cmd(
      aws("ec2", "delete-volume", [`--volume-id ${id}`], region),
      "Deletes the detached volume and stops its storage charge.",
      true,
    ),
  ];
}

// https://docs.aws.amazon.com/cli/latest/reference/ec2/release-address.html
function elasticIpOrphan(resource: RemediationResource): RemediationCommand[] {
  const region = regionOf(resource);
  if (!region) return [];
  const allocationId = remediationId(resource, "allocationId");
  const publicIp = remediationField(resource, "publicIp");
  // VPC addresses must be released by allocation id; --public-ip is only
  // for legacy EC2-Classic addresses, which carry no allocation id.
  const target = allocationId.startsWith("eipalloc-")
    ? `--allocation-id ${shellQuote(allocationId)}`
    : publicIp && remediationField(resource, "domain") === "standard"
      ? `--public-ip ${shellQuote(publicIp)}`
      : allocationId
        ? `--allocation-id ${shellQuote(allocationId)}`
        : "";
  if (!target) return [];
  return [
    cmd(
      aws("ec2", "release-address", [target], region),
      "Releases the unassociated Elastic IP back to AWS; the address may not be recoverable.",
      true,
    ),
  ];
}

// ─── Right-sizing ───────────────────────────────────────────────────────────

// https://docs.aws.amazon.com/cli/latest/reference/ec2/stop-instances.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/wait/instance-stopped.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/modify-instance-attribute.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/start-instances.html
function oversizedCommands(
  resource: RemediationResource,
  targetSize: string,
  findingRegion: string | null,
): RemediationCommand[] {
  if (resource.resourceTypeId !== "ec2-instance") return [];
  const instanceId = remediationId(resource, "instanceId");
  const region = regionOf(resource, findingRegion);
  const target = targetSize.trim();
  if (!instanceId || !region || !target) return [];
  const id = shellQuote(instanceId);
  return [
    cmd(
      aws("ec2", "stop-instances", [`--instance-ids ${id}`], region),
      "Stops the instance, which EC2 requires before a type change; causes downtime.",
    ),
    cmd(
      aws("ec2 wait", "instance-stopped", [`--instance-ids ${id}`], region),
      "Waits until the instance is fully stopped.",
    ),
    cmd(
      aws(
        "ec2",
        "modify-instance-attribute",
        [`--instance-id ${id}`, `--instance-type ${shellQuote(`Value=${target}`)}`],
        region,
      ),
      `Changes the instance type to ${target}.`,
    ),
    cmd(
      aws("ec2", "start-instances", [`--instance-ids ${id}`], region),
      "Starts the instance again on the new type.",
    ),
  ];
}

// ─── Sleep schedules ────────────────────────────────────────────────────────

function sleepCommands(resource: RemediationResource): RemediationCommand[] {
  switch (resource.resourceTypeId) {
    case "ec2-instance":
      return ec2Sleep(resource);
    case "rds-instance":
      return rdsSleep(resource);
    default:
      return [];
  }
}

// https://docs.aws.amazon.com/cli/latest/reference/ec2/stop-instances.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/start-instances.html
function ec2Sleep(resource: RemediationResource): RemediationCommand[] {
  const instanceId = remediationId(resource, "instanceId");
  const region = regionOf(resource);
  if (!instanceId || !region) return [];
  const id = shellQuote(instanceId);
  return [
    cmd(
      aws("ec2", "stop-instances", [`--instance-ids ${id}`], region),
      "Stops the instance so compute is no longer billed; attached EBS storage still is.",
    ),
    cmd(
      aws("ec2", "start-instances", [`--instance-ids ${id}`], region),
      "Starts the instance again.",
    ),
  ];
}

// https://docs.aws.amazon.com/cli/latest/reference/rds/stop-db-instance.html
// https://docs.aws.amazon.com/cli/latest/reference/rds/start-db-instance.html
// https://docs.aws.amazon.com/cli/latest/reference/rds/stop-db-cluster.html
// https://docs.aws.amazon.com/cli/latest/reference/rds/start-db-cluster.html
function rdsSleep(resource: RemediationResource): RemediationCommand[] {
  const region = regionOf(resource);
  if (!region) return [];
  // Aurora and Multi-AZ DB cluster members cannot be stopped one instance at
  // a time; stop-db-instance rejects them, so the cluster is the unit.
  const clusterId = remediationField(resource, "dbClusterIdentifier");
  if (clusterId) {
    const id = shellQuote(clusterId);
    return [
      cmd(
        aws("rds", "stop-db-cluster", [`--db-cluster-identifier ${id}`], region),
        "Stops the whole DB cluster this instance belongs to; RDS starts it again automatically after 7 days.",
      ),
      cmd(
        aws("rds", "start-db-cluster", [`--db-cluster-identifier ${id}`], region),
        "Starts the DB cluster again.",
      ),
    ];
  }
  const dbId = remediationId(resource, "dbInstanceId");
  if (!dbId) return [];
  const id = shellQuote(dbId);
  return [
    cmd(
      aws("rds", "stop-db-instance", [`--db-instance-identifier ${id}`], region),
      "Stops the DB instance; RDS starts it again automatically after 7 days, so the schedule must re-stop it.",
    ),
    cmd(
      aws("rds", "start-db-instance", [`--db-instance-identifier ${id}`], region),
      "Starts the DB instance again.",
    ),
  ];
}

// ─── Idle commitments ───────────────────────────────────────────────────────

function commitmentCommands(commitment: RemediationCommitment): RemediationCommand[] {
  const id = commitment.id.trim();
  if (!id) return [];
  if (commitment.kind === "savings_plan") return savingsPlanCommands(id);
  if (commitment.kind !== "reservation") return [];
  const region = (commitment.region ?? "").trim();
  if (!region) return [];
  if (/^arn:[^:]+:rds:/.test(id)) {
    return rdsReservationCommands(id, region);
  }
  if (id.startsWith("arn:")) return [];
  return ec2ReservationCommands(id, region);
}

// https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-reserved-instances.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/modify-reserved-instances.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-reserved-instances-offerings.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/get-reserved-instances-exchange-quote.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/accept-reserved-instances-exchange-quote.html
// https://docs.aws.amazon.com/cli/latest/reference/ec2/create-reserved-instances-listing.html
function ec2ReservationCommands(riId: string, region: string): RemediationCommand[] {
  const id = shellQuote(riId);
  const date = remediationDateStamp();
  return [
    cmd(
      aws("ec2", "describe-reserved-instances", [`--reserved-instances-ids ${id}`], region),
      "Shows the reservation's offering class (standard or convertible), scope and instance count.",
    ),
    cmd(
      aws(
        "ec2",
        "modify-reserved-instances",
        [
          `--reserved-instances-ids ${id}`,
          '--target-configurations "InstanceCount=$RI_INSTANCE_COUNT,InstanceType=$TARGET_INSTANCE_TYPE,Scope=Region"',
          `--client-token ${shellQuote(`${riId}-modify-${date}`)}`,
        ],
        region,
      ),
      "Moves the reservation to regional scope and a size in the same family that your running instances use.",
      false,
      [RI_INSTANCE_COUNT, TARGET_INSTANCE_TYPE],
    ),
    cmd(
      aws(
        "ec2",
        "describe-reserved-instances-offerings",
        ["--offering-class convertible", '--instance-type "$TARGET_INSTANCE_TYPE"'],
        region,
      ),
      "Lists convertible offerings to exchange into (convertible RIs only).",
      false,
      [TARGET_INSTANCE_TYPE],
    ),
    cmd(
      aws(
        "ec2",
        "get-reserved-instances-exchange-quote",
        [
          `--reserved-instance-ids ${id}`,
          '--target-configurations "OfferingId=$TARGET_OFFERING_ID"',
        ],
        region,
      ),
      "Prices exchanging this convertible reservation for the chosen offering without committing.",
      false,
      [TARGET_OFFERING_ID],
    ),
    cmd(
      aws(
        "ec2",
        "accept-reserved-instances-exchange-quote",
        [
          `--reserved-instance-ids ${id}`,
          '--target-configurations "OfferingId=$TARGET_OFFERING_ID"',
        ],
        region,
      ),
      "Exchanges the convertible reservation for the new offering; the exchange cannot be undone.",
      true,
      [TARGET_OFFERING_ID],
    ),
    cmd(
      aws(
        "ec2",
        "create-reserved-instances-listing",
        [
          `--reserved-instances-id ${id}`,
          '--instance-count "$RI_INSTANCE_COUNT"',
          '--price-schedules "CurrencyCode=USD,Price=$RI_LISTING_PRICE"',
          `--client-token ${shellQuote(`${riId}-listing-${date}`)}`,
        ],
        region,
      ),
      "Lists a standard reservation for sale on the Reserved Instance Marketplace (needs a registered seller account).",
      false,
      [RI_INSTANCE_COUNT, RI_LISTING_PRICE],
    ),
  ];
}

// https://docs.aws.amazon.com/cli/latest/reference/rds/describe-reserved-db-instances.html
// https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithReservedDBInstances.html
function rdsReservationCommands(arn: string, region: string): RemediationCommand[] {
  // describe-reserved-db-instances filters by the bare id, not the ARN
  // (arn:aws:rds:<region>:<account>:ri:<id>).
  const marker = ":ri:";
  const at = arn.indexOf(marker);
  const riId = at >= 0 ? arn.slice(at + marker.length) : arn.startsWith("arn:") ? "" : arn;
  if (!riId) return [];
  return [
    cmd(
      aws(
        "rds",
        "describe-reserved-db-instances",
        [`--reserved-db-instance-id ${shellQuote(riId)}`],
        region,
      ),
      "Shows the reservation's class, engine and Multi-AZ setting. RDS reservations cannot be cancelled, sold or exchanged; match a DB instance to them instead (size flexible within the class family for MySQL, MariaDB, PostgreSQL, Db2 and Oracle BYOL).",
    ),
  ];
}

// https://docs.aws.amazon.com/cli/latest/reference/savingsplans/describe-savings-plans.html
// https://docs.aws.amazon.com/cli/latest/reference/savingsplans/return-savings-plan.html
// https://docs.aws.amazon.com/savingsplans/latest/userguide/return-sp.html
function savingsPlanCommands(planId: string): RemediationCommand[] {
  const isArn = planId.startsWith("arn:");
  const marker = ":savingsplan/";
  const at = planId.indexOf(marker);
  const bareId = isArn ? (at >= 0 ? planId.slice(at + marker.length) : "") : planId;
  const describe = cmd(
    aws(
      "savingsplans",
      "describe-savings-plans",
      [
        isArn
          ? `--savings-plan-arns ${shellQuote(planId)}`
          : `--savings-plan-ids ${shellQuote(planId)}`,
      ],
      SAVINGS_PLANS_REGION,
    ),
    "Shows the plan's type, commitment, term and state. Savings Plans cannot be cancelled or sold once the return window has passed.",
  );
  if (!bareId) return [describe];
  return [
    describe,
    cmd(
      aws(
        "savingsplans",
        "return-savings-plan",
        [`--savings-plan-id ${shellQuote(bareId)}`],
        SAVINGS_PLANS_REGION,
      ),
      "Returns the plan for a refund; only allowed within 7 days of purchase, in the same calendar month, for plans of $100/hour or less.",
      true,
    ),
  ];
}
