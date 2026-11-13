/**
 * CI jobs on Oracle Cloud: `vm` on Compute (`ci-compute.ts`) and
 * `container` on Container Instances (`ci-containers.ts`), both in the
 * tenancy's root compartment on a network made for CI (`ci-shared.ts`).
 *
 * `build` (DevOps build pipelines) is left out on purpose: a build runs
 * only inside a DevOps project, which needs a notification topic, a build
 * pipeline and a stage whose build spec is read from a code repository, and
 * the pipeline runs as a resource principal that a dynamic group and
 * policies have to grant access to its sources, logs and artifacts. That is
 * a standing project and a granted identity per connection, where every
 * other kind here starts from nothing and holds no credential.
 */
import type {
  CiComputeStatus,
  CiExecutorDeclaration,
  CiExecutorKind,
  CiHandle,
  CiPreflightResult,
  CiStartSpec,
  CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { isAuthorizationGap } from "./api.js";
import {
  CONTAINER_DEFAULT_IMAGE,
  CONTAINER_DEFAULT_MACHINE,
  containerListTagged,
  containerStart,
  containerStatus,
  containerTeardown,
} from "./ci-containers.js";
import {
  COMPUTE_DEFAULT_IMAGE,
  COMPUTE_DEFAULT_MACHINE,
  computeListTagged,
  computeStart,
  computeStatus,
  computeTeardown,
} from "./ci-compute.js";
import {
  ciCompartment,
  canList,
  findNetwork,
  missingOf,
  missingPolicies,
  type OciCiContext,
  type OciGrant,
} from "./ci-shared.js";

export const ORACLE_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "OCI Compute instance",
      defaults: { machine: COMPUTE_DEFAULT_MACHINE, image: COMPUTE_DEFAULT_IMAGE },
      typicalStartSeconds: 90,
      // Billed per second, with a one-minute minimum.
      minimumBillingSeconds: 60,
      gpus: true,
      machineSuggestions: [
        "VM.Standard.E5.Flex/1/8",
        "VM.Standard.E5.Flex/2/16",
        "VM.Standard.E5.Flex/4/32",
        "VM.Standard.E6.Flex/2/16",
        "VM.Standard.A1.Flex/4/24",
        "VM.Standard3.Flex/2/16",
        "VM.GPU.A10.1",
      ],
    },
    {
      kind: "container",
      label: "OCI Container Instance",
      defaults: { machine: CONTAINER_DEFAULT_MACHINE, image: CONTAINER_DEFAULT_IMAGE },
      typicalStartSeconds: 60,
      // Billed per second, with a one-minute minimum.
      minimumBillingSeconds: 60,
      machineSuggestions: [
        "2vcpu-8gb",
        "4vcpu-16gb",
        "8vcpu-32gb",
        "CI.Standard.A1.Flex/2/8",
        "CI.Standard.E4.Flex/2/16",
      ],
    },
  ],
  helpLink: {
    label: "Add these statements to a policy in the root compartment",
    url: "https://cloud.oracle.com/identity/domains/policies",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_GRANTS = {
  instances: {
    verb: "manage",
    resource: "instance-family",
    label: "Start, follow and terminate the job's instance",
  },
  volumes: {
    verb: "use",
    resource: "volume-family",
    label: "Give the instance its boot volume",
  },
  containers: {
    verb: "manage",
    resource: "compute-container-family",
    label: "Start, follow and delete the job's container instance",
  },
  networkMake: {
    verb: "manage",
    resource: "virtual-network-family",
    label: "Make the CI network (once per region) and attach the job to it",
  },
  networkUse: {
    verb: "use",
    resource: "virtual-network-family",
    label: "Attach the job to the CI network",
  },
} as const satisfies Record<string, OciGrant>;

function unsupported(kind: CiExecutorKind): Error {
  return new Error(`Oracle Cloud runs CI jobs of kind \`vm\` and \`container\`, not \`${kind}\`.`);
}

function kindOf(handle: CiHandle): "vm" | "container" {
  return handle.data?.["kind"] === "container" ? "container" : "vm";
}

/** Dynamic groups whose rule matches every instance in the root compartment. */
async function rootDynamicGroups(ctx: OciCiContext): Promise<string[]> {
  const tenancy = ctx.api.tenancyOcid.toLowerCase();
  let groups: Array<{ name?: string; matchingRule?: string; lifecycleState?: string }>;
  try {
    groups = await ctx.api.listAll({
      service: "identity",
      region: ctx.inventory.homeRegion,
      path: "/20160918/dynamicGroups",
      query: { compartmentId: ctx.api.tenancyOcid, limit: 1000 },
    });
  } catch (err) {
    // Not allowed to look: nothing to say either way.
    if (isAuthorizationGap(err)) return [];
    throw err;
  }
  return groups
    .filter((g) => !g.lifecycleState || g.lifecycleState === "ACTIVE")
    .filter((g) => {
      const rule = (g.matchingRule ?? "").toLowerCase().replace(/\s+/g, "");
      return (
        rule.includes(`instance.compartment.id='${tenancy}'`) ||
        rule.includes(`resource.compartment.id='${tenancy}'`)
      );
    })
    .map((g) => g.name ?? "");
}

export async function oracleCiPreflight(
  ctx: OciCiContext,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  if (kind !== "vm" && kind !== "container") throw unsupported(kind);
  const where = region ?? ctx.inventory.homeRegion;
  const problems: string[] = [];
  const network = await findNetwork(ctx, where).catch((err: unknown) => {
    if (isAuthorizationGap(err)) return null;
    throw err;
  });
  const grants: OciGrant[] =
    kind === "vm" ? [CI_GRANTS.instances, CI_GRANTS.volumes] : [CI_GRANTS.containers];
  grants.push(network?.subnetId ? CI_GRANTS.networkUse : CI_GRANTS.networkMake);
  const fromPolicies = await missingPolicies(ctx, grants);
  let missing: OciGrant[];
  if (fromPolicies) {
    missing = fromPolicies;
  } else {
    // The policies could not be read: what the key can list is all there is to go on.
    missing = [];
    const compartmentId = ciCompartment(ctx);
    const listed =
      kind === "vm"
        ? await canList(ctx, () =>
            ctx.api.get("iaas", where, "/20160918/instances", { compartmentId, limit: 1 }),
          )
        : await canList(ctx, () =>
            ctx.api.get("compute-containers", where, "/20210415/containerInstances", {
              compartmentId,
              limit: 1,
            }),
          );
    if (!listed) missing.push(kind === "vm" ? CI_GRANTS.instances : CI_GRANTS.containers);
    if (network === null) missing.push(CI_GRANTS.networkMake);
  }
  if (kind === "vm") {
    for (const name of await rootDynamicGroups(ctx)) {
      problems.push(
        `The dynamic group ${name} matches every instance in the root compartment, where CI jobs start, so a job could use whatever policies grant that group. Narrow its matching rule (to a compartment of its own, say) before running CI jobs here.`,
      );
    }
  }
  return {
    ok: missing.length === 0 && problems.length === 0,
    missing: missing.map(missingOf),
    problems,
    region: where,
  };
}

export function oracleCiStart(ctx: OciCiContext, spec: CiStartSpec): Promise<CiHandle> {
  const region = spec.region ?? ctx.inventory.homeRegion;
  if (spec.kind === "vm") return computeStart(ctx, region, spec);
  if (spec.kind === "container") return containerStart(ctx, region, spec);
  return Promise.reject(unsupported(spec.kind));
}

export function oracleCiStatus(ctx: OciCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  return kindOf(handle) === "container" ? containerStatus(ctx, handle) : computeStatus(ctx, handle);
}

export function oracleCiTeardown(ctx: OciCiContext, handle: CiHandle): Promise<void> {
  return kindOf(handle) === "container"
    ? containerTeardown(ctx, handle)
    : computeTeardown(ctx, handle);
}

/**
 * Everything tagged in `regions` (the home region when empty), across both
 * kinds. A kind this key may not list has nothing it could have started,
 * so it does not hide the other.
 */
export async function oracleCiListTagged(
  ctx: OciCiContext,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const quiet = async (list: Promise<CiTaggedCompute[]>): Promise<CiTaggedCompute[]> => {
    try {
      return await list;
    } catch (err) {
      if (isAuthorizationGap(err)) return [];
      throw err;
    }
  };
  const out: CiTaggedCompute[] = [];
  for (const region of regions.length > 0 ? [...new Set(regions)] : [ctx.inventory.homeRegion]) {
    out.push(...(await quiet(computeListTagged(ctx, tagKey, region))));
    out.push(...(await quiet(containerListTagged(ctx, tagKey, region))));
  }
  return out;
}
