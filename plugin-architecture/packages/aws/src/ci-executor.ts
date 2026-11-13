/**
 * CI jobs on AWS. `vm` is here (EC2); `container` (ECS on Fargate) is in
 * `ci-ecs.ts` and `build` (CodeBuild) in `ci-codebuild.ts`.
 *
 * CI jobs on EC2: one fresh instance per job, started with the host's
 * bootstrap script as user data and terminated when the job ends.
 *
 * **Wire shapes verified against the EC2 API reference, November 2026**
 * (Query API, version 2016-11-15, through `ec2Call`):
 * - `RunInstances`: `ImageId` (an AMI id, or `resolve:ssm:<public parameter>`,
 *   which needs `ssm:GetParameters`), `InstanceType`, `MinCount`/`MaxCount`,
 *   `UserData` (base64), `InstanceInitiatedShutdownBehavior=terminate`,
 *   `ClientToken` (idempotency, at most 64 ASCII characters),
 *   `MetadataOptions.HttpTokens=required`, `BlockDeviceMapping.N.*`,
 *   `TagSpecification.N.{ResourceType,Tag.M.Key,Tag.M.Value}`. With
 *   `DryRun=true` the answer is the error `DryRunOperation` when the
 *   credential may, `UnauthorizedOperation` when it may not.
 * - `DescribeInstances`: `InstanceId.N`, `Filter.N.Name` / `Filter.N.Value.M`
 *   (`tag-key`, `instance-state-name`); answers `reservationSet.item[]
 *   .instancesSet.item[]` with `instanceId`, `instanceState.name`,
 *   `launchTime`, `tagSet.item[]{key,value}`, `stateReason.message`.
 * - `TerminateInstances`: `InstanceId.N`. An unknown id answers
 *   `InvalidInstanceID.NotFound`, which is "already gone".
 * - `DescribeVpcs` with `Filter.1.Name=isDefault`: without a default VPC,
 *   `RunInstances` needs a subnet, which a job does not name.
 *
 * Without a subnet or security group, RunInstances uses the default VPC's
 * default subnet and security group, which allow all outbound traffic and
 * no inbound traffic from outside the group: all a job needs, since it
 * calls out to the host and never accepts connections. The instance gets no
 * instance profile, so the job never holds the connection's AWS credentials.
 *
 * Teardown happens three ways: the host terminates the instance when the
 * job ends; the instance shuts itself down (and so terminates, through
 * `InstanceInitiatedShutdownBehavior`) when the bootstrap ends or its
 * timer runs out; and the host's reaper terminates anything tagged for CI
 * that no live job owns.
 */
import type {
  CiComputeStatus,
  CiExecutorDeclaration,
  CiExecutorKind,
  CiHandle,
  CiMissingPermission,
  CiPreflightResult,
  CiStartSpec,
  CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { AwsRequestError } from "./aws-errors.js";
import { instanceTypeArch } from "./ami-lookup.js";
import {
  CODEBUILD_DEFAULT_IMAGE,
  CODEBUILD_DEFAULT_MACHINE,
  CODEBUILD_MACHINES,
  codebuildListTagged,
} from "./ci-codebuild.js";
import { ECS_DEFAULT_IMAGE, ECS_DEFAULT_MACHINE, ecsListTagged } from "./ci-ecs.js";
import type { AwsCiCalls } from "./ci-calls.js";
import { ensureArray } from "./xml.js";

/** One EC2 Query API call in a region. */
export type Ec2Call = <T>(
  region: string,
  action: string,
  params?: Record<string, string>,
) => Promise<T>;

const DEFAULT_MACHINE = "t3.large";
const ROOT_VOLUME_GIB = "40";

/** Ubuntu 24.04 from Canonical's public SSM parameters, for the machine's architecture. */
export function defaultImage(machine: string): string {
  const arch = instanceTypeArch(machine) === "arm64" ? "arm64" : "amd64";
  return `resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/${arch}/hvm/ebs-gp3/ami-id`;
}

export const AWS_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "EC2 instance",
      defaults: { machine: DEFAULT_MACHINE, image: "Ubuntu 24.04" },
      typicalStartSeconds: 60,
      // Linux instances are billed per second with a one-minute minimum.
      minimumBillingSeconds: 60,
      gpus: true,
      machineSuggestions: [
        "t3.medium",
        "t3.large",
        "t3.xlarge",
        "c7i.xlarge",
        "c7i.2xlarge",
        "m7i.xlarge",
        "c7g.xlarge",
        "m7g.xlarge",
        "g5.xlarge",
        "g6.xlarge",
      ],
    },
    {
      kind: "container",
      label: "ECS task on Fargate",
      defaults: { machine: ECS_DEFAULT_MACHINE, image: ECS_DEFAULT_IMAGE },
      // Fargate bills per second with a one-minute minimum.
      minimumBillingSeconds: 60,
      typicalStartSeconds: 45,
      machineSuggestions: ["1vcpu-2gb", "2vcpu-4gb", "4vcpu-8gb", "8vcpu-16gb", "16vcpu-32gb"],
    },
    {
      kind: "build",
      label: "CodeBuild build",
      defaults: { machine: CODEBUILD_DEFAULT_MACHINE, image: CODEBUILD_DEFAULT_IMAGE },
      // On-demand builds are billed in whole minutes, rounded up.
      minimumBillingSeconds: 60,
      typicalStartSeconds: 60,
      machineSuggestions: CODEBUILD_MACHINES,
    },
  ],
  helpLink: {
    label: "Add these permissions to the IAM user",
    url: "https://console.aws.amazon.com/iam/home#/users",
  },
} as const satisfies CiExecutorDeclaration;

/** Every permission a CI job on EC2 needs, with what it is for. */
export const CI_PERMISSIONS = {
  run: { permission: "ec2:RunInstances", label: "Start the job's instance" },
  tag: { permission: "ec2:CreateTags", label: "Tag it as a CI job's" },
  image: { permission: "ssm:GetParameters", label: "Find the latest Ubuntu image" },
  describe: { permission: "ec2:DescribeInstances", label: "Follow it and find leftovers" },
  terminate: { permission: "ec2:TerminateInstances", label: "Remove it when the job ends" },
} as const satisfies Record<string, CiMissingPermission>;

function code(err: unknown): string | undefined {
  return err instanceof AwsRequestError ? err.code : undefined;
}

function isDryRunOk(err: unknown): boolean {
  return code(err) === "DryRunOperation";
}

function isUnauthorized(err: unknown): boolean {
  const c = code(err);
  return c === "UnauthorizedOperation" || c === "AccessDenied" || c === "AccessDeniedException";
}

/** A refusal that means nothing could have been started there by this key. */
function isClosedToKey(err: unknown): boolean {
  const c = code(err);
  return isUnauthorized(err) || c === "SubscriptionRequiredException" || c === "OptInRequired";
}

function tagParams(prefix: string, tags: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 1;
  for (const [key, value] of Object.entries(tags)) {
    out[`${prefix}.Tag.${i}.Key`] = key;
    // EC2 tag values are at most 256 characters.
    out[`${prefix}.Tag.${i}.Value`] = value.slice(0, 256);
    i++;
  }
  return out;
}

/** The user data: the host's bootstrap behind a shutdown timer, and a shutdown after it. */
export function userData(bootstrap: string, maxSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(maxSeconds / 60));
  const body = bootstrap.replace(/^#![^\n]*\n/, "");
  return [
    "#!/bin/bash",
    // The backstop: the instance terminates itself once the job's time is
    // up, whatever happens to the host or the bootstrap.
    `shutdown -h +${minutes} >/dev/null 2>&1 || true`,
    "(",
    body,
    ")",
    "shutdown -h now",
    "",
  ].join("\n");
}

/** RunInstances parameters for a job (without DryRun). */
export function runParams(spec: CiStartSpec, clientToken: string): Record<string, string> {
  const machine = spec.machine ?? DEFAULT_MACHINE;
  const image = spec.image && spec.image !== "Ubuntu 24.04" ? spec.image : defaultImage(machine);
  const params: Record<string, string> = {
    ImageId: image,
    InstanceType: machine,
    MinCount: "1",
    MaxCount: "1",
    UserData: Buffer.from(userData(spec.bootstrap, spec.maxSeconds), "utf8").toString("base64"),
    InstanceInitiatedShutdownBehavior: "terminate",
    ClientToken: clientToken.slice(0, 64),
    "MetadataOptions.HttpTokens": "required",
    "TagSpecification.1.ResourceType": "instance",
    ...tagParams("TagSpecification.1", { ...spec.tags, Name: spec.name }),
    "TagSpecification.2.ResourceType": "volume",
    ...tagParams("TagSpecification.2", spec.tags),
  };
  // Ubuntu's root device; a custom image keeps its own volume layout.
  if (image.startsWith("resolve:ssm:/aws/service/canonical/")) {
    params["BlockDeviceMapping.1.DeviceName"] = "/dev/sda1";
    params["BlockDeviceMapping.1.Ebs.VolumeSize"] = ROOT_VOLUME_GIB;
    params["BlockDeviceMapping.1.Ebs.VolumeType"] = "gp3";
    params["BlockDeviceMapping.1.Ebs.DeleteOnTermination"] = "true";
  }
  return params;
}

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") {
    throw new Error(`EC2 runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
  }
}

export async function ciPreflight(
  call: Ec2Call,
  homeRegion: string,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const where = region ?? homeRegion;
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  const spec: CiStartSpec = {
    kind,
    bootstrap: "#!/bin/sh\ntrue\n",
    tags: { "infrawrench-ci": "preflight" },
    name: "infrawrench-ci-preflight",
    maxSeconds: 600,
  };
  try {
    await call(where, "RunInstances", { ...runParams(spec, "preflight"), DryRun: "true" });
  } catch (err) {
    if (!isDryRunOk(err)) {
      if (isUnauthorized(err)) {
        missing.push(CI_PERMISSIONS.run, CI_PERMISSIONS.tag);
      } else if (/ssm|parameter/i.test(err instanceof Error ? err.message : "")) {
        missing.push(CI_PERMISSIONS.image);
      } else {
        problems.push(
          `EC2 refused a test launch in ${where}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  try {
    await call(where, "DescribeInstances", { DryRun: "true", MaxResults: "5" });
  } catch (err) {
    if (!isDryRunOk(err) && isUnauthorized(err)) missing.push(CI_PERMISSIONS.describe);
  }
  try {
    // A well-formed id that does not exist: DryRun answers for the permission first.
    await call(where, "TerminateInstances", {
      DryRun: "true",
      "InstanceId.1": "i-0000000000000000f",
    });
  } catch (err) {
    if (!isDryRunOk(err) && isUnauthorized(err)) missing.push(CI_PERMISSIONS.terminate);
  }
  try {
    const vpcs = await call<Record<string, unknown>>(where, "DescribeVpcs", {
      "Filter.1.Name": "isDefault",
      "Filter.1.Value.1": "true",
    });
    const set = vpcs["vpcSet"] as Record<string, unknown> | undefined;
    if (ensureArray(set?.["item"]).length === 0) {
      problems.push(
        `There is no default VPC in ${where}, which a CI instance starts in. Create one in the VPC console (Actions, Create default VPC), or use another region.`,
      );
    }
  } catch {
    // Not being able to look is no reason to refuse: the launch says so.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

interface Ec2Instance {
  instanceId?: string;
  instanceType?: string;
  launchTime?: string;
  instanceState?: { name?: string };
  stateReason?: { message?: string };
  tagSet?: { item?: unknown };
}

function instancesOf(data: Record<string, unknown>): Ec2Instance[] {
  const reservations = ensureArray(
    (data["reservationSet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];
  return reservations.flatMap(
    (r) =>
      ensureArray(
        (r["instancesSet"] as Record<string, unknown> | undefined)?.["item"],
      ) as Ec2Instance[],
  );
}

function tagsOf(instance: Ec2Instance): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of ensureArray(instance.tagSet?.item) as Array<{
    key?: unknown;
    value?: unknown;
  }>) {
    if (typeof tag.key === "string") out[tag.key] = typeof tag.value === "string" ? tag.value : "";
  }
  return out;
}

function handleOf(instanceId: string, region: string): CiHandle {
  return { id: instanceId, region, label: `aws ec2 ${instanceId} (${region})` };
}

export async function ciStart(
  call: Ec2Call,
  homeRegion: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu && !spec.machine) {
    throw new Error(
      "On AWS a GPU comes with the instance type: name one in `cloud.machine`, e.g. g5.xlarge.",
    );
  }
  const region = spec.region ?? homeRegion;
  // The job's id makes the launch idempotent: a retry after a lost answer
  // gets the same instance rather than a second one.
  const token = spec.tags["infrawrench-ci-job"] ?? spec.name;
  const data = await call<Record<string, unknown>>(region, "RunInstances", runParams(spec, token));
  const set = data["instancesSet"] as Record<string, unknown> | undefined;
  const instance = ensureArray(set?.["item"])[0] as Ec2Instance | undefined;
  if (!instance?.instanceId) throw new Error("EC2 started no instance");
  return handleOf(instance.instanceId, region);
}

export async function ciStatus(
  call: Ec2Call,
  homeRegion: string,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  let data: Record<string, unknown>;
  try {
    data = await call(handle.region ?? homeRegion, "DescribeInstances", {
      "InstanceId.1": handle.id,
    });
  } catch (err) {
    if (code(err) === "InvalidInstanceID.NotFound") return { state: "gone" };
    throw err;
  }
  const instance = instancesOf(data)[0];
  if (!instance) return { state: "gone" };
  const name = instance.instanceState?.name ?? "";
  const detail = instance.stateReason?.message;
  const state: CiComputeStatus["state"] =
    name === "pending"
      ? "starting"
      : name === "running"
        ? "running"
        : name === "terminated"
          ? "gone"
          : "stopped";
  return detail ? { state, detail } : { state };
}

export async function ciTeardown(
  call: Ec2Call,
  homeRegion: string,
  handle: CiHandle,
): Promise<void> {
  try {
    await call(handle.region ?? homeRegion, "TerminateInstances", { "InstanceId.1": handle.id });
  } catch (err) {
    if (code(err) === "InvalidInstanceID.NotFound") return;
    throw err;
  }
}

export async function ciListTagged(
  call: Ec2Call,
  homeRegion: string,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const region of regions.length > 0 ? [...new Set(regions)] : [homeRegion]) {
    let nextToken: string | undefined;
    do {
      const data = await call<Record<string, unknown>>(region, "DescribeInstances", {
        "Filter.1.Name": "tag-key",
        "Filter.1.Value.1": tagKey,
        "Filter.2.Name": "instance-state-name",
        "Filter.2.Value.1": "pending",
        "Filter.2.Value.2": "running",
        "Filter.2.Value.3": "stopping",
        "Filter.2.Value.4": "stopped",
        "Filter.2.Value.5": "shutting-down",
        MaxResults: "200",
        ...(nextToken ? { NextToken: nextToken } : {}),
      });
      for (const instance of instancesOf(data)) {
        if (!instance.instanceId) continue;
        const state = instance.instanceState?.name ?? "";
        out.push({
          handle: handleOf(instance.instanceId, region),
          tags: tagsOf(instance),
          ...(instance.launchTime ? { createdAt: instance.launchTime } : {}),
          live: state === "pending" || state === "running",
        });
      }
      nextToken = typeof data["nextToken"] === "string" ? data["nextToken"] : undefined;
    } while (nextToken);
  }
  return out;
}

/**
 * Everything tagged in `regions` (the connection's own when empty), across
 * EC2, ECS and CodeBuild. A kind this key may not list has nothing it could
 * have started, so it does not hide the others.
 */
export async function awsCiListTagged(
  call: Ec2Call,
  calls: AwsCiCalls,
  homeRegion: string,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const quiet = async (list: Promise<CiTaggedCompute[]>): Promise<CiTaggedCompute[]> => {
    try {
      return await list;
    } catch (err) {
      if (isClosedToKey(err)) return [];
      throw err;
    }
  };
  const out = await ciListTagged(call, homeRegion, tagKey, regions);
  for (const region of regions.length > 0 ? [...new Set(regions)] : [homeRegion]) {
    out.push(...(await quiet(ecsListTagged(calls, region, tagKey))));
    out.push(...(await quiet(codebuildListTagged(calls, region, tagKey))));
  }
  return out;
}
