/**
 * CI jobs as Scaleway Serverless Jobs runs (`container`): a job definition
 * per job, started once, deleted with its run when the job ends.
 *
 * **Verified against the Serverless Jobs API v1alpha2 (its generated Go
 * SDK, the docs repository's reference and limits pages), November 2026.**
 * v1alpha2 is the version Scaleway recommends for new integrations; there
 * is no v1.
 * - `POST /serverless-jobs/v1alpha2/regions/{region}/job-definitions`:
 *   `name`, `project_id`, `cpu_limit` (mvCPU), `memory_limit` (MiB),
 *   `image_uri`, `startup_command` and `args` (string arrays),
 *   `job_timeout` (a duration such as `"3600s"`, at most 24 hours),
 *   `description`, `retry_policy.max_retries`. A definition has no tags, so
 *   the job's tags ride in its description as JSON.
 * - `POST .../job-definitions/{id}/start` answers `{job_runs: [...]}`;
 *   `GET .../job-runs/{id}` has `state` (`initialized`, `validated`,
 *   `queued`, `running`, `succeeded`, `failed`, `interrupting`,
 *   `interrupted`, `retrying`); `POST .../job-runs/{id}/stop`; `DELETE
 *   .../job-definitions/{id}`; `GET .../job-definitions?project_id=` and
 *   `GET .../job-runs?job_definition_id=`, paged by `page`/`page_size`.
 * - Limits: 6 vCPU, 16 GB of memory, 24 hours; the image must be
 *   `linux/amd64`. Public Docker Hub images work (Scaleway notes Docker
 *   Hub's rate limits). Billed per vCPU-second and GB-second of the run.
 * - `ServerlessJobsFullAccess` is the permission set it needs.
 *
 * The bootstrap runs behind `ciBootstrapWithTools`, which installs `bash`,
 * `curl` and the rest when the image lacks them.
 *
 * **Credentials.** The run gets the bootstrap as arguments and nothing
 * else: no environment, no secrets. Scaleway documents no credentials of
 * its own being put in a job's environment.
 *
 * **Backstop.** The definition's `job_timeout` ends the run, and the
 * watchdog the container runs under ends the bootstrap first; nothing is
 * billed once the run ends. Teardown deletes the definition.
 */
import {
  ciBootstrapWithTools,
  ciContainerCommand,
  ciHttpStatus,
  ciMachineName,
  parseCiContainerSize,
  type CiComputeStatus,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { grantedSets, lacking, projectOf, type ScwCiContext } from "./ci-shared.js";

export const JOBS_DEFAULT_MACHINE = "2vcpu-4gb";
export const JOBS_DEFAULT_IMAGE = "docker.io/library/buildpack-deps:noble-curl";
export const JOBS_DEFAULT_REGION = "fr-par";
const MAX_SECONDS = 24 * 60 * 60;
const MAX_VCPUS = 6;
const MAX_MEMORY_GB = 16;

export const JOBS_PERMISSION = {
  permission: "ServerlessJobsFullAccess",
  label: "Create, start, stop and delete the job's definition and run",
} as const satisfies CiMissingPermission;

const base = (region: string) => `/serverless-jobs/v1alpha2/regions/${region}`;

const TERMINAL = new Set(["succeeded", "failed", "interrupted"]);

export async function jobsPreflight(ctx: ScwCiContext, region: string): Promise<CiPreflightResult> {
  const missing = lacking(await grantedSets(ctx), [JOBS_PERMISSION]);
  const problems: string[] = [];
  try {
    const project = await projectOf(ctx);
    await ctx.rest.fetch(`${base(region)}/job-definitions?project_id=${project}&page_size=1`);
  } catch (err) {
    if (ciHttpStatus(err) === 403) {
      if (!missing.includes(JOBS_PERMISSION)) missing.push(JOBS_PERMISSION);
    } else {
      problems.push(`Scaleway refused a list of job definitions in ${region}: ${String(err)}`);
    }
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region };
}

interface Definition {
  id?: string;
  name?: string;
  description?: string;
  created_at?: string;
}

interface Run {
  id?: string;
  state?: string;
  error_message?: string;
  created_at?: string;
}

/** The definition for a job. */
export function definitionBody(spec: CiStartSpec, project: string) {
  const machine = spec.machine ?? JOBS_DEFAULT_MACHINE;
  const size = parseCiContainerSize(machine);
  if (!size) {
    throw new Error(
      `Serverless Jobs takes \`cloud.machine\` as \`<vCPUs>vcpu-<GiB>gb\`, e.g. 2vcpu-4gb, not \`${machine}\`.`,
    );
  }
  if (size.vcpus > MAX_VCPUS || size.memoryGb > MAX_MEMORY_GB) {
    throw new Error(`Serverless Jobs runs at most ${MAX_VCPUS} vCPUs and ${MAX_MEMORY_GB} GB.`);
  }
  if (spec.maxSeconds > MAX_SECONDS) {
    throw new Error("Serverless Jobs runs for at most 24 hours; give the job a shorter `timeout`.");
  }
  // The pipeline may name an image without bash or curl; the preamble adds them.
  const [shell = "/bin/sh", flag = "-c", ...args] = ciContainerCommand(
    ciBootstrapWithTools(spec.bootstrap),
    spec.maxSeconds,
  );
  return {
    name: ciMachineName(spec),
    project_id: project,
    cpu_limit: Math.round(size.vcpus * 1000),
    memory_limit: Math.round(size.memoryGb * 1024),
    image_uri: spec.image ?? JOBS_DEFAULT_IMAGE,
    startup_command: [shell, flag],
    args,
    job_timeout: `${Math.ceil(spec.maxSeconds)}s`,
    description: JSON.stringify(spec.tags),
    retry_policy: { max_retries: 0 },
  };
}

function jobHandle(definitionId: string, region: string, runId?: string): CiHandle {
  return {
    id: definitionId,
    region,
    label: `scaleway job ${runId ?? definitionId} (${region})`,
    data: { kind: "container", ...(runId ? { run: runId } : {}) },
  };
}

async function runsOf(ctx: ScwCiContext, region: string, definitionId: string): Promise<Run[]> {
  const { job_runs } = await ctx.rest.fetch<{ job_runs?: Run[] }>(
    `${base(region)}/job-runs?job_definition_id=${encodeURIComponent(definitionId)}&page_size=100`,
  );
  return job_runs ?? [];
}

async function definitionsIn(
  ctx: ScwCiContext,
  region: string,
  project: string,
): Promise<Definition[]> {
  const out: Definition[] = [];
  for (let page = 1; page <= 100; page++) {
    const { job_definitions } = await ctx.rest.fetch<{ job_definitions?: Definition[] }>(
      `${base(region)}/job-definitions?project_id=${project}&page_size=100&page=${page}`,
    );
    out.push(...(job_definitions ?? []));
    if ((job_definitions ?? []).length < 100) break;
  }
  return out;
}

async function startRun(ctx: ScwCiContext, region: string, definitionId: string): Promise<string> {
  const { job_runs } = await ctx.rest.fetch<{ job_runs?: Run[] }>(
    `${base(region)}/job-definitions/${encodeURIComponent(definitionId)}/start`,
    { method: "POST", body: "{}" },
  );
  const run = job_runs?.[0]?.id;
  if (!run) throw new Error("Serverless Jobs started no run");
  return run;
}

export async function jobsStart(ctx: ScwCiContext, spec: CiStartSpec): Promise<CiHandle> {
  if (spec.gpu) throw new Error("Serverless Jobs has no GPUs; leave `cloud.gpu` out.");
  const region = spec.region ?? JOBS_DEFAULT_REGION;
  const project = await projectOf(ctx);
  const body = definitionBody(spec, project);
  // The definition's name is the job's: a retry finds it, and its run.
  const found = (await definitionsIn(ctx, region, project)).find((d) => d.name === body.name);
  if (found?.id) {
    const run =
      (await runsOf(ctx, region, found.id))[0]?.id ?? (await startRun(ctx, region, found.id));
    return jobHandle(found.id, region, run);
  }
  const created = await ctx.rest.fetch<Definition>(`${base(region)}/job-definitions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!created.id) throw new Error("Serverless Jobs created no job definition");
  return jobHandle(created.id, region, await startRun(ctx, region, created.id));
}

export async function jobsStatus(ctx: ScwCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  const region = handle.region ?? JOBS_DEFAULT_REGION;
  const runId = handle.data?.["run"];
  if (!runId) return { state: "starting" };
  let run: Run;
  try {
    run = await ctx.rest.fetch<Run>(`${base(region)}/job-runs/${encodeURIComponent(runId)}`);
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = run.state ?? "";
  const state: CiComputeStatus["state"] = TERMINAL.has(status)
    ? "stopped"
    : status === "running" || status === "interrupting" || status === "retrying"
      ? "running"
      : "starting";
  const detail = run.error_message ? `${status}: ${run.error_message}` : status;
  return { state, detail };
}

export async function jobsTeardown(ctx: ScwCiContext, handle: CiHandle): Promise<void> {
  const region = handle.region ?? JOBS_DEFAULT_REGION;
  let runs: Run[];
  try {
    runs = await runsOf(ctx, region, handle.id);
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
    runs = [];
  }
  for (const run of runs) {
    if (!run.id || TERMINAL.has(run.state ?? "")) continue;
    try {
      await ctx.rest.fetch(`${base(region)}/job-runs/${encodeURIComponent(run.id)}/stop`, {
        method: "POST",
        body: "{}",
      });
    } catch (err) {
      // Ended on its own meanwhile.
      if (ciHttpStatus(err) !== 404 && ciHttpStatus(err) !== 412 && ciHttpStatus(err) !== 409) {
        throw err;
      }
    }
  }
  try {
    await ctx.rest.fetch(`${base(region)}/job-definitions/${encodeURIComponent(handle.id)}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

function tagsOfDescription(description: string | undefined): Record<string, string> | null {
  if (!description) return null;
  try {
    const parsed = JSON.parse(description) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed))
      if (typeof value === "string") out[key] = value;
    return out;
  } catch {
    return null;
  }
}

export async function jobsListTagged(
  ctx: ScwCiContext,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  if (regions.length === 0) return [];
  const project = await projectOf(ctx);
  const out: CiTaggedCompute[] = [];
  for (const region of regions) {
    for (const definition of await definitionsIn(ctx, region, project)) {
      if (!definition.id || !definition.name?.startsWith("iwci-")) continue;
      const tags = tagsOfDescription(definition.description);
      if (!tags || !(tagKey in tags)) continue;
      const runs = await runsOf(ctx, region, definition.id);
      out.push({
        handle: jobHandle(definition.id, region, runs[0]?.id),
        tags,
        ...(definition.created_at ? { createdAt: definition.created_at } : {}),
        live: runs.some((r) => !TERMINAL.has(r.state ?? "")),
      });
    }
  }
  return out;
}
