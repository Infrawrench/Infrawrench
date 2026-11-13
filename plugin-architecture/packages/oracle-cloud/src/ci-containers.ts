/**
 * CI jobs on OCI Container Instances: one container instance per job,
 * running the host's bootstrap as its only container, deleted when the job
 * ends.
 *
 * **Wire shapes verified against the Container Instances API reference
 * (20210415) and the oci-typescript-sdk `containerinstances` models,
 * November 2026:**
 * - Host `compute-containers.{region}.oci.{domain}`, paths under
 *   `/20210415`.
 * - `CreateContainerInstance` (`POST /containerInstances`,
 *   `opc-retry-token`): `compartmentId`, `availabilityDomain`,
 *   `displayName`, `shape`, `shapeConfig.{ocpus, memoryInGBs}`,
 *   `containers[].{displayName, imageUrl, command, arguments,
 *   isResourcePrincipalDisabled}`, `vnics[].{subnetId, isPublicIpAssigned}`,
 *   `containerRestartPolicy` (ALWAYS, NEVER, ON_FAILURE),
 *   `gracefulShutdownTimeoutInSeconds`, `freeformTags`.
 * - `GetContainerInstance`, `ListContainerInstances` (`compartmentId`,
 *   `displayName`, `lifecycleState`; summaries carry `freeformTags`),
 *   `DeleteContainerInstance`; `lifecycleState` CREATING, UPDATING, ACTIVE,
 *   INACTIVE, DELETING, DELETED, FAILED.
 *
 * A container gets the container instance's resource principal unless
 * `isResourcePrincipalDisabled` is set, so it is set: the job holds no OCI
 * credential. Container Instances has no run-time limit, so the container's
 * command is the watchdog from `ciContainerCommand`, and the restart policy
 * is NEVER, so the instance goes INACTIVE when the job ends.
 */
import {
  ciBootstrapWithTools,
  ciComputeKey,
  ciContainerCommand,
  parseCiContainerSize,
  type CiComputeStatus,
  type CiHandle,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { OciApiError } from "./api.js";
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

export const CONTAINER_DEFAULT_SHAPE = "CI.Standard.E4.Flex";
export const CONTAINER_DEFAULT_MACHINE = "2vcpu-8gb";
/** Docker's official `buildpack-deps:noble-curl` (Ubuntu 24.04 with curl). */
export const CONTAINER_DEFAULT_IMAGE = "docker.io/library/buildpack-deps:noble-curl";
const BASE = "/20210415";

export function containerInstanceName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/**
 * A container `machine`: `<vCPUs>vcpu-<GB>gb` on the default shape (two
 * vCPUs to an OCPU on its AMD processors), or `<shape>/<OCPUs>/<memory GB>`.
 */
export function containerShape(machine: string): {
  shape: string;
  shapeConfig: { ocpus: number; memoryInGBs: number };
} {
  const size = parseCiContainerSize(machine);
  if (size) {
    const ocpus = size.vcpus / 2;
    if (!Number.isInteger(ocpus) || ocpus < 1) {
      throw new Error(
        `${CONTAINER_DEFAULT_SHAPE} counts in OCPUs of two vCPUs: ask for an even number of vCPUs, e.g. ${CONTAINER_DEFAULT_MACHINE}.`,
      );
    }
    return {
      shape: CONTAINER_DEFAULT_SHAPE,
      shapeConfig: { ocpus, memoryInGBs: size.memoryGb },
    };
  }
  const { shape, ocpus, memoryGb } = parseSizeId(machine.trim());
  if (shape?.startsWith("CI.") && ocpus! > 0 && memoryGb! > 0) {
    return { shape, shapeConfig: { ocpus: ocpus!, memoryInGBs: memoryGb! } };
  }
  throw new Error(
    `A container \`machine\` on OCI is \`<vCPUs>vcpu-<GB>gb\` (e.g. ${CONTAINER_DEFAULT_MACHINE}) or \`<shape>/<OCPUs>/<memory GB>\` (e.g. CI.Standard.A1.Flex/2/8), not \`${machine}\`.`,
  );
}

/** The create body for a job in an availability domain. */
export function containerBody(
  spec: CiStartSpec,
  compartmentId: string,
  availabilityDomain: string,
  subnetId: string,
): Record<string, unknown> {
  if (spec.gpu) {
    throw new Error(
      "OCI Container Instances have no GPUs: use the `vm` kind with a GPU shape for a GPU job.",
    );
  }
  const { shape, shapeConfig } = containerShape(spec.machine ?? CONTAINER_DEFAULT_MACHINE);
  const [entry, flag, ...args] = ciContainerCommand(
    ciBootstrapWithTools(spec.bootstrap),
    spec.maxSeconds,
  );
  return {
    compartmentId,
    availabilityDomain,
    displayName: containerInstanceName(spec),
    shape,
    shapeConfig,
    containers: [
      {
        displayName: "job",
        imageUrl: spec.image ?? CONTAINER_DEFAULT_IMAGE,
        command: [entry, flag],
        arguments: args,
        // No OCI credential in the job.
        isResourcePrincipalDisabled: true,
        freeformTags: freeformTags(spec.tags),
      },
    ],
    vnics: [{ subnetId, isPublicIpAssigned: true, freeformTags: freeformTags(spec.tags) }],
    containerRestartPolicy: "NEVER",
    gracefulShutdownTimeoutInSeconds: 10,
    freeformTags: freeformTags(spec.tags),
  };
}

interface ContainerInstance {
  id: string;
  displayName?: string;
  lifecycleState?: string;
  lifecycleDetails?: string;
  timeCreated?: string;
  freeformTags?: Record<string, string>;
}

export function containerHandle(id: string, region: string): CiHandle {
  return {
    id,
    region,
    label: `oci container instance ${id} (${region})`,
    data: { kind: "container" },
  };
}

export async function containerStart(
  ctx: OciCiContext,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  const name = containerInstanceName(spec);
  const compartmentId = ciCompartment(ctx);
  const before = (
    await ctx.api.listAll<ContainerInstance>({
      service: "compute-containers",
      region,
      path: `${BASE}/containerInstances`,
      query: { compartmentId, displayName: name, limit: 50 },
    })
  ).find((c) => c.lifecycleState !== "DELETED" && c.lifecycleState !== "DELETING");
  if (before) return containerHandle(before.id, region);
  // Checked before anything is made.
  containerShape(spec.machine ?? CONTAINER_DEFAULT_MACHINE);
  const [subnetId, ads] = await Promise.all([
    ensureNetwork(ctx, region),
    availabilityDomains(ctx, region),
  ]);
  const key = ciComputeKey(spec);
  let lastErr: unknown;
  for (const ad of ads) {
    try {
      const res = await ctx.api.request<ContainerInstance>({
        service: "compute-containers",
        region,
        method: "POST",
        path: `${BASE}/containerInstances`,
        body: containerBody(spec, compartmentId, ad, subnetId),
        headers: { "opc-retry-token": retryToken("container", key, ad) },
      });
      return containerHandle(res.data.id, region);
    } catch (err) {
      if (!isOutOfCapacity(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`No container capacity in ${region}.`);
}

export async function containerStatus(
  ctx: OciCiContext,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  let instance: ContainerInstance;
  try {
    instance = await ctx.api.get<ContainerInstance>(
      "compute-containers",
      handle.region ?? ctx.inventory.homeRegion,
      `${BASE}/containerInstances/${handle.id}`,
    );
  } catch (err) {
    if (isNotFound(err)) return { state: "gone" };
    throw err;
  }
  const s = instance.lifecycleState ?? "";
  const state: CiComputeStatus["state"] =
    s === "CREATING"
      ? "starting"
      : s === "ACTIVE" || s === "UPDATING"
        ? "running"
        : s === "DELETING" || s === "DELETED"
          ? "gone"
          : "stopped";
  const detail = instance.lifecycleDetails ? `${s}: ${instance.lifecycleDetails}` : s;
  return { state, detail };
}

export async function containerTeardown(ctx: OciCiContext, handle: CiHandle): Promise<void> {
  try {
    await ctx.api.request({
      service: "compute-containers",
      region: handle.region ?? ctx.inventory.homeRegion,
      method: "DELETE",
      path: `${BASE}/containerInstances/${handle.id}`,
    });
  } catch (err) {
    if (isNotFound(err)) return;
    // Already being deleted.
    if (err instanceof OciApiError && err.status === 409) return;
    throw err;
  }
}

export async function containerListTagged(
  ctx: OciCiContext,
  tagKey: string,
  region: string,
): Promise<CiTaggedCompute[]> {
  const instances = await ctx.api.listAll<ContainerInstance>({
    service: "compute-containers",
    region,
    path: `${BASE}/containerInstances`,
    query: { compartmentId: ciCompartment(ctx), limit: 1000 },
  });
  const out: CiTaggedCompute[] = [];
  for (const instance of instances) {
    const tags = instance.freeformTags ?? {};
    const s = instance.lifecycleState ?? "";
    if (!(tagKey in tags) || s === "DELETED") continue;
    out.push({
      handle: containerHandle(instance.id, region),
      tags,
      ...(instance.timeCreated ? { createdAt: instance.timeCreated } : {}),
      live: s === "CREATING" || s === "ACTIVE" || s === "UPDATING",
    });
  }
  return out;
}
