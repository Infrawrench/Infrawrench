/**
 * CI jobs on Alibaba Cloud: `vm` on ECS (`ci-ecs.ts`) and `container` on
 * Elastic Container Instance (`ci-eci.ts`), both in the region's default
 * VPC behind a security group made for CI (`ci-shared.ts`). Neither has a
 * RAM role, so a job holds no Alibaba Cloud credential.
 *
 * RAM has no call that answers "may this key do that" without doing it,
 * so the check reads what it can (a refused read names its action), dry
 * runs what takes a dry run, and names the rest in the plugin's docs. Only
 * DeleteInstances documents that its dry run checks RAM; RunInstances and
 * CreateContainerGroup document parameters, limits and stock, so a refusal
 * there is named but a pass is not proof.
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

import { isPermissionGap, isServiceUnavailable } from "./api.js";
import {
  ECI_DEFAULT_IMAGE,
  ECI_DEFAULT_MACHINE,
  ECI_PERMISSIONS,
  eciListTagged,
  eciStart,
  eciStatus,
  eciTeardown,
  groupParams,
} from "./ci-eci.js";
import {
  ECS_DEFAULT_IMAGE,
  ECS_DEFAULT_MACHINE,
  ECS_PERMISSIONS,
  ecsImage,
  ecsListTagged,
  ecsStart,
  ecsStatus,
  ecsTeardown,
  runParams,
} from "./ci-ecs.js";
import { defaultVSwitch } from "./create.js";
import {
  codeOf,
  defaultVpc,
  dryRun,
  errorText,
  findSecurityGroup,
  isDryRunPass,
  nowOf,
  readAllowed,
  vSwitches,
  type AliCiContext,
} from "./ci-shared.js";
import { productInRegion } from "./regions.js";

export const ALIBABA_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "ECS instance",
      defaults: { machine: ECS_DEFAULT_MACHINE, image: ECS_DEFAULT_IMAGE },
      typicalStartSeconds: 60,
      // Per second, with a floor of 5 minutes at 2 vCPUs (10 at 1, 2 at 4 or more).
      minimumBillingSeconds: 300,
      gpus: true,
      machineSuggestions: [
        "ecs.g8i.large",
        "ecs.g8i.xlarge",
        "ecs.c8i.xlarge",
        "ecs.c8i.2xlarge",
        "ecs.g8a.xlarge",
        "ecs.u1-c1m2.xlarge",
        "ecs.g8y.xlarge",
        "ecs.gn7i-c8g1.2xlarge",
      ],
    },
    {
      kind: "container",
      label: "ECI container group",
      defaults: { machine: ECI_DEFAULT_MACHINE, image: ECI_DEFAULT_IMAGE },
      typicalStartSeconds: 45,
      machineSuggestions: ["1vcpu-2gb", "2vcpu-4gb", "4vcpu-8gb", "8vcpu-16gb", "16vcpu-32gb"],
    },
  ],
  helpLink: {
    label: "Grant these actions to the RAM user",
    url: "https://ram.console.alibabacloud.com/users",
  },
} as const satisfies CiExecutorDeclaration;

function unsupported(kind: CiExecutorKind): Error {
  return new Error(`Alibaba Cloud runs CI jobs of kind \`vm\` and \`container\`, not \`${kind}\`.`);
}

function kindOf(handle: CiHandle): "vm" | "container" {
  return handle.data?.["kind"] === "container" ? "container" : "vm";
}

/** A preflight's findings, as it gathers them. */
class Findings {
  readonly missing: CiMissingPermission[] = [];
  readonly problems: string[] = [];

  need(permission: CiMissingPermission): void {
    if (!this.missing.some((m) => m.permission === permission.permission)) {
      this.missing.push(permission);
    }
  }

  result(region: string): CiPreflightResult {
    return {
      ok: this.missing.length === 0 && this.problems.length === 0,
      missing: this.missing,
      problems: this.problems,
      region,
    };
  }
}

/** The default VPC and the CI group, noting what the key may not read. */
async function network(
  ctx: AliCiContext,
  region: string,
  found: Findings,
): Promise<{ vpcId: string; securityGroupId: string | null } | null> {
  let vpcId: string | null;
  try {
    vpcId = await defaultVpc(ctx, region);
  } catch (err) {
    if (!isPermissionGap(err)) throw err;
    found.need(ECS_PERMISSIONS.vpcs);
    return null;
  }
  if (!vpcId) {
    found.problems.push(
      `${region} has no default VPC, which CI jobs start in. Create one in the VPC console, or use another region.`,
    );
    return null;
  }
  if (!(await readAllowed(() => vSwitches(ctx, region, vpcId))))
    found.need(ECS_PERMISSIONS.switches);
  let securityGroupId: string | null = null;
  try {
    securityGroupId = await findSecurityGroup(ctx, region, vpcId);
  } catch (err) {
    if (!isPermissionGap(err)) throw err;
    found.need(ECS_PERMISSIONS.groups);
  }
  return { vpcId, securityGroupId };
}

async function ecsPreflight(ctx: AliCiContext, region: string): Promise<CiPreflightResult> {
  const found = new Findings();
  const net = await network(ctx, region, found);
  if (
    !(await readAllowed(() =>
      ctx.api.rpc("ecs", region, "DescribeInstances", { RegionId: region, MaxResults: 10 }),
    ))
  ) {
    found.need(ECS_PERMISSIONS.describe);
  }
  // A well-formed id that does not exist: DeleteInstances' dry run checks RAM first.
  try {
    await ctx.api.rpc("ecs", region, "DeleteInstances", {
      RegionId: region,
      InstanceId: ["i-000000000000000000ff"],
      Force: true,
      DryRun: true,
    });
  } catch (err) {
    if (isPermissionGap(err)) found.need(ECS_PERMISSIONS.delete);
    else if (!isDryRunPass(err) && !/NotFound/i.test(codeOf(err))) {
      found.problems.push(`ECS refused a test release in ${region}: ${errorText(err)}`);
    }
  }
  if (net?.securityGroupId) {
    // The whole launch as a dry run, once the CI group is there to name.
    try {
      const vswitch = await defaultVSwitch(ctx.list, region, ECS_DEFAULT_MACHINE);
      const imageId = await ecsImage(ctx, region, ECS_DEFAULT_MACHINE, undefined);
      const spec: CiStartSpec = {
        kind: "vm",
        bootstrap: "#!/bin/sh\ntrue\n",
        tags: { "infrawrench-ci": "preflight" },
        name: "infrawrench-ci-preflight",
        maxSeconds: 600,
      };
      const params = runParams(
        spec,
        region,
        {
          zoneId: vswitch.ZoneId,
          vSwitchId: vswitch.VSwitchId,
          securityGroupId: net.securityGroupId,
        },
        imageId,
        nowOf(ctx),
      );
      const outcome = await dryRun(
        () => ctx.api.rpc("ecs", region, "RunInstances", { ...params, DryRun: true }),
        ECS_PERMISSIONS.run,
      );
      if (outcome?.missing) found.need(outcome.missing);
      if (outcome?.problem) {
        found.problems.push(`ECS refused a test launch in ${region}: ${outcome.problem}`);
      }
    } catch (err) {
      if (isPermissionGap(err)) found.need(ECS_PERMISSIONS.images);
      else found.problems.push(errorText(err));
    }
  }
  return found.result(region);
}

async function eciPreflight(ctx: AliCiContext, region: string): Promise<CiPreflightResult> {
  const found = new Findings();
  if (!productInRegion("eci", region)) {
    found.problems.push(`Elastic Container Instance is not offered in ${region}.`);
    return found.result(region);
  }
  const net = await network(ctx, region, found);
  if (
    !(await readAllowed(() =>
      ctx.api.rpc("vpc", region, "DescribeEipAddresses", { RegionId: region, PageSize: 10 }),
    ))
  ) {
    found.need(ECI_PERMISSIONS.eips);
  }
  if (net?.securityGroupId) {
    const switches = await vSwitches(ctx, region, net.vpcId).catch(() => []);
    if (switches.length > 0) {
      const spec: CiStartSpec = {
        kind: "container",
        bootstrap: "#!/bin/sh\ntrue\n",
        tags: { "infrawrench-ci": "preflight" },
        name: "infrawrench-ci-preflight",
        maxSeconds: 600,
      };
      const params = groupParams(spec, region, {
        vSwitchIds: switches.slice(0, 10).map((s) => s.VSwitchId),
        securityGroupId: net.securityGroupId,
      });
      const outcome = await dryRun(
        () => ctx.api.rpc("eci", region, "CreateContainerGroup", { ...params, DryRun: true }),
        ECI_PERMISSIONS.create,
      );
      if (outcome?.missing) found.need(outcome.missing);
      if (outcome?.problem) {
        if (/CreateServiceLinkedRole/i.test(outcome.problem)) {
          found.need(ECI_PERMISSIONS.linkedRole);
        } else if (/NotOpen|NotActivated|ServiceNotEnabled/i.test(outcome.problem)) {
          found.problems.push(
            `Elastic Container Instance is not activated for this account. Activate it in the ECI console first.`,
          );
        } else {
          found.problems.push(
            `ECI refused a test container group in ${region}: ${outcome.problem}`,
          );
        }
      }
    }
  }
  return found.result(region);
}

export function alibabaCiPreflight(
  ctx: AliCiContext,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  const where = region ?? ctx.homeRegion;
  if (kind === "vm") return ecsPreflight(ctx, where);
  if (kind === "container") return eciPreflight(ctx, where);
  return Promise.reject(unsupported(kind));
}

export function alibabaCiStart(ctx: AliCiContext, spec: CiStartSpec): Promise<CiHandle> {
  const region = spec.region ?? ctx.homeRegion;
  if (spec.kind === "vm") return ecsStart(ctx, region, spec);
  if (spec.kind === "container") {
    if (!productInRegion("eci", region)) {
      return Promise.reject(new Error(`Elastic Container Instance is not offered in ${region}.`));
    }
    return eciStart(ctx, region, spec);
  }
  return Promise.reject(unsupported(spec.kind));
}

export function alibabaCiStatus(ctx: AliCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  return kindOf(handle) === "container" ? eciStatus(ctx, handle) : ecsStatus(ctx, handle);
}

export function alibabaCiTeardown(ctx: AliCiContext, handle: CiHandle): Promise<void> {
  return kindOf(handle) === "container" ? eciTeardown(ctx, handle) : ecsTeardown(ctx, handle);
}

/**
 * Everything tagged in `regions` (the default region when empty), across
 * both kinds. A kind this key may not list, or a region without ECI, has
 * nothing it could have started, so it does not hide the other.
 */
export async function alibabaCiListTagged(
  ctx: AliCiContext,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const quiet = async (list: () => Promise<CiTaggedCompute[]>): Promise<CiTaggedCompute[]> => {
    try {
      return await list();
    } catch (err) {
      if (isPermissionGap(err) || isServiceUnavailable(err)) return [];
      throw err;
    }
  };
  const out: CiTaggedCompute[] = [];
  for (const region of regions.length > 0 ? [...new Set(regions)] : [ctx.homeRegion]) {
    out.push(...(await quiet(() => ecsListTagged(ctx, tagKey, region))));
    if (productInRegion("eci", region)) {
      out.push(...(await quiet(() => eciListTagged(ctx, tagKey, region))));
    }
  }
  return out;
}
