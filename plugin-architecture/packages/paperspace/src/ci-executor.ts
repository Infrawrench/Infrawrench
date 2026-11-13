/**
 * CI jobs on Paperspace: one fresh machine per job, started with the host's
 * bootstrap as a run-once startup script and deleted, with the script, when
 * the job ends.
 *
 * **Wire shapes verified against Paperspace's OpenAPI document
 * (`api.paperspace.com/v1/openapi.json`, the one `plugingen.json` names) and
 * DigitalOcean's Paperspace docs, November 2026:**
 * - `POST /machines`: `name`, `machineType` (a label such as `C5`, `A6000`,
 *   `A100-80G`, `H100`, or `A6000x4`, `H100x8` for several GPUs),
 *   `templateId` (from `GET /os-templates`, whose `availableMachineTypes`
 *   say which types each template runs on), `region` (`ny2`, `ca1`,
 *   `ams1`), `diskSize`, `publicIpType` (`dynamic`: released when the
 *   machine stops, nothing to clean up), `startupScriptId`,
 *   `autoShutdownEnabled`, `autoShutdownTimeout` (hours),
 *   `autoShutdownForce`, `emailPassword`, `startOnCreate`. Answers
 *   `{data: machine, event}`.
 * - `GET /machines?name=`, `GET`/`DELETE /machines/{id}`; `state` is
 *   `provisioning`, `starting`, `restarting`, `upgrading`, `serviceready`,
 *   `ready`, `stopping` or `off`.
 * - Startup scripts are objects of their own: `POST /startup-scripts`
 *   `{name, script, isRunOnce}`, `GET /startup-scripts?name=`, `DELETE
 *   /startup-scripts/{id}`. A Linux machine pipes its script to bash as
 *   root during boot, after the network is up (Paperspace's script guide).
 * - Billing: every Paperspace resource is billed by the hour. A machine's
 *   compute is billed only while it is on; its storage (and a static IP,
 *   which this never asks for) bills hourly until it is deleted.
 *
 * **No tags.** Machines carry no tags or labels through this API, so the
 * job's tags ride in the machine's name (`ciInstanceName`): `iwci-<job
 * key>`, then the organization's tag and, when it is not the job key
 * itself, the job's id. The run's tag is not kept: names stay short, and
 * the host's reaper needs only the organization and the job.
 *
 * **No credentials on the machine.** It gets the bootstrap and nothing
 * else; `emailPassword: false` keeps Paperspace from mailing its password.
 *
 * **Backstop.** The script powers the machine off at the job's deadline,
 * and Paperspace's auto-shutdown (forced, at the deadline rounded up to an
 * hour) does too. Powered off, the machine stops billing compute but keeps
 * billing its disk, so billing ends only when the host deletes it or its
 * reaper finds it by name. Paperspace has no auto-delete.
 *
 * **Preflight.** A Paperspace key carries no scopes to read, so the check
 * makes harmless reads (machines, startup scripts, OS templates) and checks
 * the default template runs on the default machine type.
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
  parseCiGpu,
  pathEncode,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { listAll, type PaperspaceApi } from "./api.js";

export const CI_DEFAULT_MACHINE = "C5";
export const CI_DEFAULT_IMAGE = "Ubuntu 22.04";
export const CI_DEFAULT_REGION = "ny2";
const DISK_GB = 50;

export const PAPERSPACE_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Paperspace machine",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      // Not documented; a GPU machine from a stock template is usually up in two minutes.
      typicalStartSeconds: 120,
      // Every Paperspace resource is billed by the hour.
      minimumBillingSeconds: 3600,
      gpus: true,
      machineSuggestions: [
        "C5",
        "C7",
        "A4000",
        "A5000",
        "A6000",
        "A100-80G",
        "H100",
        "A6000x4",
        "A100-80Gx8",
        "H100x8",
      ],
    },
  ],
  helpLink: {
    label: "Make a Paperspace API key in the team",
    url: "https://docs.digitalocean.com/reference/paperspace/api-keys/",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  machines: {
    permission: "Machines",
    label: "Create, follow and delete the job's machine",
  },
  scripts: {
    permission: "Startup scripts",
    label: "Hand the machine the job as a run-once startup script",
  },
  templates: { permission: "OS templates", label: "Find the Ubuntu template" },
} as const satisfies Record<string, CiMissingPermission>;

/**
 * Paperspace's GPU machine types, in the order a match is preferred, with
 * the GPU counts each comes in (`<label>x<count>` above one).
 */
const GPU_MACHINES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["H100", [1, 8]],
  ["A100-80G", [1, 8]],
  ["A100", [1, 8]],
  ["A6000", [1, 2, 4]],
  ["A5000", [1, 2, 4]],
  ["A4000", [1, 2, 4]],
  ["V100-32G", [1, 2, 4]],
  ["V100", [1]],
  ["RTX5000", [1, 2, 4]],
  ["RTX4000", [1, 2, 4]],
  ["P6000", [1, 2, 4]],
  ["P5000", [1, 2, 4]],
  ["P4000", [1, 2, 4]],
];

/** A GPU name as Paperspace's labels write it: `80gb` is `80g`, an `rtx` before an `a` model goes. */
function paperspaceGpuKey(name: string): string {
  return ciGpuKey(name)
    .replace(/(\d)gb$/, "$1g")
    .replace(/^rtx(?=a\d)/, "");
}

/**
 * The machine type for `cloud.gpu` (`<type>[:<count>]`): `A6000` for
 * `a6000`, `A6000x4` for `a6000:4`, `A100-80Gx8` for `a100-80gb:8`.
 */
export function gpuMachineType(gpu: string): string {
  const { type, count } = parseCiGpu(gpu);
  const want = paperspaceGpuKey(type);
  const found =
    GPU_MACHINES.find(([label]) => paperspaceGpuKey(label) === want) ??
    GPU_MACHINES.find(([label]) => ciGpuMatches(type, label));
  if (!found) {
    throw new Error(
      `Paperspace has no GPU machine for \`${type}\`. Name one of ${GPU_MACHINES.map(([l]) => l).join(", ")}, or a machine type in \`cloud.machine\`.`,
    );
  }
  const [label, counts] = found;
  if (!counts.includes(count)) {
    throw new Error(
      `Paperspace offers ${label} machines with ${counts.join(", ")} GPUs, not ${count}.`,
    );
  }
  return count === 1 ? label : `${label}x${count}`;
}

/**
 * The job's machine type: the pipeline's, else the GPU's, else the default.
 * The host fills `machine` with the kind's default when the pipeline names
 * none, so the default beside `cloud.gpu` gives way to the GPU.
 */
export function machineTypeOf(spec: Pick<CiStartSpec, "machine" | "gpu">): string {
  if (spec.machine && !(spec.gpu && spec.machine === CI_DEFAULT_MACHINE)) return spec.machine;
  return spec.gpu ? gpuMachineType(spec.gpu) : CI_DEFAULT_MACHINE;
}

/** Between the parts of a name; `ciEncodeTagValue` never writes `_` before anything but hex. */
const SEP = "_x";

function uuidOfKey(key: string): string {
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`;
}

/**
 * The machine's name, which carries its tags: `iwci-<job key>`, the
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
  if (kind !== "vm") throw new Error(`Paperspace runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

interface Template {
  id: string;
  name: string;
  agentType?: string;
  operatingSystemLabel?: string;
  defaultSizeGb?: number | null;
  availableMachineTypes?: { machineTypeLabel: string; isAvailable: boolean }[];
}

/**
 * The OS template an image names: its id, its exact name, or the first
 * headless Linux template whose name or OS label contains it.
 */
export async function findTemplate(api: PaperspaceApi, image: string): Promise<Template> {
  const templates = (await listAll(
    "/os-templates",
    (query) => api.get("/os-templates", { query }),
    { partial: true },
  )) as Template[];
  const want = image.trim().toLowerCase();
  const exact = templates.find((t) => t.id === image || t.name.toLowerCase() === want);
  if (exact) return exact;
  const linux = templates.filter((t) => !/windows/i.test(t.agentType ?? ""));
  const contains = (t: Template) =>
    t.name.toLowerCase().includes(want) ||
    (t.operatingSystemLabel ?? "").toLowerCase().includes(want);
  const found =
    linux.find((t) => contains(t) && /headless|server/i.test(`${t.agentType} ${t.name}`)) ??
    linux.find((t) => contains(t) && !/ml-in-a-box/i.test(t.name)) ??
    linux.find(contains);
  if (!found) {
    throw new Error(
      `Paperspace has no OS template \`${image}\`. Name an OS template such as Ubuntu 22.04, or a template id.`,
    );
  }
  return found;
}

/** Why a template cannot run a machine type, or null when it can. */
function templateProblem(template: Template, machineType: string): string | null {
  const types = template.availableMachineTypes;
  if (!types || types.length === 0) return null;
  const entry = types.find((t) => t.machineTypeLabel === machineType);
  if (!entry) {
    return `The ${template.name} template does not run on ${machineType} machines. It runs on ${types.map((t) => t.machineTypeLabel).join(", ")}.`;
  }
  if (!entry.isAvailable) {
    return `${machineType} machines are not available for the ${template.name} template right now.`;
  }
  return null;
}

export async function paperspaceCiPreflight(
  api: PaperspaceApi,
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
  try {
    await api.get("/machines", { query: { limit: 1 } });
  } catch (err) {
    if (refused(err)) missing.push(CI_PERMISSIONS.machines);
    else problems.push(`Paperspace refused a read: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await api.get("/startup-scripts", { query: { limit: 1 } });
  } catch (err) {
    if (refused(err)) missing.push(CI_PERMISSIONS.scripts);
  }
  try {
    const template = await findTemplate(api, CI_DEFAULT_IMAGE);
    const problem = templateProblem(template, CI_DEFAULT_MACHINE);
    if (problem) problems.push(problem);
  } catch (err) {
    if (refused(err)) missing.push(CI_PERMISSIONS.templates);
    else problems.push(err instanceof Error ? err.message : String(err));
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

interface Machine {
  id: string;
  name?: string;
  state?: string;
  region?: string;
  dtCreated?: string;
  dtDeleted?: string | null;
}

interface StartupScript {
  id: string;
  name?: string;
  dtCreated?: string;
  dtDeleted?: string | null;
  assignedMachineIds?: string[];
}

function machineHandle(machine: Machine, fallbackRegion: string, script?: string): CiHandle {
  const region = machine.region ?? fallbackRegion;
  return {
    id: machine.id,
    region,
    label: `paperspace machine ${machine.id} (${region})`,
    data: {
      kind: "machine",
      ...(machine.name ? { name: machine.name } : {}),
      ...(script ? { startupScript: script } : {}),
    },
  };
}

async function findMachine(api: PaperspaceApi, name: string): Promise<Machine | undefined> {
  const page = await api.get("/machines", { query: { name, limit: 10 } });
  return ((page?.items ?? []) as Machine[]).find((m) => m.name === name && !m.dtDeleted);
}

async function findScript(api: PaperspaceApi, name: string): Promise<StartupScript | undefined> {
  const page = await api.get("/startup-scripts", { query: { name, limit: 10 } });
  return ((page?.items ?? []) as StartupScript[]).find((s) => s.name === name && !s.dtDeleted);
}

async function quietly(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best effort: what is left is named for CI, so the reaper finds it.
  }
}

async function deleteIgnoringMissing(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

/** The `POST /machines` body for a job. */
export function machineBody(spec: CiStartSpec, templateId: string, scriptId: string, disk: number) {
  // Auto-shutdown counts whole hours, at least one.
  const hours = Math.min(168, Math.max(1, Math.ceil(spec.maxSeconds / 3600)));
  return {
    name: ciInstanceName(spec),
    machineType: machineTypeOf(spec),
    templateId,
    region: spec.region ?? CI_DEFAULT_REGION,
    diskSize: disk,
    publicIpType: "dynamic",
    startupScriptId: scriptId,
    autoShutdownEnabled: true,
    autoShutdownTimeout: hours,
    autoShutdownForce: true,
    autoSnapshotEnabled: false,
    takeInitialSnapshot: false,
    restorePointEnabled: false,
    emailPassword: false,
    startOnCreate: true,
  };
}

export async function paperspaceCiStart(api: PaperspaceApi, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  const name = ciInstanceName(spec);
  const region = spec.region ?? CI_DEFAULT_REGION;
  // The name makes a start idempotent: a retry finds what the first made.
  const found = await findMachine(api, name);
  if (found) return machineHandle(found, region, (await findScript(api, name))?.id);
  const machineType = machineTypeOf(spec);
  const template = await findTemplate(api, spec.image ?? CI_DEFAULT_IMAGE);
  const problem = templateProblem(template, machineType);
  if (problem) throw new Error(problem);
  const existing = await findScript(api, name);
  const script =
    existing ??
    ((await api.post("/startup-scripts", {
      body: {
        name,
        script: ciCloudInitScript(spec.bootstrap, spec.maxSeconds),
        isRunOnce: true,
      },
    })) as StartupScript);
  try {
    const disk = Math.max(DISK_GB, template.defaultSizeGb ?? DISK_GB);
    const created = await api.post("/machines", {
      body: machineBody(spec, template.id, script.id, disk),
    });
    return machineHandle(created.data as Machine, region, script.id);
  } catch (err) {
    await quietly(() => api.delete(`/startup-scripts/${pathEncode(script.id)}`));
    throw err;
  }
}

export async function paperspaceCiStatus(
  api: PaperspaceApi,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  if (handle.data?.["kind"] === "startup-script") {
    return { state: "stopped", detail: "startup script with no machine" };
  }
  let machine: Machine;
  try {
    machine = (await api.get(`/machines/${pathEncode(handle.id)}`)) as Machine;
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  if (machine.dtDeleted) return { state: "gone" };
  const status = machine.state ?? "";
  const state: CiComputeStatus["state"] =
    status === "provisioning" || status === "starting" || status === "restarting"
      ? "starting"
      : status === "ready" || status === "serviceready" || status === "upgrading"
        ? "running"
        : "stopped";
  return { state, detail: status };
}

export async function paperspaceCiTeardown(api: PaperspaceApi, handle: CiHandle): Promise<void> {
  if (handle.data?.["kind"] === "startup-script") {
    await deleteIgnoringMissing(() => api.delete(`/startup-scripts/${pathEncode(handle.id)}`));
    return;
  }
  await deleteIgnoringMissing(() => api.delete(`/machines/${pathEncode(handle.id)}`));
  const name = handle.data?.["name"];
  const script =
    handle.data?.["startupScript"] ?? (name ? (await findScript(api, name))?.id : undefined);
  if (script) {
    await deleteIgnoringMissing(() => api.delete(`/startup-scripts/${pathEncode(script)}`));
  }
}

/**
 * Every machine named for CI, and every CI startup script no machine holds
 * (left by a start that failed between the two). Names are team-wide, so
 * `regions` does not narrow it.
 */
export async function paperspaceCiListTagged(
  api: PaperspaceApi,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  const machines = (await listAll("/machines", (query) =>
    api.get("/machines", { query }),
  )) as Machine[];
  const held = new Set<string>();
  for (const machine of machines) {
    const name = machine.name ?? "";
    const tags = tagsOfName(name);
    if (!(tagKey in tags) || machine.dtDeleted) continue;
    held.add(name);
    out.push({
      handle: machineHandle(machine, ""),
      tags,
      ...(machine.dtCreated ? { createdAt: machine.dtCreated } : {}),
      live: machine.state !== "off" && machine.state !== "stopping",
    });
  }
  const scripts = (await listAll("/startup-scripts", (query) =>
    api.get("/startup-scripts", { query }),
  )) as StartupScript[];
  for (const script of scripts) {
    const name = script.name ?? "";
    const tags = tagsOfName(name);
    if (!(tagKey in tags) || script.dtDeleted || held.has(name)) continue;
    if ((script.assignedMachineIds ?? []).length > 0) continue;
    out.push({
      handle: {
        id: script.id,
        label: `paperspace startup script ${script.id}`,
        data: { kind: "startup-script", name },
      },
      tags,
      ...(script.dtCreated ? { createdAt: script.dtCreated } : {}),
      live: false,
    });
  }
  return out;
}
