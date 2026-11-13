/**
 * CI jobs on IBM Cloud: `vm` on Virtual Servers for VPC (`ci-vsi.ts`) and
 * `container` as Code Engine job runs (`ci-code-engine.ts`). Neither holds
 * an IBM Cloud credential: the instance has no trusted profile and its
 * metadata service is off, and the job run has no service account and no
 * compute resource token.
 *
 * `build` (Code Engine build runs) is left out on purpose: a build run
 * builds an image from a Dockerfile or with buildpacks and pushes it to a
 * registry through a push secret it must be given. It cannot run a script,
 * and a source on the machine (`source_type: local`) is uploaded by the CLI.
 *
 * IAM has no call that answers "may this key do that" without doing it, so
 * the check reads what each kind reads (a refused read names the role) and
 * the plugin's docs name the roles a start needs beyond that.
 */
import { pathEncode } from "@infrawrench/plugin-base";
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

import { isPermissionGap } from "./api.js";
import {
  CE_DEFAULT_IMAGE,
  CE_DEFAULT_MACHINE,
  ceListTagged,
  ceStart,
  ceStatus,
  ceTeardown,
  findProject,
} from "./ci-code-engine.js";
import { VPC_ROLE, type IbmCiContext } from "./ci-shared.js";
import {
  VSI_DEFAULT_IMAGE,
  VSI_DEFAULT_MACHINE,
  vsiListTagged,
  vsiStart,
  vsiStatus,
  vsiTeardown,
} from "./ci-vsi.js";
import { CODE_ENGINE_REGIONS, VPC_QUERY } from "./regions.js";

export const IBM_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "VPC virtual server",
      defaults: { machine: VSI_DEFAULT_MACHINE, image: VSI_DEFAULT_IMAGE },
      typicalStartSeconds: 90,
      gpus: true,
      machineSuggestions: [
        "bx2-2x8",
        "bx2-4x16",
        "bx3d-4x20",
        "cx2-4x8",
        "cx2-8x16",
        "bx2-8x32",
        "mx2-4x32",
        "gx3-16x80x1l4",
      ],
    },
    {
      kind: "container",
      label: "Code Engine job run",
      defaults: { machine: CE_DEFAULT_MACHINE, image: CE_DEFAULT_IMAGE },
      typicalStartSeconds: 30,
      machineSuggestions: ["1vcpu-4gb", "2vcpu-4gb", "2vcpu-8gb", "4vcpu-16gb", "8vcpu-32gb"],
    },
  ],
  helpLink: {
    label: "Assign these roles to the API key's owner",
    url: "https://cloud.ibm.com/iam/users",
  },
} as const satisfies CiExecutorDeclaration;

export const CE_ROLES = {
  platform: {
    permission: "Editor (platform role) on Code Engine",
    label: "Make the CI project once per region",
  },
  service: {
    permission: "Writer (service role) on Code Engine",
    label: "Start, follow and delete the job's run",
  },
} as const satisfies Record<string, CiMissingPermission>;

function unsupported(kind: CiExecutorKind): Error {
  return new Error(`IBM Cloud runs CI jobs of kind \`vm\` and \`container\`, not \`${kind}\`.`);
}

function kindOf(handle: CiHandle): "vm" | "container" {
  return handle.data?.["kind"] === "container" ? "container" : "vm";
}

async function refused(read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return false;
  } catch (err) {
    if (isPermissionGap(err)) return true;
    throw err;
  }
}

export async function ibmCiPreflight(
  ctx: IbmCiContext,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  const where = region ?? ctx.homeRegion;
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  if (kind === "vm") {
    const vpc = ctx.api.vpc(where);
    if (await refused(() => vpc.get("/instances", { query: { ...VPC_QUERY, limit: 1 } }))) {
      missing.push(VPC_ROLE);
    }
  } else if (kind === "container") {
    if (!CODE_ENGINE_REGIONS.has(where)) {
      problems.push(`Code Engine is not offered in ${where}.`);
    } else {
      let project: Awaited<ReturnType<typeof findProject>> = null;
      try {
        project = await findProject(ctx, where);
      } catch (err) {
        if (!isPermissionGap(err)) throw err;
        missing.push(CE_ROLES.platform);
      }
      const id = project?.id;
      if (
        id &&
        (await refused(() =>
          ctx.api
            .codeEngine(where)
            .get(`/projects/${pathEncode(id)}/job_runs`, { query: { limit: 1 } }),
        ))
      ) {
        missing.push(CE_ROLES.service);
      }
    }
  } else {
    throw unsupported(kind);
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

export function ibmCiStart(ctx: IbmCiContext, spec: CiStartSpec): Promise<CiHandle> {
  const region = spec.region ?? ctx.homeRegion;
  if (spec.kind === "vm") return vsiStart(ctx, region, spec);
  if (spec.kind === "container") return ceStart(ctx, region, spec);
  return Promise.reject(unsupported(spec.kind));
}

export function ibmCiStatus(ctx: IbmCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  return kindOf(handle) === "container" ? ceStatus(ctx, handle) : vsiStatus(ctx, handle);
}

export function ibmCiTeardown(ctx: IbmCiContext, handle: CiHandle): Promise<void> {
  return kindOf(handle) === "container" ? ceTeardown(ctx, handle) : vsiTeardown(ctx, handle);
}

/**
 * Everything tagged in `regions` (the default region when empty), across
 * both kinds. A kind this key may not list has nothing it could have
 * started, so it does not hide the other.
 */
export async function ibmCiListTagged(
  ctx: IbmCiContext,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const quiet = async (list: () => Promise<CiTaggedCompute[]>): Promise<CiTaggedCompute[]> => {
    try {
      return await list();
    } catch (err) {
      if (isPermissionGap(err)) return [];
      throw err;
    }
  };
  const out: CiTaggedCompute[] = [];
  for (const region of regions.length > 0 ? [...new Set(regions)] : [ctx.homeRegion]) {
    out.push(...(await quiet(() => vsiListTagged(ctx, tagKey, region))));
    out.push(...(await quiet(() => ceListTagged(ctx, tagKey, region))));
  }
  return out;
}
