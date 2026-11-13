/**
 * CI jobs as Cloud Run jobs: one job per CI job, created and started in a
 * single call, deleted when the job ends.
 *
 * **Wire shapes verified against the Cloud Run Admin API v2 Discovery
 * document and docs, November 2026:**
 * - `POST /v2/projects/{p}/locations/{l}/jobs?jobId=` with `Job.{labels,
 *   annotations, startExecutionToken, template: ExecutionTemplate.{taskCount,
 *   template: TaskTemplate.{containers[].{image, command, args,
 *   resources.limits.{cpu, memory}}, timeout, maxRetries, serviceAccount}}}`.
 *   `startExecutionToken` starts an execution with the job ("The sum of job
 *   name and token length must be fewer than 63 characters").
 * - `GET .../jobs/{job}`, `GET .../jobs/{job}/executions` (`runningCount`,
 *   `succeededCount`, `failedCount`, `cancelledCount`, `startTime`,
 *   `completionTime`), `DELETE .../jobs/{job}` ("Deleting a job terminates
 *   all the job executions in progress"), and `GET .../jobs` (no filter).
 * - Task timeout up to 168 hours; CPU 1, 2, 4, 6 or 8 with memory from 512 MiB
 *   up to 4 GiB per vCPU (2 GiB minimum at 4 vCPUs, 4 GiB at 6 and 8).
 *   Docker Hub's official images may be used.
 *
 * Cloud Run always runs a task as a service account, the project's default
 * one unless told otherwise, and the task can fetch that account's token, so
 * the job runs as `infrawrench-ci-runner`, which has no roles. The task's own
 * timeout is the backstop.
 */
import {
  ciComputeKey,
  parseCiContainerSize,
  type CiComputeStatus,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import {
  ensureServiceAccount,
  errorText,
  isApiDisabled,
  labelsOf,
  missingOnProject,
  missingServiceAccountPermissions,
  parseTags,
  retryWhileAccountSettles,
  serviceAccountEmail,
  statusOf,
  type GcpCiCalls,
} from "./ci-shared.js";

export const RUN_DEFAULT_MACHINE = "2vcpu-4gb";
/** Docker's official `buildpack-deps:noble-curl` (Ubuntu 24.04 with curl). */
export const RUN_DEFAULT_IMAGE = "docker.io/library/buildpack-deps:noble-curl";
const TAGS_ANNOTATION = "infrawrench.com/ci-tags";
const JOB_PREFIX = "iwci-";
/** Cloud Run's longest task timeout: 168 hours. */
const MAX_TIMEOUT_SECONDS = 168 * 3600;

export const RUN_PERMISSIONS = {
  create: { permission: "run.jobs.create", label: "Create the job's Cloud Run job" },
  run: { permission: "run.jobs.run", label: "Start it" },
  get: { permission: "run.jobs.get", label: "Follow it" },
  list: { permission: "run.jobs.list", label: "Find leftovers" },
  executions: { permission: "run.executions.list", label: "Follow its execution" },
  delete: { permission: "run.jobs.delete", label: "Delete it when the job ends" },
} as const satisfies Record<string, CiMissingPermission>;

/** Cloud Run's CPU and memory limits for a `<n>vcpu-<m>gb` machine. */
export function runResources(machine: string): { cpu: string; memory: string } {
  const size = parseCiContainerSize(machine);
  const allowed: Record<number, [number, number]> = {
    1: [0.5, 4],
    2: [0.5, 8],
    4: [2, 16],
    6: [4, 24],
    8: [4, 32],
  };
  const range = size ? allowed[size.vcpus] : undefined;
  if (size && range && size.memoryGb >= range[0] && size.memoryGb <= range[1]) {
    const mib = Math.round(size.memoryGb * 1024);
    return { cpu: String(size.vcpus), memory: mib % 1024 === 0 ? `${mib / 1024}Gi` : `${mib}Mi` };
  }
  throw new Error(
    `Cloud Run sizes a job by vCPUs (1, 2, 4, 6 or 8) and memory, as \`<vCPUs>vcpu-<GiB>gb\` (e.g. ${RUN_DEFAULT_MACHINE} or 4vcpu-16gb), not \`${machine}\`.`,
  );
}

export function jobId(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `${JOB_PREFIX}${ciComputeKey(spec)}`;
}

function jobsUrl(project: string, region: string): string {
  return `https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/jobs`;
}

/** The job, as `jobs.create` takes it. */
export function jobBody(spec: CiStartSpec, project: string): Record<string, unknown> {
  const { cpu, memory } = runResources(spec.machine ?? RUN_DEFAULT_MACHINE);
  return {
    labels: labelsOf(spec.tags),
    annotations: { [TAGS_ANNOTATION]: JSON.stringify(spec.tags) },
    // Starts the one execution with the job; the job name is 37 characters.
    startExecutionToken: "run",
    template: {
      taskCount: 1,
      template: {
        containers: [
          {
            image: spec.image ?? RUN_DEFAULT_IMAGE,
            command: ["/bin/sh", "-c"],
            args: [spec.bootstrap],
            resources: { limits: { cpu, memory } },
          },
        ],
        // The backstop: Cloud Run stops the task once the job's time is up.
        timeout: `${Math.min(MAX_TIMEOUT_SECONDS, Math.max(60, Math.ceil(spec.maxSeconds)))}s`,
        maxRetries: 0,
        serviceAccount: serviceAccountEmail(project),
      },
    },
  };
}

function handleOf(name: string, region: string): CiHandle {
  return {
    id: name,
    region,
    label: `gcp run job ${name} (${region})`,
    data: { kind: "container" },
  };
}

export async function runPreflight(calls: GcpCiCalls, region: string): Promise<CiPreflightResult> {
  const missing = [
    ...(await missingOnProject(calls, Object.values(RUN_PERMISSIONS))),
    ...(await missingServiceAccountPermissions(calls)),
  ];
  const problems: string[] = [];
  try {
    await calls.call("GET", `${jobsUrl(calls.project, region)}?pageSize=1`);
  } catch (err) {
    if (isApiDisabled(err)) problems.push(errorText(err));
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region };
}

export async function runStart(
  calls: GcpCiCalls,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  if (spec.gpu) {
    throw new Error(
      "Cloud Run jobs here have no GPUs: use the `vm` kind (Compute Engine) for a GPU job.",
    );
  }
  const body = jobBody(spec, calls.project);
  const fresh = await ensureServiceAccount(calls);
  const name = jobId(spec);
  await retryWhileAccountSettles(calls, fresh, async () => {
    try {
      await calls.call("POST", `${jobsUrl(calls.project, region)}?jobId=${name}`, body);
    } catch (err) {
      // The name is the job's: an earlier start made it, and started it.
      if (statusOf(err) !== 409) throw err;
    }
  });
  return handleOf(name, region);
}

interface Execution {
  runningCount?: number;
  succeededCount?: number;
  failedCount?: number;
  cancelledCount?: number;
  startTime?: string;
  completionTime?: string;
}

export async function runStatus(calls: GcpCiCalls, handle: CiHandle): Promise<CiComputeStatus> {
  const region = handle.region ?? "";
  let executions: Execution[];
  try {
    const page = await calls.call<{ executions?: Execution[] }>(
      "GET",
      `${jobsUrl(calls.project, region)}/${encodeURIComponent(handle.id)}/executions`,
    );
    executions = page.executions ?? [];
  } catch (err) {
    if (statusOf(err) === 404) return { state: "gone" };
    throw err;
  }
  const execution = executions[0];
  if (!execution) return { state: "starting" };
  if (execution.completionTime) {
    // The job lingers (it costs nothing) until it is deleted.
    const how = (execution.succeededCount ?? 0) > 0 ? "succeeded" : "failed or was cancelled";
    return { state: "stopped", detail: `The execution ${how}.` };
  }
  return (execution.runningCount ?? 0) > 0 ? { state: "running" } : { state: "starting" };
}

export async function runTeardown(calls: GcpCiCalls, handle: CiHandle): Promise<void> {
  try {
    await calls.call(
      "DELETE",
      `${jobsUrl(calls.project, handle.region ?? "")}/${encodeURIComponent(handle.id)}`,
    );
  } catch (err) {
    if (statusOf(err) === 404) return;
    throw err;
  }
}

interface Job {
  name?: string;
  createTime?: string;
  annotations?: Record<string, string>;
  latestCreatedExecution?: { completionTime?: string };
}

export async function runListTagged(
  calls: GcpCiCalls,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const region of new Set(regions)) {
    let pageToken: string | undefined;
    try {
      do {
        const params = new URLSearchParams({
          pageSize: "100",
          ...(pageToken ? { pageToken } : {}),
        });
        const page = await calls.call<{ jobs?: Job[]; nextPageToken?: string }>(
          "GET",
          `${jobsUrl(calls.project, region)}?${params}`,
        );
        for (const job of page.jobs ?? []) {
          const id = job.name?.split("/").pop() ?? "";
          if (!id.startsWith(JOB_PREFIX)) continue;
          const tags = parseTags(job.annotations?.[TAGS_ANNOTATION]);
          if (!tags || !(tagKey in tags)) continue;
          out.push({
            handle: handleOf(id, region),
            tags,
            ...(job.createTime ? { createdAt: job.createTime } : {}),
            live: !job.latestCreatedExecution?.completionTime,
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (err) {
      // Cloud Run never switched on here: nothing has run.
      if (isApiDisabled(err)) continue;
      throw err;
    }
  }
  return out;
}
