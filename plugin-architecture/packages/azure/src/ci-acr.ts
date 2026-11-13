/**
 * CI jobs as ACR Tasks runs: the job's resource group holds a Basic
 * container registry of its own, a quick run on it executes the host's
 * bootstrap in a `cmd` step, and both go when the group is deleted.
 *
 * **Wire shapes verified against the Container Registry REST reference,
 * swagger and the ACR Tasks YAML reference, November 2026:**
 * - Registries - Create (2023-07-01, which the plugin already uses):
 *   `location`, `tags`, `sku.name: Basic`, `properties.adminUserEnabled`;
 *   names are 5 to 50 letters and digits, unique across Azure; the answer's
 *   `properties.provisioningState` reaches `Succeeded`.
 * - Registries - Schedule Run (2019-04-01, the only stable version with
 *   runs): `EncodedTaskRunRequest.{encodedTaskContent (base64 YAML),
 *   platform.{os, architecture}, agentConfiguration.cpu, timeout (300 to
 *   28800 seconds), isArchiveEnabled}`; answers a Run with `runId` and
 *   `status` (Queued, Started, Running, Succeeded, Failed, Canceled, Error,
 *   Timeout). Runs - Get, Runs - List (`$top`), Runs - Cancel.
 * - Task YAML v1.1.0: a `cmd` step runs an image from Docker Hub or any
 *   registry with an `entryPoint`; `volumes[].secret` writes files (base64
 *   values) that `volumeMounts` mount into a step; `stepTimeout` and the
 *   step's `timeout` end it. Steps reach the run's Docker daemon (the YAML
 *   reference's own examples run `docker` commands from `cmd` steps).
 *
 * Why a registry per job: a run needs a registry to run on, and the
 * connection names none. One made for the job holds nothing, so the run's
 * own login to it (ACR Tasks logs each run in to its registry) reaches
 * nothing either, and it goes with the job. The cost of that is a Basic
 * registry's daily charge per job. The run's timeout is the backstop.
 */
import {
  ciComputeKey,
  type CiComputeStatus,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
} from "@infrawrench/plugin-base";

import {
  GROUP_PERMISSIONS,
  RESOURCES_API,
  azureTags,
  groupName,
  groupPath,
  missingRoleActions,
  ok,
  putGroup,
  sleepOf,
  unregisteredProviders,
  base64,
  type AzureCiCalls,
} from "./ci-shared.js";

export const ACR_DEFAULT_MACHINE = "2vcpu";
/** Docker's official CLI image (Alpine); the step adds bash and curl to it. */
export const ACR_DEFAULT_IMAGE = "docker.io/library/docker:cli";
const REGISTRY_API = "2023-07-01";
const RUNS_API = "2019-04-01";
const MIN_TIMEOUT = 300;
const MAX_TIMEOUT = 28800;

export const ACR_PERMISSIONS = {
  ...GROUP_PERMISSIONS,
  registryWrite: {
    permission: "Microsoft.ContainerRegistry/registries/write",
    label: "Make the job's registry, which its run needs",
  },
  registryRead: { permission: "Microsoft.ContainerRegistry/registries/read", label: "Wait for it" },
  registryDelete: {
    permission: "Microsoft.ContainerRegistry/registries/delete",
    label: "Delete it when the job ends",
  },
  run: {
    permission: "Microsoft.ContainerRegistry/registries/scheduleRun/action",
    label: "Start the job's run",
  },
  runRead: { permission: "Microsoft.ContainerRegistry/registries/runs/read", label: "Follow it" },
  cancel: {
    permission: "Microsoft.ContainerRegistry/registries/runs/cancel/action",
    label: "Cancel it when the job ends",
  },
} as const satisfies Record<string, CiMissingPermission>;

export function registryName(key: string): string {
  return `iwci${key}`;
}

/** The agent's vCPUs for a `<n>vcpu` machine. */
export function agentCpu(machine: string): number {
  const match = /^\s*(\d+)\s*vcpus?\s*$/i.exec(machine);
  const cpu = match ? Number(match[1]) : NaN;
  if (Number.isInteger(cpu) && cpu >= 1) return cpu;
  throw new Error(
    `An ACR Tasks run is sized by vCPUs, as \`<n>vcpu\` (e.g. ${ACR_DEFAULT_MACHINE}), not \`${machine}\`.`,
  );
}

/** The step's script: bash and curl when the image lacks them, then the bootstrap. */
export function stepScript(bootstrap: string): string {
  return [
    "#!/bin/sh",
    "if ! command -v bash >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then",
    "  if command -v apk >/dev/null 2>&1; then apk add --no-cache bash curl tar gzip coreutils >/dev/null",
    "  elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq >/dev/null && apt-get install -y -qq bash curl tar gzip >/dev/null",
    "  fi",
    "fi",
    bootstrap.replace(/^#![^\n]*\n/, ""),
  ].join("\n");
}

export function runTimeout(maxSeconds: number): number {
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.ceil(maxSeconds)));
}

/** The run's task YAML. Nothing in it is a `$` alias or a `{{ }}` template. */
export function taskYaml(spec: CiStartSpec): string {
  const timeout = runTimeout(spec.maxSeconds);
  const image = spec.image ?? ACR_DEFAULT_IMAGE;
  if (/[\s${}"']/.test(image)) throw new Error(`\`${image}\` is not an image reference.`);
  return [
    "version: v1.1.0",
    `stepTimeout: ${timeout}`,
    "volumes:",
    "  - name: iwci",
    "    secret:",
    `      bootstrap.sh: ${base64(stepScript(spec.bootstrap))}`,
    "steps:",
    `  - cmd: ${image} /iwci/bootstrap.sh`,
    "    entryPoint: sh",
    `    timeout: ${timeout}`,
    "    volumeMounts:",
    "      - name: iwci",
    "        mountPath: /iwci",
    "",
  ].join("\n");
}

export function runRequest(spec: CiStartSpec): Record<string, unknown> {
  return {
    type: "EncodedTaskRunRequest",
    encodedTaskContent: base64(taskYaml(spec)),
    platform: { os: "Linux", architecture: "amd64" },
    agentConfiguration: { cpu: agentCpu(spec.machine ?? ACR_DEFAULT_MACHINE) },
    timeout: runTimeout(spec.maxSeconds),
    isArchiveEnabled: false,
  };
}

function registryPath(subscriptionId: string, group: string, registry: string): string {
  return `${groupPath(subscriptionId, group)}/providers/Microsoft.ContainerRegistry/registries/${registry}`;
}

export function acrHandle(
  group: string,
  location: string,
  registry: string,
  runId: string,
): CiHandle {
  return {
    id: group,
    region: location,
    label: `azure acr run ${runId} (${location})`,
    data: { kind: "build", registry, runId },
  };
}

export async function acrPreflight(
  calls: AzureCiCalls,
  location: string,
): Promise<CiPreflightResult> {
  const missing = await missingRoleActions(calls, Object.values(ACR_PERMISSIONS));
  const problems = await unregisteredProviders(calls, ["Microsoft.ContainerRegistry"]);
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: location };
}

async function readyRegistry(
  calls: AzureCiCalls,
  path: string,
  location: string,
  tags: Readonly<Record<string, string>>,
): Promise<void> {
  const url = `${path}?api-version=${REGISTRY_API}`;
  let state = (
    (await calls.arm("GET", url)).body as { properties?: { provisioningState?: string } } | null
  )?.properties?.provisioningState;
  if (!state) {
    const made = ok<{ properties?: { provisioningState?: string } }>(
      await calls.arm("PUT", url, {
        location,
        tags: azureTags(tags),
        sku: { name: "Basic" },
        properties: { adminUserEnabled: false },
      }),
      "Azure did not make the job's registry",
    );
    state = made.properties?.provisioningState;
  }
  // A registry takes a minute or so; a run cannot be scheduled on it before.
  for (let i = 0; state !== "Succeeded" && i < 60; i++) {
    if (state === "Failed" || state === "Canceled")
      throw new Error(`The job's registry ended ${state}`);
    await sleepOf(calls)(5000);
    const answer = ok<{ properties?: { provisioningState?: string } }>(
      await calls.arm("GET", url),
      "Azure did not answer the job's registry",
    );
    state = answer.properties?.provisioningState;
  }
  if (state !== "Succeeded") throw new Error("The job's registry was not ready after five minutes");
}

export async function acrStart(
  calls: AzureCiCalls,
  location: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  if (spec.gpu) throw new Error("ACR Tasks has no GPUs: use the `vm` kind for a GPU job.");
  if (spec.maxSeconds > MAX_TIMEOUT) {
    throw new Error(
      `An ACR Tasks run lasts at most ${MAX_TIMEOUT / 3600} hours: give the job a shorter timeout, or use the \`vm\` kind.`,
    );
  }
  const request = runRequest(spec);
  const key = ciComputeKey(spec);
  const group = groupName("build", key);
  const registry = registryName(key);
  await putGroup(calls, group, location, spec.tags);
  const path = registryPath(calls.subscriptionId, group, registry);
  await readyRegistry(calls, path, location, spec.tags);
  // A retried start finds the run it scheduled.
  const runs = ok<{ value?: Array<{ properties?: { runId?: string } }> }>(
    await calls.arm("GET", `${path}/runs?api-version=${RUNS_API}&$top=1`),
    "Azure did not list the registry's runs",
  );
  const earlier = runs.value?.[0]?.properties?.runId;
  if (earlier) return acrHandle(group, location, registry, earlier);
  const run = ok<{ properties?: { runId?: string } }>(
    await calls.arm("POST", `${path}/scheduleRun?api-version=${RUNS_API}`, request),
    "Azure did not schedule the run",
  );
  const runId = run.properties?.runId;
  if (!runId) throw new Error("ACR Tasks scheduled no run");
  return acrHandle(group, location, registry, runId);
}

const STARTING = new Set(["Queued", "Started"]);

export async function acrStatus(calls: AzureCiCalls, handle: CiHandle): Promise<CiComputeStatus> {
  const registry = handle.data?.["registry"] ?? registryName(handle.id.slice(-32));
  const groupAnswer = await calls.arm(
    "GET",
    `${groupPath(calls.subscriptionId, handle.id)}?api-version=${RESOURCES_API}`,
  );
  if (groupAnswer.status === 404) return { state: "gone" };
  let runId = handle.data?.["runId"];
  if (!runId) {
    // A handle the reaper listed: the registry's one run.
    const runs = await calls.arm(
      "GET",
      `${registryPath(calls.subscriptionId, handle.id, registry)}/runs?api-version=${RUNS_API}&$top=1`,
    );
    runId = (runs.body as { value?: Array<{ properties?: { runId?: string } }> } | null)?.value?.[0]
      ?.properties?.runId;
    if (runs.status !== 200 || !runId) return { state: "stopped" };
  }
  const answer = await calls.arm(
    "GET",
    `${registryPath(calls.subscriptionId, handle.id, registry)}/runs/${encodeURIComponent(runId)}?api-version=${RUNS_API}`,
  );
  if (answer.status === 404) return { state: "stopped" };
  const status =
    ok<{ properties?: { status?: string } }>(answer, "Azure did not answer the run").properties
      ?.status ?? "";
  if (STARTING.has(status)) return { state: "starting", detail: status };
  if (status === "Running") return { state: "running", detail: status };
  // The run has ended; the registry lingers until the group is deleted.
  return { state: "stopped", detail: status };
}

/** Cancel a run still going; the group's deletion removes the rest. */
export async function cancelRun(calls: AzureCiCalls, handle: CiHandle): Promise<void> {
  const registry = handle.data?.["registry"] ?? registryName(handle.id.slice(-32));
  const runId = handle.data?.["runId"];
  if (!registry || !runId) return;
  // Best effort: deleting the registry ends the run anyway.
  await calls
    .arm(
      "POST",
      `${registryPath(calls.subscriptionId, handle.id, registry)}/runs/${encodeURIComponent(runId)}/cancel?api-version=${RUNS_API}`,
    )
    .catch(() => undefined);
}
