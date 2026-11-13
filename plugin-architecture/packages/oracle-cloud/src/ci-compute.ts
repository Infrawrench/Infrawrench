/**
 * CI jobs on OCI Compute: one fresh instance per job, started with the
 * host's bootstrap as its cloud-init user data and terminated (boot volume
 * and all) when the job ends.
 *
 * **Wire shapes verified against the Core Services API reference and the
 * oci-typescript-sdk models, November 2026:**
 * - `LaunchInstance` (`POST /20160918/instances`, `opc-retry-token` for 24
 *   hours): `availabilityDomain`, `compartmentId`, `displayName`, `shape`,
 *   `shapeConfig.{ocpus, memoryInGBs}` (Flex shapes), `sourceDetails.{
 *   sourceType: image, imageId, bootVolumeSizeInGBs}`, `createVnicDetails.{
 *   subnetId, assignPublicIp}`, `metadata.user_data` (base64; `metadata`
 *   is at most 32,000 bytes in all), `freeformTags`,
 *   `instanceOptions.areLegacyImdsEndpointsDisabled`.
 * - `GetInstance`, `ListInstances` (`compartmentId`, `displayName`,
 *   `lifecycleState`; summaries carry `freeformTags` and `timeCreated`),
 *   `lifecycleState` MOVING, PROVISIONING, RUNNING, STARTING, STOPPING,
 *   STOPPED, CREATING_IMAGE, TERMINATING, TERMINATED.
 * - `TerminateInstance` (`DELETE /20160918/instances/{id}`):
 *   `preserveBootVolume` defaults to false, so the boot volume goes with
 *   the instance, as do its VNIC and ephemeral public IP.
 * - Ubuntu 24.04 is the newest `Canonical Ubuntu` `24.04` platform image
 *   for the shape (`ListImages` with `shape`, sorted by time created).
 *
 * OCI has no run-time limit or terminate-at time for a standard instance
 * (only preemptible capacity, which can be reclaimed mid-job), so the user
 * data starts a `shutdown` timer before the job and powers the instance
 * off when the job ends. That stops the job, not the bill: OCI keeps
 * billing an instance shut down from inside its OS until it is stopped or
 * terminated through the API, which the host's teardown and its reaper do.
 *
 * The instance has no credential worth having: its principal certificate is
 * granted only what policies grant a dynamic group that matches it, and the
 * check names any dynamic group that would match every instance in the
 * root compartment (`ci-executor.ts`). The one grant OCI gives every
 * instance principal, and that cannot be revoked, is `compartment_inspect`:
 * a job could list the tenancy's compartments, their names and free-form
 * tags.
 */
import {
  ciComputeKey,
  type CiComputeStatus,
  type CiHandle,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { OciApiError } from "./api.js";
import { resolveImage } from "./create.js";
import { parseSizeId } from "./listers.js";
import {
  availabilityDomains,
  ciCompartment,
  ensureNetwork,
  freeformTags,
  isNotFound,
  isOutOfCapacity,
  retryToken,
  type OciCiContext,
} from "./ci-shared.js";

export const COMPUTE_DEFAULT_MACHINE = "VM.Standard.E5.Flex/1/8";
export const COMPUTE_DEFAULT_IMAGE = "Ubuntu 24.04";
const UBUNTU = "Canonical Ubuntu|24.04";
const BOOT_VOLUME_GB = 50;
/** OCI's limit on everything in `metadata`. */
const METADATA_MAX_BYTES = 32_000;

export function instanceName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/** UTF-8 text as base64, without `Buffer` (the desktop renders plugins too). */
export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** The user data: a shutdown timer, the host's bootstrap, then power off. */
export function userData(bootstrap: string, maxSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(maxSeconds / 60));
  const body = bootstrap.replace(/^#![^\n]*\n/, "");
  return [
    "#!/bin/bash",
    // The backstop: the instance powers itself off once the job's time is
    // up, whatever happens to the host or the bootstrap.
    `shutdown -h +${minutes} >/dev/null 2>&1 || true`,
    "(",
    body,
    ")",
    "shutdown -h now",
    "",
  ].join("\n");
}

/** `<shape>` or `<shape>/<OCPUs>/<memory GB>`, as the plugin's own size picker writes them. */
export function shapeOf(machine: string): {
  shape: string;
  shapeConfig?: { ocpus: number; memoryInGBs: number };
} {
  const { shape, ocpus, memoryGb } = parseSizeId(machine.trim());
  if (!shape) throw new Error(`\`${machine}\` is not an OCI shape.`);
  if (ocpus === undefined || memoryGb === undefined) {
    if (/\.Flex$/i.test(shape)) {
      throw new Error(
        `A Flex shape needs its size: \`${shape}/<OCPUs>/<memory GB>\`, e.g. ${shape}/1/8.`,
      );
    }
    return { shape };
  }
  if (!(ocpus > 0) || !(memoryGb > 0)) {
    throw new Error(
      `\`${machine}\` is \`<shape>/<OCPUs>/<memory GB>\` with numbers above zero, e.g. ${COMPUTE_DEFAULT_MACHINE}.`,
    );
  }
  return { shape, shapeConfig: { ocpus, memoryInGBs: memoryGb } };
}

/** The image for a job: an image OCID, `<operating system>|<version>`, or Ubuntu 24.04. */
export async function imageFor(
  ctx: OciCiContext,
  region: string,
  shape: string,
  image: string | undefined,
): Promise<string> {
  const wanted = !image || image === COMPUTE_DEFAULT_IMAGE ? UBUNTU : image;
  if (!wanted.startsWith("ocid1.image.") && !wanted.includes("|")) {
    throw new Error(
      `An OCI image is an image OCID or \`<operating system>|<version>\` (e.g. \`Canonical Ubuntu|24.04\`), not \`${image}\`.`,
    );
  }
  return resolveImage(
    { api: ctx.api, inventory: ctx.inventory, accountId: "" },
    region,
    wanted,
    shape,
  );
}

/** The launch body for a job in an availability domain (no image lookup). */
export function launchBody(
  spec: CiStartSpec,
  compartmentId: string,
  availabilityDomain: string,
  subnetId: string,
  imageId: string,
): Record<string, unknown> {
  const { shape, shapeConfig } = shapeOf(spec.machine ?? COMPUTE_DEFAULT_MACHINE);
  const data = base64(userData(spec.bootstrap, spec.maxSeconds));
  if (data.length > METADATA_MAX_BYTES) {
    throw new Error(
      `The job's start script is ${data.length} bytes as user data; OCI takes at most ${METADATA_MAX_BYTES}.`,
    );
  }
  if (spec.gpu && !/\.GPU/i.test(shape)) {
    throw new Error(
      "On OCI a GPU comes with the shape: name a GPU shape in `cloud.machine`, e.g. VM.GPU.A10.1.",
    );
  }
  return {
    availabilityDomain,
    compartmentId,
    displayName: instanceName(spec),
    shape,
    ...(shapeConfig ? { shapeConfig } : {}),
    sourceDetails: { sourceType: "image", imageId, bootVolumeSizeInGBs: BOOT_VOLUME_GB },
    createVnicDetails: { subnetId, assignPublicIp: true },
    metadata: { user_data: data },
    instanceOptions: { areLegacyImdsEndpointsDisabled: true },
    freeformTags: freeformTags(spec.tags),
  };
}

interface Instance {
  id: string;
  displayName?: string;
  lifecycleState?: string;
  timeCreated?: string;
  freeformTags?: Record<string, string>;
}

export function computeHandle(id: string, region: string): CiHandle {
  return { id, region, label: `oci compute ${id} (${region})`, data: { kind: "vm" } };
}

async function existing(
  ctx: OciCiContext,
  region: string,
  name: string,
): Promise<Instance | undefined> {
  const found = await ctx.api.listAll<Instance>({
    service: "iaas",
    region,
    path: "/20160918/instances",
    query: { compartmentId: ciCompartment(ctx), displayName: name, limit: 50 },
  });
  return found.find((i) => i.lifecycleState !== "TERMINATED" && i.lifecycleState !== "TERMINATING");
}

export async function computeStart(
  ctx: OciCiContext,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  const name = instanceName(spec);
  // A start retried after a lost answer finds the instance the first made.
  const before = await existing(ctx, region, name);
  if (before) return computeHandle(before.id, region);
  const { shape } = shapeOf(spec.machine ?? COMPUTE_DEFAULT_MACHINE);
  const [subnetId, imageId, ads] = await Promise.all([
    ensureNetwork(ctx, region),
    imageFor(ctx, region, shape, spec.image),
    availabilityDomains(ctx, region),
  ]);
  const key = ciComputeKey(spec);
  let lastErr: unknown;
  for (const ad of ads) {
    try {
      const res = await ctx.api.request<Instance>({
        service: "iaas",
        region,
        method: "POST",
        path: "/20160918/instances",
        body: launchBody(spec, ciCompartment(ctx), ad, subnetId, imageId),
        headers: { "opc-retry-token": retryToken("instance", key, ad) },
      });
      return computeHandle(res.data.id, region);
    } catch (err) {
      // A shape sold out in one availability domain may be there in the next.
      if (!isOutOfCapacity(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`No capacity for ${shape} in ${region}.`);
}

export async function computeStatus(ctx: OciCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  let instance: Instance;
  try {
    instance = await ctx.api.get<Instance>(
      "iaas",
      handle.region ?? ctx.inventory.homeRegion,
      `/20160918/instances/${handle.id}`,
    );
  } catch (err) {
    if (isNotFound(err)) return { state: "gone" };
    throw err;
  }
  const s = instance.lifecycleState ?? "";
  const state: CiComputeStatus["state"] =
    s === "PROVISIONING" || s === "STARTING" || s === "MOVING"
      ? "starting"
      : s === "RUNNING" || s === "CREATING_IMAGE"
        ? "running"
        : s === "TERMINATED"
          ? "gone"
          : "stopped";
  return { state, detail: s };
}

export async function computeTeardown(ctx: OciCiContext, handle: CiHandle): Promise<void> {
  try {
    await ctx.api.request({
      service: "iaas",
      region: handle.region ?? ctx.inventory.homeRegion,
      method: "DELETE",
      path: `/20160918/instances/${handle.id}`,
      // The default, said out loud: the boot volume goes with it.
      query: { preserveBootVolume: false },
    });
  } catch (err) {
    if (isNotFound(err)) return;
    // Already terminating: nothing more to ask for.
    if (err instanceof OciApiError && err.status === 409) return;
    throw err;
  }
}

export async function computeListTagged(
  ctx: OciCiContext,
  tagKey: string,
  region: string,
): Promise<CiTaggedCompute[]> {
  const instances = await ctx.api.listAll<Instance>({
    service: "iaas",
    region,
    path: "/20160918/instances",
    query: { compartmentId: ciCompartment(ctx), limit: 1000 },
  });
  const out: CiTaggedCompute[] = [];
  for (const instance of instances) {
    const tags = instance.freeformTags ?? {};
    if (!(tagKey in tags)) continue;
    const s = instance.lifecycleState ?? "";
    if (s === "TERMINATED") continue;
    out.push({
      handle: computeHandle(instance.id, region),
      tags,
      ...(instance.timeCreated ? { createdAt: instance.timeCreated } : {}),
      live: s === "PROVISIONING" || s === "STARTING" || s === "RUNNING" || s === "MOVING",
    });
  }
  return out;
}
