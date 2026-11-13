/**
 * CI jobs on a Kubernetes cluster: one batch/v1 Job per CI job, in a
 * namespace the pipeline names (`cloud.region`) or the connection's own.
 *
 * **Wire shapes verified against the Kubernetes API reference (v1.34),
 * November 2026:**
 * - `POST /apis/batch/v1/namespaces/{ns}/jobs` creates the Job; a Job of
 *   the same name answers 409 (`AlreadyExists`). The name is the CI job's
 *   own id, so a retry after a lost answer finds the Job it already made.
 * - `spec.activeDeadlineSeconds` ends the Job (its pods are killed, the Job
 *   is `Failed` with reason `DeadlineExceeded`) once the job's time is up,
 *   whatever happens to the host; `spec.ttlSecondsAfterFinished` removes a
 *   finished Job and its pods on its own; `backoffLimit: 0` never retries.
 * - The pod runs with `automountServiceAccountToken: false` and
 *   `enableServiceLinks: false`, so the job gets no token for the cluster
 *   and no environment describing its services: none of the connection's
 *   credentials.
 * - `GET .../jobs/{name}` reads `status.{active, ready, succeeded, failed}`
 *   and `status.conditions[]` (`Complete`, `Failed`).
 * - `DELETE .../jobs/{name}` with `propagationPolicy: Background`: without
 *   it, a Job deleted through the API leaves its pods behind (orphan is the
 *   batch/v1 default). An unknown Job answers 404, which is "already gone".
 * - `GET /apis/batch/v1/jobs?labelSelector=<key>` (every namespace), or per
 *   namespace, lists what carries the CI label.
 * - `POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews` asks
 *   whether the connection may create, get, list and delete Jobs in the
 *   namespace (`status.allowed`), without starting anything. Every
 *   authenticated user may ask.
 *
 * Label values are at most 63 characters of `[A-Za-z0-9._-]`, so labels
 * carry a cleaned form of each tag and an annotation keeps them as sent,
 * which is what {@link ciListTagged} gives back.
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

/** One Kubernetes API call; rejects with "K8s API error <status> at ..." like `K8sFetcher`. */
export type K8sCall = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

const DEFAULT_MACHINE = "2vcpu-4gb";
/** Ubuntu 24.04 with curl and CA certificates: what the bootstrap needs, nothing more. */
const DEFAULT_IMAGE = "buildpack-deps:noble-curl";
/** How long a finished Job stays for its status to be read, before the cluster removes it. */
const FINISHED_TTL_SECONDS = 600;
/** The annotation that keeps the CI tags as they were sent. */
export const TAGS_ANNOTATION = "infrawrench.com/ci-tags";

export const KUBERNETES_CI_EXECUTOR = {
  kinds: [
    {
      kind: "cluster",
      label: "Kubernetes Job",
      defaults: { machine: DEFAULT_MACHINE, image: DEFAULT_IMAGE },
      typicalStartSeconds: 15,
      gpus: true,
      machineSuggestions: ["1vcpu-2gb", "2vcpu-4gb", "4vcpu-8gb", "8vcpu-16gb", "16vcpu-32gb"],
      // `cloud.region` names the namespace the job runs in.
      regionLabel: "Namespace",
    },
  ],
  helpLink: {
    label: "Grant these with a Role and RoleBinding in the namespace",
    url: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/#role-and-clusterrole",
  },
} as const satisfies CiExecutorDeclaration;

/** What a CI job needs on Jobs in its namespace, with what it is for. */
export const CI_VERBS = [
  { verb: "create", label: "Start the job's Job" },
  { verb: "get", label: "Follow it" },
  { verb: "list", label: "Find leftovers" },
  { verb: "delete", label: "Remove it when the job ends" },
] as const;

/** The HTTP status of a failed call, from `K8sFetcher`'s and the driver's message. */
export function statusOf(err: unknown): number | undefined {
  const match = /K8s API error (\d{3})/.exec(err instanceof Error ? err.message : String(err));
  return match ? Number(match[1]) : undefined;
}

function requireCluster(kind: CiExecutorKind): void {
  if (kind !== "cluster") {
    throw new Error(`Kubernetes runs CI jobs of kind \`cluster\` (a Job), not \`${kind}\`.`);
  }
}

/** A label value: at most 63 characters, alphanumeric at both ends. */
export function labelValue(value: string): string {
  const trim = (v: string) => v.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  return trim(trim(value.replace(/[^A-Za-z0-9._-]+/g, "-")).slice(0, 63));
}

/** A label key without a prefix: the same rules as a value, never empty. */
export function labelKey(key: string): string {
  return labelValue(key) || "infrawrench-ci";
}

/** A DNS-1123 name for the Job, from the CI job's id: the same id, the same name. */
export function jobName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/** `2vcpu-4gb` and the like as resource quantities; null when it is not that shape. */
export function parseMachine(machine: string): { cpu: string; memory: string } | null {
  const size = parseCiContainerSize(machine);
  if (!size) return null;
  const cpu = Number.isInteger(size.vcpus)
    ? String(size.vcpus)
    : `${Math.round(size.vcpus * 1000)}m`;
  const memory = Number.isInteger(size.memoryGb)
    ? `${size.memoryGb}Gi`
    : `${Math.round(size.memoryGb * 1024)}Mi`;
  return { cpu, memory };
}

/** `cloud.gpu` (`type[:count]`) as an extended resource and count. */
export function gpuResource(gpu: string): { resource: string; count: string } {
  const [type = "", count = "1"] = gpu.split(":");
  if (!/^\d+$/.test(count) || count === "0") {
    throw new Error(`\`cloud.gpu\` wants a GPU count after the colon, not ${count}.`);
  }
  const t = type.trim().toLowerCase();
  const resource = t.includes("/")
    ? type.trim()
    : t === "amd"
      ? "amd.com/gpu"
      : t === "intel"
        ? "gpu.intel.com/i915"
        : "nvidia.com/gpu";
  return { resource, count };
}

/** The Job a CI job runs as. */
export function jobManifest(spec: CiStartSpec, namespace: string): Record<string, unknown> {
  const name = jobName(spec);
  const machine = spec.machine ?? DEFAULT_MACHINE;
  const size = parseMachine(machine);
  if (!size) {
    throw new Error(
      `\`cloud.machine\` for a Kubernetes job is CPUs and memory, like ${DEFAULT_MACHINE} or 0.5vcpu-1gb, not ${machine}.`,
    );
  }
  const limits: Record<string, string> = { cpu: size.cpu, memory: size.memory };
  if (spec.gpu) {
    const gpu = gpuResource(spec.gpu);
    limits[gpu.resource] = gpu.count;
  }
  const labels: Record<string, string> = { "app.kubernetes.io/managed-by": "infrawrench" };
  for (const [key, value] of Object.entries(spec.tags)) labels[labelKey(key)] = labelValue(value);
  const seconds = Math.max(60, Math.ceil(spec.maxSeconds));
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace,
      labels,
      annotations: {
        [TAGS_ANNOTATION]: JSON.stringify(spec.tags),
        "infrawrench.com/ci-name": spec.name.slice(0, 253),
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: seconds,
      ttlSecondsAfterFinished: FINISHED_TTL_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 10,
          containers: [
            {
              name: "job",
              image: spec.image ?? DEFAULT_IMAGE,
              command: ciContainerCommand(ciBootstrapWithTools(spec.bootstrap), seconds),
              resources: { requests: { cpu: size.cpu, memory: size.memory }, limits },
            },
          ],
        },
      },
    },
  };
}

interface K8sJob {
  metadata?: {
    name?: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  status?: {
    active?: number;
    ready?: number;
    succeeded?: number;
    failed?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
}

function jobsPath(namespace: string, name?: string): string {
  const base = `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`;
  return name ? `${base}/${encodeURIComponent(name)}` : base;
}

function handleOf(namespace: string, name: string): CiHandle {
  return {
    id: `${namespace}/${name}`,
    region: namespace,
    label: `kubernetes job ${namespace}/${name}`,
    data: { namespace, name },
  };
}

function whereOf(handle: CiHandle): { namespace: string; name: string } {
  const namespace = handle.data?.["namespace"] ?? handle.region ?? handle.id.split("/")[0] ?? "";
  const name = handle.data?.["name"] ?? handle.id.split("/").slice(1).join("/");
  return { namespace, name };
}

/** The tags a Job carries, as they were sent where the annotation kept them. */
function tagsOf(job: K8sJob): Record<string, string> {
  const raw = job.metadata?.annotations?.[TAGS_ANNOTATION];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        );
      }
    } catch {
      // Fall back to the labels below.
    }
  }
  return { ...job.metadata?.labels };
}

function finished(job: K8sJob): { type: string; reason?: string; message?: string } | undefined {
  const c = job.status?.conditions?.find(
    (c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
  );
  if (!c?.type) return undefined;
  return {
    type: c.type,
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.message ? { message: c.message } : {}),
  };
}

export async function ciPreflight(
  call: K8sCall,
  homeNamespace: string,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireCluster(kind);
  const namespace = region ?? homeNamespace;
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  for (const { verb, label } of CI_VERBS) {
    try {
      const review = await call<{ status?: { allowed?: boolean } }>(
        "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
        {
          method: "POST",
          body: {
            apiVersion: "authorization.k8s.io/v1",
            kind: "SelfSubjectAccessReview",
            spec: { resourceAttributes: { namespace, verb, group: "batch", resource: "jobs" } },
          },
        },
      );
      if (!review.status?.allowed) {
        missing.push({ permission: `${verb} jobs.batch in namespace ${namespace}`, label });
      }
    } catch (err) {
      problems.push(
        `The cluster did not answer whether this connection may ${verb} Jobs in ${namespace}: ${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }
  }
  try {
    await call(`/api/v1/namespaces/${encodeURIComponent(namespace)}`);
  } catch (err) {
    // Not being allowed to read namespaces is no reason to refuse; a missing one is.
    if (statusOf(err) === 404) {
      problems.push(
        `There is no namespace ${namespace} on this cluster. Create it (kubectl create namespace ${namespace}) or name another in \`cloud.region\`.`,
      );
    }
  }
  return {
    ok: missing.length === 0 && problems.length === 0,
    missing,
    problems,
    region: namespace,
  };
}

export async function ciStart(
  call: K8sCall,
  homeNamespace: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  requireCluster(spec.kind);
  const namespace = spec.region ?? homeNamespace;
  const manifest = jobManifest(spec, namespace);
  const name = jobName(spec);
  try {
    await call(jobsPath(namespace), { method: "POST", body: manifest });
  } catch (err) {
    if (statusOf(err) !== 409) throw err;
    // The same name: a retry after a lost answer, or someone else's Job.
    const existing = await call<K8sJob>(jobsPath(namespace, name));
    const mine = tagsOf(existing)[CI_JOB_TAG];
    if (!mine || mine !== spec.tags[CI_JOB_TAG]) {
      throw new Error(
        `A Job named ${name} already exists in ${namespace} and is not this CI job's.`,
        { cause: err },
      );
    }
  }
  return handleOf(namespace, name);
}

export async function ciStatus(call: K8sCall, handle: CiHandle): Promise<CiComputeStatus> {
  const { namespace, name } = whereOf(handle);
  let job: K8sJob;
  try {
    job = await call<K8sJob>(jobsPath(namespace, name));
  } catch (err) {
    if (statusOf(err) === 404) return { state: "gone" };
    throw err;
  }
  const done = finished(job);
  if (done) {
    const detail = [done.reason, done.message].filter(Boolean).join(": ");
    return detail ? { state: "stopped", detail } : { state: "stopped" };
  }
  const active = job.status?.active ?? 0;
  if (active === 0) return { state: "starting" };
  // `ready` counts pods past their readiness checks; a CI pod has none, so
  // ready means its container is running.
  const ready = job.status?.ready;
  return ready === undefined || ready > 0 ? { state: "running" } : { state: "starting" };
}

export async function ciTeardown(call: K8sCall, handle: CiHandle): Promise<void> {
  const { namespace, name } = whereOf(handle);
  try {
    await call(`${jobsPath(namespace, name)}?propagationPolicy=Background`, {
      method: "DELETE",
      body: { apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Background" },
    });
  } catch (err) {
    if (statusOf(err) === 404) return;
    throw err;
  }
}

export async function ciListTagged(
  call: K8sCall,
  homeNamespace: string,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const selector = `labelSelector=${encodeURIComponent(labelKey(tagKey))}`;
  const lists: K8sJob[][] = [];
  if (regions.length === 0) {
    try {
      // Every namespace when the connection may; its own namespace otherwise.
      const all = await call<{ items?: K8sJob[] }>(`/apis/batch/v1/jobs?${selector}`);
      lists.push(all.items ?? []);
    } catch (err) {
      if (statusOf(err) !== 403) throw err;
      const own = await call<{ items?: K8sJob[] }>(`${jobsPath(homeNamespace)}?${selector}`);
      lists.push(own.items ?? []);
    }
  } else {
    for (const namespace of new Set(regions)) {
      const list = await call<{ items?: K8sJob[] }>(`${jobsPath(namespace)}?${selector}`);
      lists.push(list.items ?? []);
    }
  }
  const out: CiTaggedCompute[] = [];
  for (const job of lists.flat()) {
    const name = job.metadata?.name;
    const namespace = job.metadata?.namespace;
    if (!name || !namespace) continue;
    const created = job.metadata?.creationTimestamp;
    out.push({
      handle: handleOf(namespace, name),
      tags: tagsOf(job),
      ...(created ? { createdAt: created } : {}),
      live: !finished(job),
    });
  }
  return out;
}
