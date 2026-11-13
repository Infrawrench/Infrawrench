/**
 * CI jobs as IBM Cloud Code Engine job runs: one standalone job run per CI
 * job (no job definition), in a project made for CI the first time a
 * region needs it, deleted when the job ends.
 *
 * **Wire shapes verified against the Code Engine v2 OpenAPI document and
 * docs, November 2026** (paths typed by plugingen):
 * - `POST /projects` (`name`, `tags`; answers 202 and the project goes from
 *   `creating` to `active`), `GET /projects` (no name filter, `limit` up
 *   to 100, `next.start`), `GET /projects/{id}`. 20 projects per region.
 * - `POST /projects/{id}/job_runs` without `job_name`: `name` (at most 53 of
 *   `[a-z0-9]([-a-z0-9]*[a-z0-9])?`, unique in the project, a second
 *   answers 409), `image_reference` (Docker Hub needs no secret),
 *   `run_commands`, `run_arguments`, `run_env_variables[{type: literal,
 *   name, value}]`, `run_mode: task`, `run_service_account` (`none`: no
 *   service account token in the job), `run_compute_resource_token_enabled`
 *   (false: no token to trade for a trusted profile), `scale_array_spec`,
 *   `scale_cpu_limit` and `scale_memory_limit` (the documented
 *   combinations), `scale_ephemeral_storage_limit` (at most the memory),
 *   `scale_max_execution_time` (1 to 86,400 seconds), `scale_retry_limit`.
 * - `GET /projects/{id}/job_runs/{name}` (`status` pending, running,
 *   completed, failed), `DELETE` (202), `GET /projects/{id}/job_runs`.
 *
 * Code Engine keeps no labels on a job run, so the job's tags ride as JSON
 * in an environment variable of the run (`INFRAWRENCH_CI_TAGS`; nothing
 * secret). The backstop is the run's `scale_max_execution_time`, and the
 * command is the watchdog from `ciContainerCommand` as well. A job run
 * longer than Code Engine's 24 hours is refused at start.
 */
import {
  ciBootstrapWithTools,
  ciComputeKey,
  ciContainerCommand,
  parseCiContainerSize,
  pathEncode,
  type CiComputeStatus,
  type CiHandle,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { CODE_ENGINE_REGIONS } from "./regions.js";
import { NETWORK_NAME, ibmTag, sleepOf, statusOf, type IbmCiContext } from "./ci-shared.js";

export const CE_DEFAULT_MACHINE = "2vcpu-4gb";
/** Docker's official `buildpack-deps:noble-curl` (Ubuntu 24.04 with curl). */
export const CE_DEFAULT_IMAGE = "docker.io/library/buildpack-deps:noble-curl";
export const PROJECT_NAME = NETWORK_NAME;
const TAGS_ENV = "INFRAWRENCH_CI_TAGS";
/** Code Engine's longest run: 24 hours. */
const MAX_EXECUTION_SECONDS = 86_400;

/** vCPUs to the memory sizes Code Engine allows with them, in GB. */
const COMBINATIONS: Record<string, number[]> = {
  "0.125": [0.25, 0.5, 1],
  "0.25": [0.5, 1, 2],
  "0.5": [1, 2, 4],
  "1": [2, 4, 8],
  "2": [4, 8, 16],
  "4": [8, 16, 32],
  "6": [12, 24, 48],
  "8": [16, 32],
  "10": [20, 40],
  "12": [24, 48],
};

/** Code Engine's CPU and memory for a `<n>vcpu-<m>gb` machine. */
export function ceResources(machine: string): { cpu: string; memory: string } {
  const size = parseCiContainerSize(machine);
  if (size && COMBINATIONS[String(size.vcpus)]?.includes(size.memoryGb)) {
    const memory = Number.isInteger(size.memoryGb)
      ? `${size.memoryGb}G`
      : `${Math.round(size.memoryGb * 1000)}M`;
    return { cpu: String(size.vcpus), memory };
  }
  throw new Error(
    `Code Engine sizes a job by vCPUs and memory, as \`<vCPUs>vcpu-<GB>gb\` from its list (1vcpu-2gb, 1vcpu-4gb, 2vcpu-4gb, 2vcpu-8gb, 4vcpu-16gb, 8vcpu-32gb, ...), not \`${machine}\`.`,
  );
}

export function jobRunName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/** The job run, as `POST /job_runs` takes it. */
export function jobRunBody(spec: CiStartSpec) {
  if (spec.gpu) {
    throw new Error("Code Engine job runs have no GPUs: use the `vm` kind with a GPU profile.");
  }
  if (spec.maxSeconds > MAX_EXECUTION_SECONDS) {
    throw new Error(
      `A Code Engine job run lasts at most 24 hours; this job may take ${Math.ceil(spec.maxSeconds / 3600)}. Use the \`vm\` kind for it.`,
    );
  }
  const { cpu, memory } = ceResources(spec.machine ?? CE_DEFAULT_MACHINE);
  const [entry, flag, ...args] = ciContainerCommand(
    ciBootstrapWithTools(spec.bootstrap),
    spec.maxSeconds,
  );
  return {
    name: jobRunName(spec),
    image_reference: spec.image ?? CE_DEFAULT_IMAGE,
    run_commands: [entry!, flag!],
    run_arguments: args,
    run_env_variables: [
      { type: "literal" as const, name: TAGS_ENV, value: JSON.stringify(spec.tags) },
    ],
    run_mode: "task" as const,
    // No identity in the job: no service account token, no compute resource token.
    run_service_account: "none" as const,
    run_compute_resource_token_enabled: false,
    scale_array_spec: "0",
    scale_cpu_limit: cpu,
    scale_memory_limit: memory,
    // The most Code Engine allows: as much as the memory.
    scale_ephemeral_storage_limit: memory,
    // The backstop: Code Engine stops the run once the job's time is up.
    scale_max_execution_time: Math.max(60, Math.ceil(spec.maxSeconds)),
    scale_retry_limit: 0,
  };
}

interface Project {
  id: string;
  name?: string;
  status?: string;
}

/** The CI project in `region`, when there is one. */
export async function findProject(ctx: IbmCiContext, region: string): Promise<Project | null> {
  const ce = ctx.api.codeEngine(region);
  let start: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await ce.get("/projects", { query: { limit: 100, ...(start ? { start } : {}) } });
    const hit = (page.projects ?? []).find((p) => p.name === PROJECT_NAME);
    if (hit) return hit;
    start = page.next?.start;
    if (!start) return null;
  }
  return null;
}

/** The CI project in `region`, made on first use and waited for until it is active. */
export async function ensureProject(ctx: IbmCiContext, region: string): Promise<string> {
  const ce = ctx.api.codeEngine(region);
  let project = await findProject(ctx, region);
  if (!project) {
    try {
      project = await ce.post("/projects", {
        body: { name: PROJECT_NAME, tags: [ibmTag("infrawrench-ci-network", "true")] },
      });
    } catch (err) {
      if (statusOf(err) !== 409) throw err;
      project = await findProject(ctx, region);
      if (!project) throw err;
    }
  }
  const id = project.id;
  // A new project takes a while to become active; jobs wait for it once.
  for (let i = 0; project.status !== "active" && i < 60; i++) {
    if (project.status && /fail|delet/.test(project.status)) {
      throw new Error(`The Code Engine project ${PROJECT_NAME} in ${region} is ${project.status}.`);
    }
    await sleepOf(ctx)(5000);
    project = await ce.get(`/projects/${pathEncode(id)}`);
  }
  if (project.status !== "active") {
    throw new Error(`The Code Engine project ${PROJECT_NAME} in ${region} is not active yet.`);
  }
  return id;
}

function handleOf(name: string, region: string, project: string): CiHandle {
  return {
    id: name,
    region,
    label: `ibm code engine ${name} (${region})`,
    data: { kind: "container", project },
  };
}

export function requireCodeEngineRegion(region: string): void {
  if (!CODE_ENGINE_REGIONS.has(region)) {
    throw new Error(
      `Code Engine is not offered in ${region}. It is in ${[...CODE_ENGINE_REGIONS].join(", ")}.`,
    );
  }
}

export async function ceStart(
  ctx: IbmCiContext,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  requireCodeEngineRegion(region);
  const body = jobRunBody(spec);
  const project = await ensureProject(ctx, region);
  try {
    await ctx.api.codeEngine(region).post(`/projects/${pathEncode(project)}/job_runs`, { body });
  } catch (err) {
    // The name is the job's: an earlier start made the run.
    if (statusOf(err) !== 409) throw err;
  }
  return handleOf(body.name, region, project);
}

export async function ceStatus(ctx: IbmCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  const project = handle.data?.["project"];
  if (!project) return { state: "gone" };
  let run: { status?: string };
  try {
    run = await ctx.api
      .codeEngine(handle.region ?? ctx.homeRegion)
      .get(`/projects/${pathEncode(project)}/job_runs/${pathEncode(handle.id)}`);
  } catch (err) {
    if (statusOf(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = run.status ?? "";
  const state: CiComputeStatus["state"] =
    status === "pending" ? "starting" : status === "running" ? "running" : "stopped";
  return { state, detail: status };
}

export async function ceTeardown(ctx: IbmCiContext, handle: CiHandle): Promise<void> {
  const project = handle.data?.["project"];
  if (!project) return;
  try {
    await ctx.api
      .codeEngine(handle.region ?? ctx.homeRegion)
      .delete(`/projects/${pathEncode(project)}/job_runs/${pathEncode(handle.id)}`);
  } catch (err) {
    if (statusOf(err) === 404) return;
    throw err;
  }
}

function tagsOf(env: Array<{ name?: string; value?: string }> | undefined): Record<string, string> {
  const raw = env?.find((e) => e.name === TAGS_ENV)?.value;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export async function ceListTagged(
  ctx: IbmCiContext,
  tagKey: string,
  region: string,
): Promise<CiTaggedCompute[]> {
  if (!CODE_ENGINE_REGIONS.has(region)) return [];
  const project = await findProject(ctx, region);
  if (!project) return [];
  const ce = ctx.api.codeEngine(region);
  const out: CiTaggedCompute[] = [];
  let start: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await ce.get(`/projects/${pathEncode(project.id)}/job_runs`, {
      query: { limit: 100, ...(start ? { start } : {}) },
    });
    for (const run of page.job_runs ?? []) {
      if (!run.name?.startsWith("iwci-")) continue;
      const tags = tagsOf(run.run_env_variables);
      if (!(tagKey in tags)) continue;
      out.push({
        handle: handleOf(run.name, region, project.id),
        tags,
        ...(run.created_at ? { createdAt: run.created_at } : {}),
        live: run.status === "pending" || run.status === "running",
      });
    }
    start = page.next?.start;
    if (!start) break;
  }
  return out;
}
