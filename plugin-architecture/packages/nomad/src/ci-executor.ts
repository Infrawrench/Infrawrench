/**
 * CI jobs on a Nomad cluster: one batch job per CI job, a single task on the
 * `docker` driver, in a namespace the pipeline names (`cloud.region`) or
 * `default`.
 *
 * **Wire shapes verified against the Nomad HTTP API docs and Nomad's source
 * (v2.1, the same since 1.9), November 2026:**
 * - `POST /v1/jobs` with `EnforceIndex: true, JobModifyIndex: 0` registers
 *   only a job that does not exist yet; one that does answers 500 with
 *   `Enforcing job modify index 0: job already exists`. The job's ID is the
 *   CI job's own id, so a retry after a lost answer finds the job it made.
 * - The same call with `JobModifyIndex: 1` for an ID that does not exist is
 *   refused after the ACL check (403 without `submit-job`) and before
 *   anything is written: that is how preflight tests it.
 * - `GET /v1/job/:id` (`Status` pending, running, dead; `Meta`), 404 when
 *   there is none; `GET /v1/jobs?prefix=` lists stubs (without `Meta`).
 * - `DELETE /v1/job/:id?purge=true` stops and removes it, and answers 200
 *   for a job that does not exist, so a teardown is idempotent.
 * - Batch job fields: `Type: "batch"`, `Datacenters: ["*"]`, `Meta` (any
 *   string keys: the tags as sent), `RestartPolicy {Attempts: 0, Mode:
 *   "fail"}`, `ReschedulePolicy {Attempts: 0, Unlimited: false}`, a task
 *   with `Driver: "docker"`, `Config {image, command, args}`, `Resources
 *   {CPU (MHz), MemoryMB, Devices}` and `KillTimeout` in nanoseconds.
 *
 * Nomad has no run-time limit for a job or a task, so the backstop is the
 * task's own command: the bootstrap runs under `ciContainerCommand`'s watchdog as its main
 * process. The task gets no Nomad token (no `identity` block exposes one, no
 * `vault` or `consul` block), no host volumes and no Docker socket: none of
 * the connection's credentials.
 */
import {
  CI_JOB_TAG,
  ciBootstrapWithTools,
  ciComputeKey,
  ciContainerCommand,
  parseCiContainerSize,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import type { components } from "./api-types.gen.js";

/** A job as this executor registers and reads it. */
export type NomadCiJob = components["schemas"]["Job"];

/** What the executor needs from the Nomad API. Each rejects with `{ status }` on an HTTP error. */
export interface NomadCiApi {
  register(
    job: NomadCiJob,
    namespace: string,
    enforce: { JobModifyIndex: number },
  ): Promise<unknown>;
  readJob(id: string, namespace: string): Promise<NomadCiJob>;
  purgeJob(id: string, namespace: string): Promise<unknown>;
  listJobs(
    prefix: string,
  ): Promise<Array<{ ID?: string; Namespace?: string; Status?: string; SubmitTime?: number }>>;
  listNodes(): Promise<
    Array<{ Status?: string; Drivers?: Record<string, { Detected?: boolean; Healthy?: boolean }> }>
  >;
}

const DEFAULT_MACHINE = "2vcpu-4gb";
/** Ubuntu 24.04 with curl and CA certificates: what the bootstrap needs. */
const DEFAULT_IMAGE = "buildpack-deps:noble-curl";
const DEFAULT_NAMESPACE = "default";
const PREFIX = "iwci-";
/** A job ID no CI job has, for preflight probes. */
const PROBE_ID = "iwci-preflight-probe-0000";

export const NOMAD_CI_EXECUTOR = {
  kinds: [
    {
      kind: "cluster",
      label: "Nomad batch job",
      defaults: { machine: DEFAULT_MACHINE, image: DEFAULT_IMAGE },
      typicalStartSeconds: 15,
      gpus: true,
      machineSuggestions: ["1vcpu-2gb", "2vcpu-4gb", "4vcpu-8gb", "8vcpu-16gb"],
      // `cloud.region` names the namespace the job runs in.
      regionLabel: "Namespace",
    },
  ],
  helpLink: {
    label: "Add these capabilities to the token's ACL policy",
    url: "https://developer.hashicorp.com/nomad/docs/other-specifications/acl-policy#namespace-rules",
  },
} as const satisfies CiExecutorDeclaration;

function statusOf(err: unknown): number {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireCluster(kind: CiExecutorKind): void {
  if (kind !== "cluster") {
    throw new Error(`Nomad runs CI jobs of kind \`cluster\` (a batch job), not \`${kind}\`.`);
  }
}

/** `2vcpu-4gb` and the like as MHz and MiB (a CPU counted as 1000 MHz); null when it is not that shape. */
export function parseMachine(machine: string): { cpu: number; memoryMB: number } | null {
  const size = parseCiContainerSize(machine);
  if (!size) return null;
  return {
    cpu: Math.max(100, Math.round(size.vcpus * 1000)),
    memoryMB: Math.max(64, Math.round(size.memoryGb * 1024)),
  };
}

/** The job's ID, from the CI job's id: the same id, the same ID. */
export function jobId(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `${PREFIX}${ciComputeKey(spec)}`;
}

/** The batch job a CI job runs as. */
export function batchJob(spec: CiStartSpec, namespace: string): NomadCiJob {
  const machine = spec.machine ?? DEFAULT_MACHINE;
  const size = parseMachine(machine);
  if (!size) {
    throw new Error(
      `\`cloud.machine\` for a Nomad job is CPUs and memory, like ${DEFAULT_MACHINE}, not ${machine}.`,
    );
  }
  let devices: Array<{ Name: string; Count: number }> | undefined;
  if (spec.gpu) {
    const [type = "", count = "1"] = spec.gpu.split(":");
    if (!/^\d+$/.test(count) || count === "0") {
      throw new Error(`\`cloud.gpu\` wants a GPU count after the colon, not ${count}.`);
    }
    // `<type>`, `<vendor>/<type>` or `<vendor>/<type>/<model>`; a bare model is NVIDIA's.
    const name = type.includes("/")
      ? type
      : type === "gpu" || !type
        ? "nvidia/gpu"
        : `nvidia/gpu/${type}`;
    devices = [{ Name: name, Count: Number(count) }];
  }
  const id = jobId(spec);
  const seconds = Math.max(60, Math.ceil(spec.maxSeconds));
  const command = ciContainerCommand(ciBootstrapWithTools(spec.bootstrap), seconds);
  return {
    ID: id,
    Name: id,
    Namespace: namespace,
    Type: "batch",
    Datacenters: ["*"],
    Meta: { ...spec.tags, "infrawrench-ci-name": spec.name },
    TaskGroups: [
      {
        Name: "job",
        Count: 1,
        RestartPolicy: { Attempts: 0, Mode: "fail" },
        ReschedulePolicy: { Attempts: 0, Unlimited: false },
        Tasks: [
          {
            Name: "job",
            Driver: "docker",
            Config: {
              image: spec.image ?? DEFAULT_IMAGE,
              command: command[0],
              args: command.slice(1),
            },
            Resources: {
              CPU: size.cpu,
              MemoryMB: size.memoryMB,
              ...(devices ? { Devices: devices } : {}),
            },
            KillTimeout: 10 * 1e9,
          },
        ],
      },
    ],
  };
}

function handleOf(namespace: string, id: string): CiHandle {
  return {
    id,
    region: namespace,
    label: `nomad job ${namespace}/${id}`,
    data: { namespace },
  };
}

function namespaceOf(handle: CiHandle): string {
  return handle.data?.["namespace"] ?? handle.region ?? DEFAULT_NAMESPACE;
}

function tagsOf(job: NomadCiJob): Record<string, string> {
  const meta = { ...job.Meta };
  delete meta["infrawrench-ci-name"];
  return meta;
}

export async function ciPreflight(
  api: NomadCiApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireCluster(kind);
  const namespace = region ?? DEFAULT_NAMESPACE;
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  const need = (capability: string, label: string) =>
    missing.push({ permission: `${capability} in namespace ${namespace}`, label });
  try {
    await api.listJobs(PREFIX);
  } catch (err) {
    if (statusOf(err) === 403) need("list-jobs", "Find leftovers");
    else problems.push(`Nomad did not answer: ${message(err)}`);
  }
  try {
    await api.readJob(PROBE_ID, namespace);
  } catch (err) {
    if (statusOf(err) === 403) need("read-job", "Follow the job");
  }
  // A create that can only be refused: an index for a job that does not
  // exist. The ACL check comes first, so 403 means no `submit-job`.
  const probe = batchJob(
    {
      kind: "cluster",
      bootstrap: "true",
      tags: { [CI_JOB_TAG]: "preflight-probe-0000" },
      name: "preflight",
      maxSeconds: 60,
    },
    namespace,
  );
  probe.ID = PROBE_ID;
  probe.Name = PROBE_ID;
  // Were it ever registered, it could never be placed.
  probe.Stop = true;
  probe.Constraints = [
    { LTarget: "${attr.kernel.name}", RTarget: "infrawrench-never", Operand: "=" },
  ];
  try {
    await api.register(probe, namespace, { JobModifyIndex: 1 });
    // Not refused after all: take it back at once.
    await api.purgeJob(PROBE_ID, namespace).catch(() => undefined);
  } catch (err) {
    if (statusOf(err) === 403)
      need("submit-job", "Start the job (register-job on Nomad 1.11.2 and later)");
    else if (!/Enforcing job modify index/i.test(message(err))) {
      problems.push(`Nomad refused a test job in ${namespace}: ${message(err)}`);
    }
  }
  try {
    // Purging a job that does not exist changes nothing, and answers 200 when allowed.
    await api.purgeJob(PROBE_ID, namespace);
  } catch (err) {
    if (statusOf(err) === 403)
      need("submit-job", "Remove it when the job ends (purge-job on 1.11.2 and later)");
  }
  try {
    const nodes = await api.listNodes();
    const docker = nodes.some(
      (n) => n.Status === "ready" && n.Drivers?.["docker"]?.Detected && n.Drivers["docker"].Healthy,
    );
    if (nodes.length > 0 && !docker) {
      problems.push(
        "No ready Nomad client has a healthy docker driver, which CI jobs run on. Install Docker on a client and enable the docker driver.",
      );
    }
  } catch {
    // Reading nodes needs node:read, which a CI token need not have.
  }
  const unique = missing.filter(
    (m, i) => missing.findIndex((o) => o.permission === m.permission) === i,
  );
  return {
    ok: unique.length === 0 && problems.length === 0,
    missing: unique,
    problems,
    region: namespace,
  };
}

export async function ciStart(api: NomadCiApi, spec: CiStartSpec): Promise<CiHandle> {
  requireCluster(spec.kind);
  const namespace = spec.region ?? DEFAULT_NAMESPACE;
  const job = batchJob(spec, namespace);
  const id = job.ID!;
  try {
    await api.register(job, namespace, { JobModifyIndex: 0 });
  } catch (err) {
    if (!/job already exists/i.test(message(err))) throw err;
    // The same ID: a retry after a lost answer, or someone else's job.
    const existing = await api.readJob(id, namespace);
    if (!existing.Meta?.[CI_JOB_TAG] || existing.Meta[CI_JOB_TAG] !== spec.tags[CI_JOB_TAG]) {
      throw new Error(
        `A Nomad job ${id} already exists in ${namespace} and is not this CI job's.`,
        {
          cause: err,
        },
      );
    }
  }
  return handleOf(namespace, id);
}

export async function ciStatus(api: NomadCiApi, handle: CiHandle): Promise<CiComputeStatus> {
  let job: NomadCiJob;
  try {
    job = await api.readJob(handle.id, namespaceOf(handle));
  } catch (err) {
    if (statusOf(err) === 404) return { state: "gone" };
    throw err;
  }
  if (job.Status === "pending") return { state: "starting" };
  if (job.Status === "running") return { state: "running" };
  const detail = job.StatusDescription || (job.Stop ? "stopped" : "");
  return detail ? { state: "stopped", detail } : { state: "stopped" };
}

export async function ciTeardown(api: NomadCiApi, handle: CiHandle): Promise<void> {
  try {
    await api.purgeJob(handle.id, namespaceOf(handle));
  } catch (err) {
    if (statusOf(err) === 404) return;
    throw err;
  }
}

export async function ciListTagged(api: NomadCiApi, tagKey: string): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const stub of await api.listJobs(PREFIX)) {
    if (!stub.ID) continue;
    const namespace = stub.Namespace ?? DEFAULT_NAMESPACE;
    // The list has no `Meta`; the job itself does.
    const job = await api.readJob(stub.ID, namespace).catch(() => undefined);
    if (!job?.Meta?.[tagKey]) continue;
    const created = job.SubmitTime ?? stub.SubmitTime;
    out.push({
      handle: handleOf(namespace, stub.ID),
      tags: tagsOf(job),
      ...(created ? { createdAt: new Date(Math.floor(created / 1e6)).toISOString() } : {}),
      live: (job.Status ?? stub.Status) !== "dead",
    });
  }
  return out;
}
