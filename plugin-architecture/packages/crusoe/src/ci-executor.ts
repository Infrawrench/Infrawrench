/**
 * CI jobs on Crusoe Cloud: one fresh VM per job, started with the host's
 * bootstrap as its startup script and deleted when the job ends.
 *
 * **Wire shapes verified against Crusoe's API document
 * (`api.crusoecloud.com/v1/openapi.json`, the one `plugingen.json` names)
 * and docs (docs.crusoe.ai), November 2026:**
 * - `POST /projects/{project_id}/compute/vms/instances`
 *   (`InstancesPostRequestV1`): `name`, `type`, `location` and
 *   `ssh_public_key` are required; `image` (a curated image as
 *   `name:tag`), `startup_script`, `reservation_specification.
 *   selection_strategy` (`lowest_cost` or `on_demand`),
 *   `install_crusoe_watch_agent`. Answers an operation, polled at
 *   `.../instances/operations/{id}` until `SUCCEEDED` (its `result.id` is
 *   the VM) or `FAILED`.
 * - `GET .../instances?names=&ids=`, `DELETE .../instances/{vm_id}` (an
 *   operation too). `state` is `STATE_DEFINING`, `STATE_RESOURCING_*`,
 *   `STATE_RUNNING`, `STATE_SHUTOFF` and the like.
 * - `GET .../compute/vms/types` (`product_name` such as `a100-80gb.1x`,
 *   `h100-80gb-sxm-ib.8x`, `l40s-48gb.4x`, `c1a.4x`; `gpu_type`,
 *   `num_gpu`), `GET /compute/images?product_line=` (curated images with
 *   `supported_product_lines`), `GET /locations`.
 * - VM names: letters, digits, `_` and `-`. Lifecycle scripts: bash
 *   (`#!/bin/bash`), ASCII only, under 64 kB, run as root from `/` on every
 *   start.
 * - Billing: per second while the VM is running; a stopped on-demand VM is
 *   not billed for compute, but its OS disk is, until the VM is deleted.
 *   No minimum is documented.
 *
 * **No tags.** Crusoe VMs have no tags or labels, so the job's tags ride
 * in the VM's name (`ciInstanceName`): `iwci-<job key>`, the
 * organization's tag and, when it is not the job key itself, the job's id.
 * The run's tag is not kept: the host's reaper needs only the organization
 * and the job.
 *
 * **Project.** A Crusoe key sees every project its user belongs to, and a
 * job names no project, so jobs run in the project named `infrawrench-ci`,
 * else the only project, else the one named `default`.
 *
 * **No credentials on the machine.** The VM gets the bootstrap and a
 * throwaway SSH key whose private half is never kept (Crusoe requires one);
 * the Crusoe watch agent is not installed. On-demand capacity only, so a
 * job never takes a reservation's capacity.
 *
 * **Backstop.** The startup script powers the VM off at the job's
 * deadline, and powers it straight off again if anything starts it later
 * (Crusoe reruns startup scripts on every start). A stopped VM stops
 * billing compute and keeps billing its disk, so billing ends only when the
 * host deletes it or its reaper finds it by name.
 *
 * **Preflight.** Crusoe has no call that checks a permission, so the check
 * reads the project's VMs and VM types, and sends a delete of a VM id that
 * does not exist: a Reader's key is refused it.
 */
import {
  CI_JOB_TAG,
  CI_TAG,
  ciCloudInitScript,
  ciComputeKey,
  ciDecodeTagValue,
  ciEncodeTagValue,
  ciGpuKey,
  ciGpuMatches,
  ciHttpStatus,
  ciThrowawaySshKey,
  parseCiGpu,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { listAll, seg, type CrusoeApi } from "./api.js";
import type { components } from "./api-types.gen.js";
import { imageOption } from "./create-config.js";
import type {
  CrusoeAsyncResponse,
  CrusoeImage,
  CrusoeOperation,
  CrusoeProject,
  CrusoeVm,
  CrusoeVmType,
} from "./types.js";

export const CI_DEFAULT_MACHINE = "c1a.4x";
export const CI_DEFAULT_IMAGE = "Ubuntu 24.04";
export const CI_DEFAULT_REGION = "us-east1-a";
/** Used when no curated image names the VM type's product line. */
const FALLBACK_IMAGE = "ubuntu24.04-base-image-generic:latest";
/** The project jobs run in, when the key sees more than one. */
export const CI_PROJECT = "infrawrench-ci";
const MAX_SCRIPT_BYTES = 64 * 1024;
/** A VM id that cannot exist, for the delete probe. */
const NO_VM = "00000000-0000-0000-0000-000000000000";

export const CRUSOE_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Crusoe VM",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      // Not documented; GPU VMs with a curated image usually run within three minutes.
      typicalStartSeconds: 180,
      // Billed per second while running; no minimum is documented.
      gpus: true,
      machineSuggestions: [
        "c1a.4x",
        "c1a.8x",
        "c1a.16x",
        "l40s-48gb.1x",
        "l40s-48gb.4x",
        "a100-80gb.1x",
        "a100-80gb.8x",
        "h100-80gb-sxm-ib.8x",
        "h200-141gb-sxm-ib.8x",
      ],
    },
  ],
  helpLink: {
    label: "Give the key's user the Editor role on the project",
    url: "https://docs.crusoe.ai/identity-and-security/managing-organization-users",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  projects: { permission: "Organization member", label: "See the project jobs run in" },
  read: { permission: "Reader", label: "Follow the job's VM and find leftovers" },
  write: { permission: "Editor", label: "Create and delete the job's VM" },
} as const satisfies Record<string, CiMissingPermission>;

/** What the executor needs of the plugin's client. */
export interface CrusoeCiContext {
  api: CrusoeApi;
  projects(): Promise<CrusoeProject[]>;
  /** Polls an operation until it ends (or a slow one until a timeout); throws when it failed. */
  awaitOperation(
    projectId: string,
    typeId: string,
    response: CrusoeAsyncResponse | undefined,
  ): Promise<CrusoeOperation | undefined>;
}

/** Between the parts of a name; `ciEncodeTagValue` never writes `_` before anything but hex. */
const SEP = "_x";

function uuidOfKey(key: string): string {
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`;
}

/**
 * The VM's name, which carries its tags: `iwci-<job key>`, the
 * organization's tag, and the job's id when the key is not that id's hex.
 * Letters, digits, `-` and `_` only, and the same for every start of a job.
 */
export function ciInstanceName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  const key = ciComputeKey(spec);
  const parts = [`iwci-${key}`];
  const org = spec.tags[CI_TAG];
  if (org !== undefined) parts.push(ciEncodeTagValue(org));
  const job = spec.tags[CI_JOB_TAG];
  if (job !== undefined && job !== uuidOfKey(key)) {
    if (org === undefined) parts.push("");
    parts.push(ciEncodeTagValue(job));
  }
  return parts.join(SEP);
}

/** The tags a {@link ciInstanceName} name carries; empty for any other name. */
export function tagsOfName(name: string): Record<string, string> {
  const match = /^iwci-([0-9a-f]{32})(?:_x(.*))?$/.exec(name);
  if (!match) return {};
  const [org, job] = (match[2] ?? "").split(SEP);
  const out: Record<string, string> = {};
  if (match[2] !== undefined && org !== "") out[CI_TAG] = ciDecodeTagValue(org ?? "");
  out[CI_JOB_TAG] = job !== undefined ? ciDecodeTagValue(job) : uuidOfKey(match[1] ?? "");
  return out;
}

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`Crusoe runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

/** The project jobs run in: `infrawrench-ci`, else the only one, else `default`. */
export function chooseProject(projects: readonly CrusoeProject[]): CrusoeProject {
  const found =
    projects.find((p) => p.name === CI_PROJECT) ??
    (projects.length === 1 ? projects[0] : undefined) ??
    projects.find((p) => p.name === "default");
  if (!found) {
    throw new Error(
      projects.length === 0
        ? "This Crusoe key sees no project. Create one named infrawrench-ci for CI jobs."
        : `This Crusoe key sees ${projects.length} projects, so CI jobs need one named ${CI_PROJECT} to run in. Create it in the Crusoe console.`,
    );
  }
  return found;
}

/** A VM type's product line: its name without the `.<n>x` size. */
function productLine(productName: string): string {
  return productName.replace(/[.-]\d+x$/, "");
}

/**
 * The VM type for `cloud.gpu` (`<type>[:<count>]`) among the project's VM
 * types: one with that many GPUs whose GPU or product line is the type.
 * `h100:8` is `h100-80gb-sxm-ib.8x`, `l40s:4` is `l40s-48gb.4x`. The
 * shortest product name wins, so a plain type comes before its InfiniBand
 * or SXM variant.
 */
export function gpuVmType(types: readonly CrusoeVmType[], gpu: string): string {
  const { type, count } = parseCiGpu(gpu);
  const matches = (t: CrusoeVmType) =>
    ciGpuMatches(type, t.gpu_type) || ciGpuMatches(type, productLine(t.product_name));
  const candidates = types
    .filter((t) => t.num_gpu === count && matches(t))
    .sort((a, b) => a.product_name.length - b.product_name.length);
  const exact = candidates.find((t) => ciGpuKey(productLine(t.product_name)) === ciGpuKey(type));
  const found = exact ?? candidates[0];
  if (found) return found.product_name;
  const sizes = types.filter(matches).map((t) => t.product_name);
  if (sizes.length > 0) {
    throw new Error(
      `Crusoe has no ${type} VM with ${count} GPUs in this project. It has ${sizes.join(", ")}.`,
    );
  }
  const gpus = [
    ...new Set(types.filter((t) => t.num_gpu > 0).map((t) => productLine(t.product_name))),
  ];
  throw new Error(
    `Crusoe has no GPU VM type for \`${type}\` in this project.${gpus.length > 0 ? ` It has ${gpus.join(", ")}.` : ""}`,
  );
}

/** The curated image for a VM type: the newest Ubuntu image Crusoe lists for its product line. */
export function imageFor(images: readonly CrusoeImage[], vmType: string): string {
  const line = productLine(vmType);
  const fits = images.filter(
    (i) => (i.supported_product_lines ?? []).includes(line) && /^ubuntu/.test(i.name),
  );
  const newest = fits.sort(
    (a, b) =>
      Number(/^ubuntu24/.test(b.name)) - Number(/^ubuntu24/.test(a.name)) ||
      b.created_at.localeCompare(a.created_at),
  )[0];
  return newest ? imageOption(newest).id : FALLBACK_IMAGE;
}

/**
 * The startup script: the bootstrap behind a shutdown timer. Crusoe runs it
 * on every start, so a second start powers the VM straight off rather than
 * running the job again.
 */
export function startupScript(bootstrap: string, maxSeconds: number): string {
  const body = ciCloudInitScript(bootstrap, maxSeconds).replace(/^#![^\n]*\n/, "");
  const script = [
    "#!/bin/bash",
    "# Infrawrench CI: run the job once; any later start powers the VM off.",
    "if [ -e /var/lib/iwci-started ]; then shutdown -h now; exit 0; fi",
    "touch /var/lib/iwci-started",
    body,
  ].join("\n");
  if (/[^\x00-\x7f]/.test(script)) {
    throw new Error("Crusoe takes ASCII-only startup scripts, and this job's bootstrap is not.");
  }
  if (new TextEncoder().encode(script).length >= MAX_SCRIPT_BYTES) {
    throw new Error("This job's bootstrap is larger than Crusoe's 64 kB startup script limit.");
  }
  return script;
}

function vmHandle(vm: Pick<CrusoeVm, "id" | "location" | "name">, projectId: string): CiHandle {
  return {
    id: vm.id,
    region: vm.location,
    label: `crusoe vm ${vm.name} (${vm.location})`,
    data: { project: projectId, name: vm.name },
  };
}

async function vmsNamed(api: CrusoeApi, projectId: string, name: string): Promise<CrusoeVm[]> {
  const res = await api.get(`/projects/${seg(projectId)}/compute/vms/instances`, {
    query: { names: name },
  });
  return (res?.items ?? []).filter((vm) => vm.name === name);
}

export async function crusoeCiPreflight(
  ctx: CrusoeCiContext,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const where = region ?? CI_DEFAULT_REGION;
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  const refused = (err: unknown) => {
    const status = ciHttpStatus(err);
    return status === 401 || status === 403;
  };
  let project: CrusoeProject | undefined;
  try {
    project = chooseProject(await ctx.projects());
  } catch (err) {
    if (refused(err)) missing.push(CI_PERMISSIONS.projects);
    else problems.push(err instanceof Error ? err.message : String(err));
  }
  if (project) {
    const base = `/projects/${seg(project.id)}/compute/vms` as const;
    try {
      await ctx.api.get(`${base}/instances`, { query: { limit: "1" } });
      const types = await ctx.api.get(`${base}/types`);
      const names = (types?.items ?? []).map((t) => t.product_name);
      if (names.length > 0 && !names.includes(CI_DEFAULT_MACHINE)) {
        problems.push(
          `The ${project.name} project has no ${CI_DEFAULT_MACHINE} VM type, which a job without \`cloud.machine\` uses.`,
        );
      }
    } catch (err) {
      if (refused(err)) missing.push(CI_PERMISSIONS.read);
      else problems.push(`Crusoe refused a read: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await ctx.api.delete(`${base}/instances/${seg(NO_VM)}`);
    } catch (err) {
      if (refused(err)) missing.push(CI_PERMISSIONS.write);
    }
  }
  try {
    const locations = (await ctx.api.get("/locations"))?.items ?? [];
    if (locations.length > 0 && !locations.includes(where)) {
      problems.push(`Crusoe has no location \`${where}\`. Name one of ${locations.join(", ")}.`);
    }
  } catch {
    // Not being able to look is no reason to refuse: the start says so.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

/** The `POST .../instances` body for a job. */
export function vmBody(
  spec: CiStartSpec,
  type: string,
  image: string,
  sshKey: string,
): components["schemas"]["InstancesPostRequestV1"] {
  return {
    name: ciInstanceName(spec),
    type,
    location: spec.region ?? CI_DEFAULT_REGION,
    image,
    ssh_public_key: sshKey,
    startup_script: startupScript(spec.bootstrap, spec.maxSeconds),
    install_crusoe_watch_agent: false,
    reservation_specification: { selection_strategy: "on_demand" },
  };
}

export async function crusoeCiStart(ctx: CrusoeCiContext, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  const project = chooseProject(await ctx.projects());
  const name = ciInstanceName(spec);
  const location = spec.region ?? CI_DEFAULT_REGION;
  // The name makes a start idempotent: a retry finds what the first made.
  const [found] = await vmsNamed(ctx.api, project.id, name);
  if (found) return vmHandle(found, project.id);
  const base = `/projects/${seg(project.id)}/compute/vms` as const;
  // The host fills `machine` with the kind's default when the pipeline names
  // none, so the default beside `cloud.gpu` gives way to the GPU.
  const named = spec.machine && spec.machine !== CI_DEFAULT_MACHINE ? spec.machine : undefined;
  let type = spec.machine ?? CI_DEFAULT_MACHINE;
  if (!named && spec.gpu) {
    type = gpuVmType((await ctx.api.get(`${base}/types`))?.items ?? [], spec.gpu);
  }
  const image =
    spec.image && spec.image !== CI_DEFAULT_IMAGE
      ? spec.image
      : imageFor(
          (await ctx.api.get("/compute/images", { query: { product_line: productLine(type) } }))
            ?.items ?? [],
          type,
        );
  const body = vmBody(spec, type, image, await ciThrowawaySshKey(name));
  const op = await ctx.awaitOperation(
    project.id,
    "vm",
    await ctx.api.post(`${base}/instances`, { body }),
  );
  const id = op?.state === "SUCCEEDED" ? op.result?.id : undefined;
  if (id) return vmHandle({ id, name, location }, project.id);
  // Still being made: the name finds it once Crusoe lists it.
  const [made] = await vmsNamed(ctx.api, project.id, name);
  return made
    ? vmHandle(made, project.id)
    : {
        id: "",
        region: location,
        label: `crusoe vm ${name} (${location})`,
        data: { project: project.id, name },
      };
}

/** The job's VM, by id, or by name while its id is not known yet. */
async function vmOf(ctx: CrusoeCiContext, handle: CiHandle): Promise<CrusoeVm | undefined> {
  const project = handle.data?.["project"] ?? "";
  if (!handle.id) return (await vmsNamed(ctx.api, project, handle.data?.["name"] ?? ""))[0];
  const res = await ctx.api.get(`/projects/${seg(project)}/compute/vms/instances`, {
    query: { ids: handle.id },
  });
  return (res?.items ?? []).find((vm) => vm.id === handle.id);
}

export async function crusoeCiStatus(
  ctx: CrusoeCiContext,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  let vm: CrusoeVm | undefined;
  try {
    vm = await vmOf(ctx, handle);
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  if (!vm) return handle.id ? { state: "gone" } : { state: "starting", detail: "being created" };
  const raw = vm.state;
  const state: CiComputeStatus["state"] =
    raw === "STATE_RUNNING" || raw === "STATE_RUNNING_DEGRADED"
      ? "running"
      : raw === "STATE_DEFINING" ||
          raw === "STATE_RESOURCING_LOCATION" ||
          raw === "STATE_RESOURCING_AGENT" ||
          raw === "STATE_UNSPECIFIED"
        ? "starting"
        : "stopped";
  return { state, detail: raw };
}

function isGone(err: unknown): boolean {
  return ciHttpStatus(err) === 404 || /not found|does not exist/i.test(String(err));
}

export async function crusoeCiTeardown(ctx: CrusoeCiContext, handle: CiHandle): Promise<void> {
  const project = handle.data?.["project"] ?? "";
  const ids = handle.id
    ? [handle.id]
    : (await vmsNamed(ctx.api, project, handle.data?.["name"] ?? "")).map((vm) => vm.id);
  for (const id of ids) {
    try {
      await ctx.awaitOperation(
        project,
        "vm",
        await ctx.api.delete(`/projects/${seg(project)}/compute/vms/instances/${seg(id)}`),
      );
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }
}

/**
 * Every VM named for CI in every project the key sees. Names are per
 * project, so `regions` does not narrow it; a project the key may not read
 * has nothing it could have started.
 */
export async function crusoeCiListTagged(
  ctx: CrusoeCiContext,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const project of await ctx.projects()) {
    let vms: CrusoeVm[];
    try {
      vms = await listAll("/projects/{project_id}/compute/vms/instances", (query) =>
        ctx.api.get(`/projects/${seg(project.id)}/compute/vms/instances`, { query }),
      );
    } catch (err) {
      const status = ciHttpStatus(err);
      if (status === 403 || status === 404) continue;
      throw err;
    }
    for (const vm of vms) {
      const tags = tagsOfName(vm.name);
      if (!(tagKey in tags)) continue;
      out.push({
        handle: vmHandle(vm, project.id),
        tags,
        createdAt: vm.created_at,
        live:
          vm.state !== "STATE_SHUTOFF" &&
          vm.state !== "STATE_SHUTDOWN" &&
          vm.state !== "STATE_CRASHED",
      });
    }
  }
  return out;
}
