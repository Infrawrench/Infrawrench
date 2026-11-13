/**
 * What the Alibaba Cloud CI executors share: how they reach Alibaba (the
 * plugin's own signed `AliApi` and its listing context, so tests fake only
 * the HTTP service), tags, the network a job starts on, and dry runs.
 *
 * **Wire shapes verified against the ECS (2014-05-26), VPC (2016-04-28)
 * and ECI (2018-08-08) API references, November 2026:**
 * - `DescribeVpcs` (`IsDefault`), `DescribeVSwitches` (`VpcId`, `ZoneId`,
 *   `IsDefault`).
 * - `DescribeSecurityGroups` (`VpcId`, `SecurityGroupName`),
 *   `CreateSecurityGroup` (`VpcId`, `SecurityGroupName`,
 *   `SecurityGroupType: enterprise`, `ClientToken`, `Tag.N`),
 *   `DescribeSecurityGroupAttribute` (`Direction: egress`) and
 *   `AuthorizeSecurityGroupEgress` (`Permissions.N.{IpProtocol: ALL,
 *   PortRange: -1/-1, DestCidrIp, Policy: accept}`). An enterprise
 *   (advanced) group denies everything in and out until a rule allows it,
 *   and, unlike a basic one, never lets its own members reach each other.
 * - Tags: up to 20 per resource; keys up to 128 characters on ECS and 64 on
 *   ECI, values up to 128, keys not starting with `aliyun` or `acs:`; kept
 *   as sent.
 * - `DryRun=true` answers an error whose code says it would have gone
 *   through (`DryRunOperation` for RunInstances, `DRYRUN.SUCCESS` for
 *   DeleteInstances, `DryRun.Success` for CreateContainerGroup), and a
 *   `Forbidden.RAM` (or other `Forbidden`) code when the RAM identity lacks
 *   the action. Only DeleteInstances documents that its dry run checks RAM;
 *   the others document parameters, limits and stock. RAM has no call that
 *   checks a permission without making the request.
 *
 * Jobs start in the region's default VPC, in a security group made for CI
 * the first time a region needs it (`infrawrench-ci`, tagged
 * `infrawrench-ci-network`, never `infrawrench-ci`, so the reaper never
 * takes it for a job's leftovers): nothing reaches a job, and jobs do not
 * reach each other.
 */
import { ciComputeKey, type CiMissingPermission } from "@infrawrench/plugin-base";

import { AliApiError, isPermissionGap, type AliApi } from "./api.js";
import type { ListContext } from "./listers.js";

export interface AliCiContext {
  api: AliApi;
  /** The plugin's listing context, for the image and vSwitch helpers in `create.ts`. */
  list: ListContext;
  homeRegion: string;
  /** The current time; a test passes a fixed one. */
  now?(): number;
  /** Waits between polls; a test passes one that does not. */
  sleep?(ms: number): Promise<void>;
}

export function sleepOf(ctx: AliCiContext): (ms: number) => Promise<void> {
  return ctx.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

export function nowOf(ctx: AliCiContext): number {
  return ctx.now ? ctx.now() : Date.now();
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function codeOf(err: unknown): string {
  return err instanceof AliApiError ? err.code : "";
}

export const SECURITY_GROUP_NAME = "infrawrench-ci";
export const NETWORK_TAG = "infrawrench-ci-network";

/** A job's tags as `Tag.N` parameters, in the order sent. */
export function tagParams(
  tags: Readonly<Record<string, string>>,
  keyMax = 128,
): Array<{ Key: string; Value: string }> {
  return Object.entries(tags)
    .slice(0, 20)
    .map(([key, value]) => ({ Key: key.slice(0, keyMax), Value: value.slice(0, 128) }));
}

/** Tags from a `Tags.Tag[]` (ECS) or `Tags[]` (ECI) answer. */
export function tagsFrom(
  raw: Array<{ Key?: string; Value?: string; TagKey?: string; TagValue?: string }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of raw ?? []) {
    const key = t.Key ?? t.TagKey;
    if (key) out[key] = t.Value ?? t.TagValue ?? "";
  }
  return out;
}

/** A client token for one create, the same on every retry: 32 hex characters. */
export function clientToken(spec: Parameters<typeof ciComputeKey>[0], what: string): string {
  return ciComputeKey({ tags: {}, name: `${what}\u0000${ciComputeKey(spec)}` });
}

/** The region's default VPC, or null when it has none. */
export async function defaultVpc(ctx: AliCiContext, region: string): Promise<string | null> {
  const res = await ctx.api.rpc<{ Vpcs?: { Vpc?: Array<{ VpcId: string }> } }>(
    "vpc",
    region,
    "DescribeVpcs",
    { RegionId: region, IsDefault: true, PageSize: 10 },
  );
  return res.Vpcs?.Vpc?.[0]?.VpcId ?? null;
}

export function noDefaultVpc(region: string): Error {
  return new Error(
    `${region} has no default VPC, which CI jobs start in. Create one in the VPC console (it is made the first time an instance is created in the region from the ECS console), or use another region.`,
  );
}

/** The vSwitches of `vpcId`, by zone. */
export async function vSwitches(
  ctx: AliCiContext,
  region: string,
  vpcId: string,
): Promise<Array<{ VSwitchId: string; ZoneId: string }>> {
  const res = await ctx.api.rpc<{
    VSwitches?: { VSwitch?: Array<{ VSwitchId: string; ZoneId: string; Status?: string }> };
  }>("vpc", region, "DescribeVSwitches", { RegionId: region, VpcId: vpcId, PageSize: 50 });
  return (res.VSwitches?.VSwitch ?? []).filter((s) => !s.Status || s.Status === "Available");
}

/**
 * The CI security group in `vpcId`, made on first use, with its one rule:
 * everything out. Checked each time, so a start that stopped between the
 * two calls is finished by the next.
 */
export async function ensureSecurityGroup(
  ctx: AliCiContext,
  region: string,
  vpcId: string,
): Promise<string> {
  const found = await findSecurityGroup(ctx, region, vpcId);
  const id = found ?? (await createSecurityGroup(ctx, region, vpcId));
  const egress = await ctx.api.rpc<{
    Permissions?: { Permission?: Array<{ DestCidrIp?: string; Policy?: string }> };
  }>("ecs", region, "DescribeSecurityGroupAttribute", {
    RegionId: region,
    SecurityGroupId: id,
    Direction: "egress",
  });
  const open = (egress.Permissions?.Permission ?? []).some(
    (p) => p.DestCidrIp === "0.0.0.0/0" && (p.Policy ?? "Accept").toLowerCase() === "accept",
  );
  if (!open) {
    await ctx.api.rpc("ecs", region, "AuthorizeSecurityGroupEgress", {
      RegionId: region,
      SecurityGroupId: id,
      Permissions: [
        {
          IpProtocol: "ALL",
          PortRange: "-1/-1",
          DestCidrIp: "0.0.0.0/0",
          Policy: "accept",
          Description: "Infrawrench CI jobs reach the internet",
        },
      ],
    });
  }
  return id;
}

async function createSecurityGroup(
  ctx: AliCiContext,
  region: string,
  vpcId: string,
): Promise<string> {
  const created = await ctx.api.rpc<{ SecurityGroupId: string }>(
    "ecs",
    region,
    "CreateSecurityGroup",
    {
      RegionId: region,
      VpcId: vpcId,
      SecurityGroupName: SECURITY_GROUP_NAME,
      SecurityGroupType: "enterprise",
      Description:
        "Infrawrench CI jobs. No inbound rules: nothing reaches a job, and jobs do not reach each other.",
      // Two jobs starting at once in a new region make one group between them.
      ClientToken: ciComputeKey({ tags: {}, name: `sg\u0000${region}\u0000${vpcId}` }),
      Tag: [{ Key: NETWORK_TAG, Value: "true" }],
    },
  );
  return created.SecurityGroupId;
}

export async function findSecurityGroup(
  ctx: AliCiContext,
  region: string,
  vpcId: string,
): Promise<string | null> {
  const res = await ctx.api.rpc<{
    SecurityGroups?: { SecurityGroup?: Array<{ SecurityGroupId: string }> };
  }>("ecs", region, "DescribeSecurityGroups", {
    RegionId: region,
    VpcId: vpcId,
    SecurityGroupName: SECURITY_GROUP_NAME,
  });
  return res.SecurityGroups?.SecurityGroup?.[0]?.SecurityGroupId ?? null;
}

/** The codes a dry run answers when the request would have gone through. */
export function isDryRunPass(err: unknown): boolean {
  return /^(DryRunOperation|DRYRUN\.SUCCESS|DryRun\.Success)$/i.test(codeOf(err));
}

/**
 * Run `call` as a dry run: null when Alibaba says it would have gone
 * through, the permission when RAM refused it, and anything else as the
 * error itself (a parameter, a stock or a quota problem the user can act on).
 */
export async function dryRun(
  call: () => Promise<unknown>,
  permission: CiMissingPermission,
): Promise<{ missing?: CiMissingPermission; problem?: string } | null> {
  try {
    await call();
    return null;
  } catch (err) {
    if (isDryRunPass(err)) return null;
    if (isPermissionGap(err)) return { missing: permission };
    return { problem: errorText(err) };
  }
}

/** A read that only says whether RAM lets the key make it. */
export async function readAllowed(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (err) {
    if (isPermissionGap(err)) return false;
    throw err;
  }
}
