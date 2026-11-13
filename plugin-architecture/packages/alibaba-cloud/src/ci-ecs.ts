/**
 * CI jobs on ECS: one pay-as-you-go instance per job, started with the
 * host's bootstrap as its user data, released when the job ends.
 *
 * **Wire shapes verified against the ECS API reference (2014-05-26),
 * November 2026:**
 * - `RunInstances`: `RegionId`, `ZoneId`, `InstanceType`, `ImageId`,
 *   `VSwitchId`, `SecurityGroupId`, `InstanceName`, `HostName`,
 *   `Description`, `InstanceChargeType: PostPaid`, `InternetChargeType:
 *   PayByTraffic`, `InternetMaxBandwidthOut` (above 0 gives the instance a
 *   public IP, released with it), `SystemDisk.{Category, Size}` (deleted
 *   with the instance by default), `UserData` (base64, at most 32 KB),
 *   `ClientToken` (idempotency, at most 64 ASCII characters),
 *   `Tag.N.{Key, Value}` (the instance and what it is made with),
 *   `AutoReleaseTime` (`yyyy-MM-ddTHH:mm:ssZ` in UTC, at least 30 minutes
 *   and at most 3 years away; seconds are dropped), `HttpTokens: required`,
 *   `Amount`, `DryRun`. No `RamRoleName`: the instance has no RAM role, so
 *   its metadata service hands out no credential.
 * - `DescribeInstances` (`InstanceIds` as a JSON array, `Tag.N.Key`,
 *   `MaxResults`, `NextToken`): `Status` Pending, Running, Starting,
 *   Stopping, Stopped; `CreationTime`, `Tags.Tag[]`.
 * - `DeleteInstances` (`InstanceId.N`, `Force: true` releases a running
 *   instance, `DryRun` checks RAM first); `InvalidInstanceIds.NotFound` is
 *   "already gone".
 *
 * The backstop is `AutoReleaseTime`: Alibaba releases the instance at the
 * job's deadline (or 30 minutes from the start, its shortest lead) even if
 * nothing else does. The user data also powers the instance off when the
 * job ends or its time is up, which stops the job but not the bill: a
 * pay-as-you-go instance shut down from inside keeps billing until it is
 * released. Pay-as-you-go bills per second from creation, with a floor of
 * 10 minutes at 1 vCPU, 5 at 2 and 2 at 4 or more.
 */
import {
  ciComputeKey,
  type CiComputeStatus,
  type CiHandle,
  type CiMissingPermission,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { defaultVSwitch, instanceArch, resolveImage } from "./create.js";
import {
  clientToken,
  codeOf,
  defaultVpc,
  ensureSecurityGroup,
  noDefaultVpc,
  nowOf,
  tagParams,
  tagsFrom,
  type AliCiContext,
} from "./ci-shared.js";

export const ECS_DEFAULT_MACHINE = "ecs.g8i.large";
export const ECS_DEFAULT_IMAGE = "Ubuntu 24.04";
const SYSTEM_DISK_GB = 40;
/** Mbit/s out, billed by traffic: the instance's way to the internet. */
const BANDWIDTH_OUT = 100;
const USER_DATA_MAX_BYTES = 32 * 1024;
/** Alibaba's shortest lead time for `AutoReleaseTime`. */
const MIN_RELEASE_LEAD_MS = 30 * 60_000;

export const ECS_PERMISSIONS = {
  run: { permission: "ecs:RunInstances", label: "Start the job's instance" },
  describe: { permission: "ecs:DescribeInstances", label: "Follow it and find leftovers" },
  delete: { permission: "ecs:DeleteInstances", label: "Release it when the job ends" },
  images: { permission: "ecs:DescribeImages", label: "Find the latest Ubuntu image" },
  stock: {
    permission: "ecs:DescribeAvailableResource",
    label: "Find a zone that has the instance type",
  },
  types: {
    permission: "ecs:DescribeInstanceTypes",
    label: "Read the instance type's architecture",
  },
  groups: {
    permission: "ecs:DescribeSecurityGroups",
    label: "Find the CI security group",
  },
  createGroup: {
    permission: "ecs:CreateSecurityGroup",
    label: "Make the CI security group (once per region)",
  },
  vpcs: { permission: "vpc:DescribeVpcs", label: "Find the default VPC" },
  switches: { permission: "vpc:DescribeVSwitches", label: "Find a vSwitch in it" },
} as const satisfies Record<string, CiMissingPermission>;

export function instanceName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/** UTF-8 text as base64, without `Buffer` (the desktop renders plugins too). */
export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** The user data: a shutdown timer, the host's bootstrap, then power off. */
export function userData(bootstrap: string, maxSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(maxSeconds / 60));
  const body = bootstrap.replace(/^#![^\n]*\n/, "");
  return [
    "#!/bin/bash",
    `shutdown -h +${minutes} >/dev/null 2>&1 || true`,
    "(",
    body,
    ")",
    "shutdown -h now",
    "",
  ].join("\n");
}

/** When Alibaba releases the instance: the job's deadline, never under its 30-minute floor. */
export function autoReleaseTime(now: number, maxSeconds: number): string {
  const at = Math.max(now + maxSeconds * 1000, now + MIN_RELEASE_LEAD_MS + 60_000);
  // Whole minutes, rounded up: Alibaba drops the seconds, which would bring it earlier.
  const minute = Math.ceil(at / 60_000) * 60_000;
  return new Date(minute).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `RunInstances` parameters for a job (without `DryRun`). */
export function runParams(
  spec: CiStartSpec,
  region: string,
  network: { zoneId: string; vSwitchId: string; securityGroupId: string },
  imageId: string,
  now: number,
): Record<string, unknown> {
  const data = base64(userData(spec.bootstrap, spec.maxSeconds));
  if (data.length > USER_DATA_MAX_BYTES) {
    throw new Error(
      `The job's start script is ${data.length} bytes as user data; ECS takes at most ${USER_DATA_MAX_BYTES}.`,
    );
  }
  const name = instanceName(spec);
  return {
    RegionId: region,
    ZoneId: network.zoneId,
    InstanceType: spec.machine ?? ECS_DEFAULT_MACHINE,
    ImageId: imageId,
    VSwitchId: network.vSwitchId,
    SecurityGroupId: network.securityGroupId,
    InstanceName: name,
    HostName: name,
    Description: spec.name.slice(0, 256),
    InstanceChargeType: "PostPaid",
    InternetChargeType: "PayByTraffic",
    InternetMaxBandwidthOut: BANDWIDTH_OUT,
    "SystemDisk.Category": "cloud_essd",
    "SystemDisk.Size": SYSTEM_DISK_GB,
    UserData: data,
    ClientToken: clientToken(spec, "ecs"),
    Tag: tagParams(spec.tags),
    AutoReleaseTime: autoReleaseTime(now, spec.maxSeconds),
    HttpTokens: "required",
    Amount: 1,
  };
}

function handleOf(id: string, region: string): CiHandle {
  return { id, region, label: `alibaba ecs ${id} (${region})`, data: { kind: "vm" } };
}

/** Where a job's instance goes: a vSwitch in the default VPC that sells the type, and the CI group. */
export async function ecsNetwork(
  ctx: AliCiContext,
  region: string,
  instanceType: string,
): Promise<{ zoneId: string; vSwitchId: string; securityGroupId: string }> {
  const vpcId = await defaultVpc(ctx, region);
  if (!vpcId) throw noDefaultVpc(region);
  const vswitch = await defaultVSwitch(ctx.list, region, instanceType);
  const securityGroupId = await ensureSecurityGroup(ctx, region, vpcId);
  return { zoneId: vswitch.ZoneId, vSwitchId: vswitch.VSwitchId, securityGroupId };
}

/** The image for a job: an image id, or Ubuntu 24.04 for the type's architecture. */
export async function ecsImage(
  ctx: AliCiContext,
  region: string,
  instanceType: string,
  image: string | undefined,
): Promise<string> {
  if (image && image !== ECS_DEFAULT_IMAGE) return image;
  const arch = await instanceArch(ctx.list, instanceType);
  return resolveImage(ctx.list, region, "ubuntu-24.04", arch);
}

export async function ecsStart(
  ctx: AliCiContext,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  if (spec.gpu && !spec.machine) {
    throw new Error(
      "On Alibaba Cloud a GPU comes with the instance type: name one in `cloud.machine`, e.g. ecs.gn7i-c8g1.2xlarge.",
    );
  }
  const instanceType = spec.machine ?? ECS_DEFAULT_MACHINE;
  const [network, imageId] = await Promise.all([
    ecsNetwork(ctx, region, instanceType),
    ecsImage(ctx, region, instanceType, spec.image),
  ]);
  // The client token makes the launch idempotent: a retry after a lost
  // answer gets the same instance rather than a second one.
  const res = await ctx.api.rpc<{ InstanceIdSets?: { InstanceIdSet?: string[] } }>(
    "ecs",
    region,
    "RunInstances",
    runParams(spec, region, network, imageId, nowOf(ctx)),
  );
  const id = res.InstanceIdSets?.InstanceIdSet?.[0];
  if (!id) throw new Error("ECS started no instance");
  return handleOf(id, region);
}

interface Instance {
  InstanceId?: string;
  Status?: string;
  CreationTime?: string;
  Tags?: { Tag?: Array<{ TagKey?: string; TagValue?: string; Key?: string; Value?: string }> };
  OperationLocks?: { LockReason?: Array<{ LockReason?: string; LockMsg?: string }> };
}

export async function ecsStatus(ctx: AliCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  const region = handle.region ?? ctx.homeRegion;
  const res = await ctx.api.rpc<{ Instances?: { Instance?: Instance[] } }>(
    "ecs",
    region,
    "DescribeInstances",
    { RegionId: region, InstanceIds: JSON.stringify([handle.id]) },
  );
  const instance = res.Instances?.Instance?.[0];
  if (!instance) return { state: "gone" };
  const status = instance.Status ?? "";
  const state: CiComputeStatus["state"] =
    status === "Pending" || status === "Starting"
      ? "starting"
      : status === "Running"
        ? "running"
        : "stopped";
  const lock = instance.OperationLocks?.LockReason?.[0];
  const detail = lock?.LockMsg ?? lock?.LockReason;
  return detail ? { state, detail: `${status}: ${detail}` } : { state, detail: status };
}

export async function ecsTeardown(ctx: AliCiContext, handle: CiHandle): Promise<void> {
  const region = handle.region ?? ctx.homeRegion;
  try {
    await ctx.api.rpc("ecs", region, "DeleteInstances", {
      RegionId: region,
      InstanceId: [handle.id],
      // Releases it whatever state it is in, running included.
      Force: true,
    });
  } catch (err) {
    if (/^InvalidInstanceIds?\.NotFound$/i.test(codeOf(err))) return;
    throw err;
  }
}

export async function ecsListTagged(
  ctx: AliCiContext,
  tagKey: string,
  region: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  let next: string | undefined;
  do {
    const res = await ctx.api.rpc<{
      Instances?: { Instance?: Instance[] };
      NextToken?: string;
    }>("ecs", region, "DescribeInstances", {
      RegionId: region,
      Tag: [{ Key: tagKey }],
      MaxResults: 100,
      ...(next ? { NextToken: next } : {}),
    });
    for (const instance of res.Instances?.Instance ?? []) {
      if (!instance.InstanceId) continue;
      const tags = tagsFrom(instance.Tags?.Tag);
      if (!(tagKey in tags)) continue;
      const status = instance.Status ?? "";
      out.push({
        handle: handleOf(instance.InstanceId, region),
        tags,
        ...(instance.CreationTime ? { createdAt: instance.CreationTime } : {}),
        live: status === "Pending" || status === "Starting" || status === "Running",
      });
    }
    next = res.NextToken || undefined;
  } while (next);
  return out;
}
