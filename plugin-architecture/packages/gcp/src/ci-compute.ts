/**
 * CI jobs on Compute Engine: one fresh instance per job, started with the
 * host's bootstrap as its startup script, deleted when the job ends.
 *
 * **Wire shapes verified against the Compute Engine v1 Discovery document
 * and docs, November 2026:**
 * - `instances.insert` (`POST .../zones/{zone}/instances?requestId=<uuid>`):
 *   `name` (`[a-z]([-a-z0-9]*[a-z0-9])?`, at most 63), `machineType`
 *   (`zones/{z}/machineTypes/{t}`), `disks[].{boot, autoDelete,
 *   initializeParams.{sourceImage, diskSizeGb, diskType, labels}}`,
 *   `networkInterfaces[].{network, accessConfigs[{type: ONE_TO_ONE_NAT}]}`,
 *   `metadata.items[{key: startup-script, value}]`, `labels`,
 *   `guestAccelerators[]`, and `scheduling.{maxRunDuration.seconds,
 *   instanceTerminationAction: DELETE, provisioningModel: STANDARD,
 *   onHostMaintenance}`. `maxRunDuration` (30 seconds to 120 days) is GA in
 *   v1 and allowed for STANDARD VMs when the termination action is set.
 * - `zoneOperations.wait`, `instances.get` (`status`), `instances.delete`,
 *   `aggregated/instances` with `filter=labels.<key>:*` and
 *   `returnPartialSuccess`, `regions.get` (`zones[]`, `status`).
 * - Ubuntu 24.04 LTS families in `ubuntu-os-cloud`: `ubuntu-2404-lts-amd64`
 *   and `ubuntu-2404-lts-arm64`.
 *
 * The instance gets no service account (`serviceAccounts` empty), so the
 * metadata server has no token for the job. The job's tags ride as JSON in
 * the instance metadata (`infrawrench-ci-tags`), labels being too narrow for
 * them. Teardown happens three ways: the host deletes the instance; the
 * startup script powers it off when the bootstrap ends (no more compute
 * billed); and `maxRunDuration` deletes it once the job's time is up.
 */
import {
  ciComputeKey,
  type CiComputeStatus,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import {
  errorText,
  isApiDisabled,
  labelKey,
  labelsOf,
  missingOnProject,
  parseTags,
  statusOf,
  uuidOf,
  type GcpCiCalls,
} from "./ci-shared.js";

const COMPUTE = "https://compute.googleapis.com/compute/v1";
export const COMPUTE_DEFAULT_MACHINE = "e2-standard-2";
export const COMPUTE_DEFAULT_IMAGE = "Ubuntu 24.04";
const TAGS_METADATA = "infrawrench-ci-tags";
const DISK_GB = "40";
/** Series whose boot disks take `pd-balanced`; newer ones default to Hyperdisk. */
const PD_BALANCED_SERIES = new Set([
  "e2",
  "n1",
  "n2",
  "n2d",
  "t2d",
  "t2a",
  "c2",
  "c2d",
  "c3",
  "c3d",
  "a2",
  "g2",
]);
const ARM_SERIES = new Set(["t2a", "c4a", "n4a"]);

export const COMPUTE_PERMISSIONS = {
  create: { permission: "compute.instances.create", label: "Start the job's instance" },
  disk: { permission: "compute.disks.create", label: "Give it a boot disk" },
  subnet: { permission: "compute.subnetworks.use", label: "Put it on the default network" },
  externalIp: {
    permission: "compute.subnetworks.useExternalIp",
    label: "Give it a public address to reach the internet",
  },
  metadata: { permission: "compute.instances.setMetadata", label: "Hand it the startup script" },
  labels: { permission: "compute.instances.setLabels", label: "Label it as a CI job's" },
  regions: { permission: "compute.regions.get", label: "Pick a zone in the region" },
  operations: { permission: "compute.zoneOperations.get", label: "Wait for it to be created" },
  get: { permission: "compute.instances.get", label: "Follow it" },
  list: { permission: "compute.instances.list", label: "Find leftovers" },
  delete: { permission: "compute.instances.delete", label: "Delete it when the job ends" },
} as const satisfies Record<string, CiMissingPermission>;

function projectUrl(project: string): string {
  return `${COMPUTE}/projects/${encodeURIComponent(project)}`;
}

function seriesOf(machine: string): string {
  return machine.split("-")[0]?.toLowerCase() ?? "";
}

/** The image for a machine: the pipeline's, or Ubuntu 24.04 for its architecture. */
export function sourceImage(machine: string, image?: string): string {
  if (image && image !== COMPUTE_DEFAULT_IMAGE) return image;
  const family = ARM_SERIES.has(seriesOf(machine))
    ? "ubuntu-2404-lts-arm64"
    : "ubuntu-2404-lts-amd64";
  return `projects/ubuntu-os-cloud/global/images/family/${family}`;
}

/** The startup script: the host's bootstrap, then power off when it ends. */
export function startupScript(bootstrap: string): string {
  const body = bootstrap.replace(/^#![^\n]*\n/, "");
  return ["#!/bin/bash", "(", body, ")", "shutdown -h now", ""].join("\n");
}

/** `type[:count]` as Compute Engine's accelerators. */
function accelerators(
  zone: string,
  gpu: string,
): Array<{ acceleratorType: string; acceleratorCount: number }> {
  const [type = "", count = "1"] = gpu.split(":");
  const n = Number(count);
  if (!type || !Number.isInteger(n) || n < 1) {
    throw new Error(`\`cloud.gpu\` is \`<type>[:<count>]\`, e.g. nvidia-l4:1, not \`${gpu}\`.`);
  }
  return [{ acceleratorType: `zones/${zone}/acceleratorTypes/${type}`, acceleratorCount: n }];
}

export function instanceName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/** The insert body for a job in a zone. */
export function instanceBody(spec: CiStartSpec, zone: string): Record<string, unknown> {
  const machine = spec.machine ?? COMPUTE_DEFAULT_MACHINE;
  const labels = labelsOf(spec.tags);
  const series = seriesOf(machine);
  const gpu = spec.gpu ? accelerators(zone, spec.gpu) : undefined;
  return {
    name: instanceName(spec),
    description: spec.name.slice(0, 2048),
    machineType: `zones/${zone}/machineTypes/${machine}`,
    labels,
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage: sourceImage(machine, spec.image),
          diskSizeGb: DISK_GB,
          ...(PD_BALANCED_SERIES.has(series)
            ? { diskType: `zones/${zone}/diskTypes/pd-balanced` }
            : {}),
          labels,
        },
      },
    ],
    networkInterfaces: [
      {
        network: "global/networks/default",
        // A public address is how an instance on the default network reaches
        // the internet; the default firewall lets nothing in but SSH from
        // what the project allows, and nothing listens for the job.
        accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
      },
    ],
    // No service account: the metadata server has no token for the job.
    serviceAccounts: [],
    metadata: {
      items: [
        { key: "startup-script", value: startupScript(spec.bootstrap) },
        { key: TAGS_METADATA, value: JSON.stringify(spec.tags) },
      ],
    },
    scheduling: {
      provisioningModel: "STANDARD",
      // The backstop: Compute Engine deletes the instance once the job's
      // time is up, whatever happens to the host or the bootstrap.
      maxRunDuration: { seconds: String(Math.max(30, Math.ceil(spec.maxSeconds))) },
      instanceTerminationAction: "DELETE",
      ...(gpu ? { onHostMaintenance: "TERMINATE", automaticRestart: false } : {}),
    },
    ...(gpu ? { guestAccelerators: gpu } : {}),
  };
}

/** A zone in `region` (or `region` itself when it names a zone), first UP zone by name. */
async function zoneFor(calls: GcpCiCalls, region: string): Promise<string> {
  if (/^[a-z]+-[a-z]+\d+-[a-z]$/.test(region)) return region;
  const data = await calls.call<{ zones?: string[] }>(
    "GET",
    `${projectUrl(calls.project)}/regions/${encodeURIComponent(region)}`,
  );
  const zones = (data.zones ?? [])
    .map((z) => z.split("/").pop() ?? "")
    .filter(Boolean)
    .sort();
  const zone = zones[0];
  if (!zone) throw new Error(`Compute Engine has no zones in ${region}`);
  return zone;
}

function regionOfZone(zone: string): string {
  return zone.replace(/-[a-z]$/, "");
}

function handleOf(name: string, zone: string): CiHandle {
  return {
    id: name,
    region: regionOfZone(zone),
    label: `gcp compute ${name} (${zone})`,
    data: { kind: "vm", zone },
  };
}

function instanceUrl(project: string, zone: string, name: string): string {
  return `${projectUrl(project)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(name)}`;
}

export async function computePreflight(
  calls: GcpCiCalls,
  region: string,
): Promise<CiPreflightResult> {
  const missing = await missingOnProject(calls, Object.values(COMPUTE_PERMISSIONS));
  const problems: string[] = [];
  try {
    await calls.call("GET", `${projectUrl(calls.project)}/global/networks/default`);
  } catch (err) {
    if (statusOf(err) === 404) {
      problems.push(
        "The project has no network named `default`, which a CI instance starts on. Create a VPC network named default with automatic subnets, or use another project.",
      );
    } else if (isApiDisabled(err)) {
      problems.push(errorText(err));
    }
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region };
}

interface Operation {
  name?: string;
  status?: string;
  error?: { errors?: Array<{ code?: string; message?: string }> };
}

function operationError(op: Operation): string | null {
  const errors = op.error?.errors ?? [];
  return errors.length > 0 ? errors.map((e) => e.message ?? e.code ?? "").join("; ") : null;
}

export async function computeStart(
  calls: GcpCiCalls,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  const zone = await zoneFor(calls, region);
  const name = instanceName(spec);
  const key = ciComputeKey(spec);
  let op: Operation;
  try {
    op = await calls.call<Operation>(
      "POST",
      `${projectUrl(calls.project)}/zones/${encodeURIComponent(zone)}/instances?requestId=${uuidOf(key)}`,
      instanceBody(spec, zone),
    );
  } catch (err) {
    // The name is the job's: it is there because an earlier start made it.
    if (statusOf(err) === 409) return handleOf(name, zone);
    throw err;
  }
  // Waiting brings back what the insert could not do (no capacity, a quota),
  // which otherwise only shows on the operation.
  if (op.name && op.status !== "DONE") {
    try {
      op = await calls.call<Operation>(
        "POST",
        `${projectUrl(calls.project)}/zones/${encodeURIComponent(zone)}/operations/${encodeURIComponent(op.name)}/wait`,
      );
    } catch {
      // Still creating; the job's own call-back says how it went.
    }
  }
  const failed = operationError(op);
  if (failed) throw new Error(`Compute Engine could not create ${name} in ${zone}: ${failed}`);
  return handleOf(name, zone);
}

export async function computeStatus(calls: GcpCiCalls, handle: CiHandle): Promise<CiComputeStatus> {
  const zone = handle.data?.["zone"];
  if (!zone) return { state: "gone" };
  let instance: { status?: string; statusMessage?: string };
  try {
    instance = await calls.call("GET", instanceUrl(calls.project, zone, handle.id));
  } catch (err) {
    if (statusOf(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = instance.status ?? "";
  const state: CiComputeStatus["state"] =
    status === "PROVISIONING" || status === "STAGING" || status === "PENDING"
      ? "starting"
      : status === "RUNNING"
        ? "running"
        : "stopped";
  return { state, detail: status };
}

export async function computeTeardown(calls: GcpCiCalls, handle: CiHandle): Promise<void> {
  const zone = handle.data?.["zone"];
  if (!zone) return;
  try {
    await calls.call("DELETE", instanceUrl(calls.project, zone, handle.id));
  } catch (err) {
    if (statusOf(err) === 404) return;
    throw err;
  }
}

interface Instance {
  name?: string;
  status?: string;
  creationTimestamp?: string;
  zone?: string;
  metadata?: { items?: Array<{ key?: string; value?: string }> };
}

export async function computeListTagged(
  calls: GcpCiCalls,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  const wanted = new Set(regions);
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      filter: `labels.${labelKey(tagKey)}:*`,
      returnPartialSuccess: "true",
      maxResults: "500",
      ...(pageToken ? { pageToken } : {}),
    });
    const page = await calls.call<{
      items?: Record<string, { instances?: Instance[] }>;
      nextPageToken?: string;
    }>("GET", `${projectUrl(calls.project)}/aggregated/instances?${params}`);
    for (const [scope, entry] of Object.entries(page.items ?? {})) {
      const zone = scope.replace(/^zones\//, "");
      if (wanted.size > 0 && !wanted.has(regionOfZone(zone))) continue;
      for (const instance of entry.instances ?? []) {
        if (!instance.name) continue;
        const raw = instance.metadata?.items?.find((i) => i.key === TAGS_METADATA)?.value;
        const tags = parseTags(raw);
        if (!tags || !(tagKey in tags)) continue;
        const status = instance.status ?? "";
        out.push({
          handle: handleOf(instance.name, zone),
          tags,
          ...(instance.creationTimestamp ? { createdAt: instance.creationTimestamp } : {}),
          live: status !== "TERMINATED" && status !== "STOPPED" && status !== "SUSPENDED",
        });
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}
