/**
 * CI jobs on Runpod: one pod per job, a GPU pod when the pipeline asks for
 * GPUs and a CPU pod otherwise, terminated when the job ends.
 *
 * Only the `container` kind: a pod is a container on a Runpod host. Runpod
 * offers nothing a job could boot an OS image on (Instant Clusters are pods
 * too, and bare metal is reserved through sales), so there is no `vm`.
 *
 * **Wire shapes verified against Runpod's REST v2 OpenAPI document
 * (`https://api.runpod.io/v2/openapi.json`, version 2.0.0, the one
 * `plugingen.json` names) and docs, November 2026:**
 * - `POST /v2/pods` (`CreatePodRequest`): `name` (required, not unique),
 *   `image`, `entrypoint` and `cmd` in exec form, `env`, exactly one of
 *   `gpu: {id, count}` (a GPU type id from `GET /v2/catalog/gpus`, which
 *   "does not fall back to a different GPU") or `cpu: {id, vcpuCount}` (a
 *   flavor such as `cpu3c` and a power of two from 2), `cloud` (`SECURE` by
 *   default), `dataCenterIds`. No `startSsh` or `startJupyter`, so nothing
 *   listens. A body is at most 102,400 bytes.
 * - `GET /v2/pods` (cursor-paged, `pagination.hasNextPage`), `GET` and
 *   `DELETE /v2/pods/{id}`; `status` is `PROVISIONING`, `STARTING`,
 *   `RUNNING`, `EXITED`, `ERROR` or `TERMINATED`. DELETE terminates for good.
 * - Pods carry `tags`, and `GET /v2/pods?filters=` matches on them, but
 *   neither the create body nor `PATCH` can set one, so the tags ride in the
 *   pod's `INFRAWRENCH_CI_TAGS` environment variable (base64 of their JSON,
 *   not secret), which `GET` returns with the pod, and the name is
 *   `iwci-<job key>`.
 * - Keys are All, Read Only or restricted; a key without access answers 403.
 *
 * **Billing.** Pods bill by the second for compute and storage, with no
 * minimum (deploying needs an hour's worth of credit). A stopped pod is not
 * billed for compute, only for a volume disk; CI pods get none.
 *
 * **Credentials on the pod.** The connection's key never reaches it. Runpod
 * itself injects `RUNPOD_API_KEY`, which its docs call a "pod-scoped API
 * key" without listing what it may do. The pod's command keeps it out of the
 * job's environment and uses it for one thing: terminating its own pod when
 * the job ends (the same `DELETE /v2/pods/{id}` `runpodctl pod delete
 * $RUNPOD_POD_ID` sends from inside a pod). A job running as root in the
 * container can still read it from `/proc/1/environ`.
 *
 * **Backstop.** Runpod has no time limit for a pod, so the job runs under
 * `ciContainerCommand`'s watchdog, and the pod terminates itself when the
 * job ends or its time is up. If that call fails (the pod-scoped key's
 * rights are not documented), the host's teardown and its reaper terminate
 * it.
 */
import {
  CI_JOB_TAG,
  base64ToUtf8,
  ciBootstrapWithTools,
  ciContainerCommand,
  ciGpuKey,
  ciGpuMatches,
  ciHttpStatus,
  ciMachineName,
  parseCiGpu,
  pathEncode,
  utf8ToBase64,
  type ApiBody,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import type { RunpodApi } from "./api.js";
import type { operations } from "./api-types.gen.js";
import type { RpGpuType, RpPod } from "./types.js";

export const CI_DEFAULT_MACHINE = "cpu3c-2";
/** Ubuntu 24.04 with curl and CA certificates: what the bootstrap needs. */
export const CI_DEFAULT_IMAGE = "docker.io/library/buildpack-deps:noble-curl";
/** The environment variable that keeps the job's tags, as base64 of their JSON. */
export const TAGS_ENV = "INFRAWRENCH_CI_TAGS";

export const RUNPOD_CI_EXECUTOR = {
  kinds: [
    {
      kind: "container",
      label: "Pod (GPU or CPU)",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE },
      // No documented start time: an estimate for a cached image on a ready host.
      typicalStartSeconds: 90,
      // Billed by the second with no minimum, so no minimumBillingSeconds.
      gpus: true,
      machineSuggestions: [
        "cpu3c-2",
        "cpu3c-4",
        "cpu5c-8",
        "NVIDIA RTX A5000",
        "NVIDIA GeForce RTX 4090",
        "NVIDIA L4",
        "NVIDIA L40S",
        "NVIDIA RTX A6000",
        "NVIDIA A100 80GB PCIe",
        "NVIDIA H100 80GB HBM3",
        "NVIDIA H200",
      ],
    },
  ],
  helpLink: {
    label: "Create a Runpod API key with All access",
    url: "https://console.runpod.io/user/settings",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  read: { permission: "Read Only", label: "Follow the job's pod and find leftovers" },
  write: {
    permission: "All",
    label: "Create the job's pod and terminate it when the job ends",
  },
} as const satisfies Record<string, CiMissingPermission>;

function requireContainer(kind: CiExecutorKind): void {
  if (kind !== "container") {
    throw new Error(`Runpod runs CI jobs of kind \`container\` (a pod), not \`${kind}\`.`);
  }
}

/** The job's tags as the pod's environment keeps them. */
export function encodeTags(tags: Readonly<Record<string, string>>): string {
  return utf8ToBase64(JSON.stringify(tags));
}

/** The tags {@link encodeTags} wrote, or null when the value is not that. */
export function decodeTags(value: string | undefined): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(base64ToUtf8(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return null;
  }
}

/**
 * The pod's command: the job under the watchdog, with Runpod's pod-scoped key
 * out of its environment, then the pod terminating itself with that key.
 * `entrypoint` and `cmd` of the create body.
 */
export function podCommand(
  bootstrap: string,
  maxSeconds: number,
): { entrypoint: string[]; cmd: string[] } {
  const [, , watchdog, , script] = ciContainerCommand(ciBootstrapWithTools(bootstrap), maxSeconds);
  const outer = [
    'iwci_key="${RUNPOD_API_KEY:-}"',
    "unset RUNPOD_API_KEY",
    'sh -c "$1" iwci "$2"',
    "status=$?",
    'if [ -n "$iwci_key" ] && [ -n "${RUNPOD_POD_ID:-}" ]; then',
    '  curl -fsS -m 30 -X DELETE -H "Authorization: Bearer $iwci_key" "https://api.runpod.io/v2/pods/$RUNPOD_POD_ID" >/dev/null 2>&1 || true',
    "fi",
    'exit "$status"',
  ].join("\n");
  return { entrypoint: ["/bin/sh", "-c", outer], cmd: ["iwci", watchdog ?? "", script ?? ""] };
}

/** `cpu3c-2`, `cpu5c:8` or a bare `cpu3c` (2 vCPUs) as a CPU pod's flavor and size. */
export function parseCpuMachine(machine: string): { id: string; vcpuCount: number } | null {
  const match = /^\s*(cpu\d+[a-z]+)(?:[-:](\d+))?\s*$/i.exec(machine);
  if (!match) return null;
  const vcpuCount = Number(match[2] ?? "2");
  if (vcpuCount < 2 || (vcpuCount & (vcpuCount - 1)) !== 0) {
    throw new Error(
      `A Runpod CPU pod has a power of two vCPUs from 2, so \`${machine}\` will not do; try ${match[1]!.toLowerCase()}-4.`,
    );
  }
  return { id: match[1]!.toLowerCase(), vcpuCount };
}

/**
 * The Runpod GPU type a pipeline means: its id or name exactly, or the one
 * type whose id or name starts with what was written (`h100 sxm`, `rtx
 * 4090`). Several matches throw, naming them, since Runpod places exactly
 * the type asked for.
 */
export function resolveGpuType(gpus: readonly RpGpuType[], type: string): RpGpuType {
  const want = ciGpuKey(type);
  const exact = gpus.find((g) => ciGpuKey(g.id) === want || ciGpuKey(g.name) === want);
  if (exact) return exact;
  const matches = gpus.filter((g) => ciGpuMatches(type, g.id) || ciGpuMatches(type, g.name));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    const some = gpus
      .slice(0, 12)
      .map((g) => g.name)
      .join(", ");
    throw new Error(
      `Runpod has no GPU type \`${type}\`${some ? `; it has ${some} and more` : ""}.`,
    );
  }
  throw new Error(
    `\`${type}\` is more than one Runpod GPU type: ${matches.map((g) => `${g.name} (${g.id})`).join(", ")}. Name one in \`cloud.gpu\`.`,
  );
}

type CreateBody = ApiBody<operations["createPod"]>;

/**
 * The compute half of the create body: a CPU pod from a CPU machine, a GPU
 * pod from `cloud.gpu` or from a machine that names a GPU type. The host
 * fills `machine` with the default when the pipeline leaves it out, so a
 * CPU machine beside `cloud.gpu` gives way to the GPU.
 */
export async function computeOf(
  spec: Pick<CiStartSpec, "machine" | "gpu">,
  catalog: () => Promise<RpGpuType[]>,
): Promise<Pick<CreateBody, "cpu" | "gpu">> {
  const machine = spec.machine ?? CI_DEFAULT_MACHINE;
  const cpu = parseCpuMachine(machine);
  if (!spec.gpu) {
    if (cpu) return { cpu };
    const type = resolveGpuType(await catalog(), machine);
    return { gpu: { id: type.id, count: 1 } };
  }
  const { type, count } = parseCiGpu(spec.gpu);
  const gpus = await catalog();
  const chosen = resolveGpuType(gpus, type);
  if (!cpu) {
    const named = resolveGpuType(gpus, machine);
    if (named.id !== chosen.id) {
      throw new Error(
        `\`cloud.machine\` names ${named.name} and \`cloud.gpu\` ${chosen.name}; name one GPU type.`,
      );
    }
  }
  const most = chosen.maxCount?.secure;
  if (typeof most === "number" && most > 0 && count > most) {
    throw new Error(`A Runpod pod has at most ${most} ${chosen.name} GPUs, not ${count}.`);
  }
  return { gpu: { id: chosen.id, count } };
}

/** The create body for a job. */
export async function podBody(
  spec: CiStartSpec,
  catalog: () => Promise<RpGpuType[]>,
): Promise<CreateBody> {
  const compute = await computeOf(spec, catalog);
  return {
    name: ciMachineName(spec),
    image: spec.image ?? CI_DEFAULT_IMAGE,
    ...podCommand(spec.bootstrap, spec.maxSeconds),
    env: { [TAGS_ENV]: encodeTags(spec.tags) },
    cloud: "SECURE",
    ...(spec.region ? { dataCenterIds: [spec.region] } : {}),
    ...compute,
  };
}

function handleOf(pod: Pick<RpPod, "id" | "dataCenterId">, region?: string): CiHandle {
  const where = pod.dataCenterId ?? region;
  return {
    id: pod.id,
    ...(where ? { region: where } : {}),
    label: `runpod pod ${pod.id}${where ? ` (${where})` : ""}`,
  };
}

async function listPods(api: RunpodApi): Promise<RpPod[]> {
  return api.listAll(
    "/v2/pods",
    (query) => api.rest.get("/v2/pods", { query }),
    (page) => page.pods,
  );
}

function tagsOfPod(pod: RpPod): Record<string, string> | null {
  return decodeTags(pod.env?.[TAGS_ENV]);
}

/** The job's pod a first start made, by name and the job's tag. */
async function findPod(api: RunpodApi, spec: CiStartSpec): Promise<RpPod | undefined> {
  const name = ciMachineName(spec);
  const job = spec.tags[CI_JOB_TAG];
  return (await listPods(api)).find(
    (p) =>
      p.name === name &&
      p.status !== "TERMINATED" &&
      (job === undefined || tagsOfPod(p)?.[CI_JOB_TAG] === job),
  );
}

export async function runpodCiPreflight(
  api: RunpodApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireContainer(kind);
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  // Runpod has no call that says what a key may do: a read, and a delete of
  // a pod that does not exist, which a key that may not write refuses first.
  try {
    await api.rest.get("/v2/pods", { query: { limit: 1 } });
  } catch (err) {
    const status = ciHttpStatus(err);
    if (status === 401 || status === 403) missing.push(CI_PERMISSIONS.read);
    else problems.push(`Runpod refused a read: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await api.rest.delete(`/v2/pods/${pathEncode("iwci-preflight-0")}`);
  } catch (err) {
    const status = ciHttpStatus(err);
    if (status === 401 || status === 403) missing.push(CI_PERMISSIONS.write);
  }
  if (region) {
    try {
      const { dataCenters } = await api.rest.get("/v2/catalog/datacenters");
      if (dataCenters && !dataCenters.some((d) => d.id === region)) {
        problems.push(
          `Runpod has no data center \`${region}\`. Name one such as US-TX-3, US-KS-2 or EU-RO-1, or leave \`cloud.region\` out to let Runpod choose.`,
        );
      }
    } catch {
      // Not being able to look is no reason to refuse: the start says so.
    }
  }
  return {
    ok: missing.length === 0 && problems.length === 0,
    missing,
    problems,
    ...(region ? { region } : {}),
  };
}

export async function runpodCiStart(api: RunpodApi, spec: CiStartSpec): Promise<CiHandle> {
  requireContainer(spec.kind);
  // Runpod names are not unique and a create has no idempotency key, so a
  // start first looks for the pod a lost answer left behind.
  const found = await findPod(api, spec);
  if (found) return handleOf(found, spec.region);
  const body = await podBody(spec, async () => {
    const { gpus } = await api.rest.get("/v2/catalog/gpus");
    return gpus ?? [];
  });
  const pod = await api.rest.post("/v2/pods", { body });
  if (!pod?.id) throw new Error("Runpod created no pod");
  return handleOf(pod, spec.region);
}

export async function runpodCiStatus(api: RunpodApi, handle: CiHandle): Promise<CiComputeStatus> {
  let pod: RpPod;
  try {
    pod = await api.rest.get(`/v2/pods/${pathEncode(handle.id)}`);
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  if (!pod) return { state: "gone" };
  const status = pod.status;
  const state: CiComputeStatus["state"] =
    status === "PROVISIONING" || status === "STARTING"
      ? "starting"
      : status === "RUNNING"
        ? "running"
        : status === "TERMINATED"
          ? "gone"
          : "stopped";
  return { state, detail: status };
}

export async function runpodCiTeardown(api: RunpodApi, handle: CiHandle): Promise<void> {
  try {
    await api.rest.delete(`/v2/pods/${pathEncode(handle.id)}`);
  } catch (err) {
    if (ciHttpStatus(err) === 404) return;
    throw err;
  }
}

/**
 * Every pod whose kept tags carry `tagKey`. Pods are account-wide, so
 * `regions` does not narrow it.
 */
export async function runpodCiListTagged(
  api: RunpodApi,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const pod of await listPods(api)) {
    if (pod.status === "TERMINATED") continue;
    const tags = tagsOfPod(pod);
    if (!tags || !(tagKey in tags)) continue;
    out.push({
      handle: handleOf(pod),
      tags,
      ...(pod.createdAt ? { createdAt: pod.createdAt } : {}),
      live: pod.status === "PROVISIONING" || pod.status === "STARTING" || pod.status === "RUNNING",
    });
  }
  return out;
}
