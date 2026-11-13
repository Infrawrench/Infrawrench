/**
 * CI jobs on Elastic Container Instance (ECI): one container group per job
 * running the host's bootstrap as its only container, deleted when the job
 * ends.
 *
 * **Wire shapes verified against the ECI API reference (2018-08-08),
 * November 2026:**
 * - Endpoint `eci.{region}.aliyuncs.com` (the Eci `endpoints.json`).
 * - `CreateContainerGroup`: `RegionId`, `SecurityGroupId`, `VSwitchId`
 *   (several, comma-separated, lets ECI pick a zone with stock),
 *   `ContainerGroupName` (lowercase letters, digits and `-`, 2 to 128),
 *   `RestartPolicy: Never` (the default is Always), `Cpu`, `Memory` (a size
 *   off ECI's list is rounded up to the next one), `Container.N.{Name,
 *   Image, Command.N (up to 20), Arg.N (up to 10)}`, `Tag.N.{Key (up to 64
 *   characters), Value}`, `ClientToken`, `AutoCreateEip` + `EipBandwidth`
 *   (a public address to pull images and reach the host), and
 *   `ActiveDeadlineSeconds` (the group is forcibly ended after that long).
 *   No `RamRoleName`: the group has no RAM role, so its metadata service
 *   hands out no credential.
 * - `DescribeContainerGroups` (`ContainerGroupIds` as a JSON array of up to
 *   20, `Tag.N.{Key, Value}`, `Limit` up to 20, `NextToken`): `Status`
 *   Pending, Scheduling, Running, Succeeded, Failed, ScheduleFailed,
 *   Restarting, Updating, Terminating, Expired; `CreationTime`, `Tags[]`,
 *   `Events[]`. It answers an empty list, not an error, to a RAM identity
 *   that may not list.
 * - `DeleteContainerGroup` (`RegionId`, `ContainerGroupId`).
 * - VPC `DescribeEipAddresses` (`AssociatedInstanceId`, `AllocationId`;
 *   `Status` Available when unbound) and `ReleaseEipAddress`
 *   (`AllocationId`).
 *
 * The backstop is ECI's own `ActiveDeadlineSeconds`, which ends the group
 * at the job's deadline, and the container's command is the watchdog from
 * `ciContainerCommand` as well. ECI bills per second from the image pull
 * until the group stops running. ECI's documents do not say whether an
 * address `AutoCreateEip` made is released with the group, so teardown
 * notes the group's addresses before it deletes the group and releases any
 * that are left unbound after.
 */
import {
  ciBootstrapWithTools,
  ciComputeKey,
  ciContainerCommand,
  parseCiContainerSize,
  type CiComputeStatus,
  type CiHandle,
  type CiMissingPermission,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import {
  clientToken,
  codeOf,
  defaultVpc,
  ensureSecurityGroup,
  noDefaultVpc,
  sleepOf,
  tagParams,
  tagsFrom,
  vSwitches,
  type AliCiContext,
} from "./ci-shared.js";
import { isPermissionGap } from "./api.js";

export const ECI_DEFAULT_MACHINE = "2vcpu-4gb";
/** Docker's official `buildpack-deps:noble-curl` (Ubuntu 24.04 with curl). */
export const ECI_DEFAULT_IMAGE = "docker.io/library/buildpack-deps:noble-curl";
/** Mbit/s out on the group's public address, billed by traffic. */
const EIP_BANDWIDTH = 100;

export const ECI_PERMISSIONS = {
  create: { permission: "eci:CreateContainerGroup", label: "Start the job's container group" },
  describe: {
    permission: "eci:DescribeContainerGroups",
    label: "Follow it and find leftovers",
  },
  delete: { permission: "eci:DeleteContainerGroup", label: "Delete it when the job ends" },
  eips: {
    permission: "vpc:DescribeEipAddresses",
    label: "Find the group's public address at teardown",
  },
  release: {
    permission: "vpc:ReleaseEipAddress",
    label: "Release that address if ECI leaves it behind",
  },
  linkedRole: {
    permission: "ram:CreateServiceLinkedRole",
    label: "Create ECI's service-linked role (AliyunServiceRoleForECI), once",
  },
} as const satisfies Record<string, CiMissingPermission>;

export function groupName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/** ECI's `Cpu` and `Memory` for a `<n>vcpu-<m>gb` machine. */
export function eciSize(machine: string): { Cpu: number; Memory: number } {
  const size = parseCiContainerSize(machine);
  if (size) return { Cpu: size.vcpus, Memory: size.memoryGb };
  throw new Error(
    `An ECI \`machine\` is \`<vCPUs>vcpu-<GB>gb\` (e.g. ${ECI_DEFAULT_MACHINE} or 4vcpu-8gb), not \`${machine}\`.`,
  );
}

/** `CreateContainerGroup` parameters for a job (without `DryRun`). */
export function groupParams(
  spec: CiStartSpec,
  region: string,
  network: { vSwitchIds: string[]; securityGroupId: string },
): Record<string, unknown> {
  if (spec.gpu) {
    throw new Error(
      "ECI container groups here have no GPUs: use the `vm` kind with a GPU instance type for a GPU job.",
    );
  }
  const { Cpu, Memory } = eciSize(spec.machine ?? ECI_DEFAULT_MACHINE);
  const [entry, flag, ...args] = ciContainerCommand(
    ciBootstrapWithTools(spec.bootstrap),
    spec.maxSeconds,
  );
  return {
    RegionId: region,
    VSwitchId: network.vSwitchIds.join(","),
    SecurityGroupId: network.securityGroupId,
    ContainerGroupName: groupName(spec),
    RestartPolicy: "Never",
    Cpu,
    Memory,
    Container: [
      {
        Name: "job",
        Image: spec.image ?? ECI_DEFAULT_IMAGE,
        Command: [entry, flag],
        Arg: args,
      },
    ],
    Tag: tagParams(spec.tags, 64),
    ClientToken: clientToken(spec, "eci"),
    AutoCreateEip: true,
    EipBandwidth: EIP_BANDWIDTH,
    // The backstop: ECI ends the group once the job's time is up.
    ActiveDeadlineSeconds: Math.max(60, Math.ceil(spec.maxSeconds)),
  };
}

function handleOf(id: string, region: string): CiHandle {
  return { id, region, label: `alibaba eci ${id} (${region})`, data: { kind: "container" } };
}

/** The default VPC's vSwitches and the CI security group. */
export async function eciNetwork(
  ctx: AliCiContext,
  region: string,
): Promise<{ vSwitchIds: string[]; securityGroupId: string }> {
  const vpcId = await defaultVpc(ctx, region);
  if (!vpcId) throw noDefaultVpc(region);
  const switches = await vSwitches(ctx, region, vpcId);
  if (switches.length === 0) {
    throw new Error(`${region}'s default VPC has no vSwitch for a container group to join.`);
  }
  const securityGroupId = await ensureSecurityGroup(ctx, region, vpcId);
  // At most 10 vSwitches; ECI tries them for a zone with stock.
  return { vSwitchIds: switches.slice(0, 10).map((s) => s.VSwitchId), securityGroupId };
}

export async function eciStart(
  ctx: AliCiContext,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  // Checked before anything is made.
  eciSize(spec.machine ?? ECI_DEFAULT_MACHINE);
  const network = await eciNetwork(ctx, region);
  const res = await ctx.api.rpc<{ ContainerGroupId?: string }>(
    "eci",
    region,
    "CreateContainerGroup",
    groupParams(spec, region, network),
  );
  if (!res.ContainerGroupId) throw new Error("ECI started no container group");
  return handleOf(res.ContainerGroupId, region);
}

interface Group {
  ContainerGroupId?: string;
  Status?: string;
  CreationTime?: string;
  Tags?: Array<{ Key?: string; Value?: string }>;
  Events?: Array<{ Reason?: string; Message?: string; Type?: string }>;
}

export async function eciStatus(ctx: AliCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  const region = handle.region ?? ctx.homeRegion;
  const res = await ctx.api.rpc<{ ContainerGroups?: Group[] }>(
    "eci",
    region,
    "DescribeContainerGroups",
    { RegionId: region, ContainerGroupIds: JSON.stringify([handle.id]) },
  );
  const group = res.ContainerGroups?.[0];
  if (!group) return { state: "gone" };
  const status = group.Status ?? "";
  const state: CiComputeStatus["state"] =
    status === "Pending" || status === "Scheduling" || status === "Restarting"
      ? "starting"
      : status === "Running" || status === "Updating"
        ? "running"
        : "stopped";
  const warning = group.Events?.find((e) => e.Type === "Warning");
  return warning?.Message
    ? { state, detail: `${status}: ${warning.Message}` }
    : { state, detail: status };
}

interface Eip {
  AllocationId?: string;
  Status?: string;
}

async function eipsOf(
  ctx: AliCiContext,
  region: string,
  query: Record<string, string>,
): Promise<Eip[]> {
  const res = await ctx.api.rpc<{ EipAddresses?: { EipAddress?: Eip[] } }>(
    "vpc",
    region,
    "DescribeEipAddresses",
    { RegionId: region, PageSize: 50, ...query },
  );
  return res.EipAddresses?.EipAddress ?? [];
}

export async function eciTeardown(ctx: AliCiContext, handle: CiHandle): Promise<void> {
  const region = handle.region ?? ctx.homeRegion;
  // The group's addresses, while it still has them.
  const eips = await eipsOf(ctx, region, { AssociatedInstanceId: handle.id }).catch(
    (err: unknown) => {
      if (isPermissionGap(err)) return [];
      throw err;
    },
  );
  try {
    await ctx.api.rpc("eci", region, "DeleteContainerGroup", {
      RegionId: region,
      ContainerGroupId: handle.id,
    });
  } catch (err) {
    if (!/NotFound|NotExist/i.test(codeOf(err))) throw err;
  }
  for (const eip of eips) {
    const id = eip.AllocationId;
    if (!id) continue;
    // Unbinding follows the group's end by a few seconds.
    for (let attempt = 0; attempt < 10; attempt++) {
      const [now] = await eipsOf(ctx, region, { AllocationId: id });
      if (!now) break; // ECI released it with the group.
      if (now.Status === "Available") {
        await ctx.api.rpc("vpc", region, "ReleaseEipAddress", {
          RegionId: region,
          AllocationId: id,
        });
        break;
      }
      await sleepOf(ctx)(3000);
    }
  }
}

export async function eciListTagged(
  ctx: AliCiContext,
  tagKey: string,
  region: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  let next: string | undefined;
  do {
    const res = await ctx.api.rpc<{ ContainerGroups?: Group[]; NextToken?: string }>(
      "eci",
      region,
      "DescribeContainerGroups",
      {
        RegionId: region,
        Tag: [{ Key: tagKey }],
        Limit: 20,
        ...(next ? { NextToken: next } : {}),
      },
    );
    for (const group of res.ContainerGroups ?? []) {
      if (!group.ContainerGroupId) continue;
      const tags = tagsFrom(group.Tags);
      if (!(tagKey in tags)) continue;
      const status = group.Status ?? "";
      out.push({
        handle: handleOf(group.ContainerGroupId, region),
        tags,
        ...(group.CreationTime ? { createdAt: group.CreationTime } : {}),
        live: !["Succeeded", "Failed", "ScheduleFailed", "Expired", "Terminating"].includes(status),
      });
    }
    next = res.NextToken || undefined;
  } while (next);
  return out;
}
