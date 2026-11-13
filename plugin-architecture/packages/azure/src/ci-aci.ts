/**
 * CI jobs as Azure Container Instances: one container group per job, in
 * the job's own resource group, deleted with the group when the job ends.
 *
 * **Wire shapes verified against the Container Instances REST reference
 * and swagger, November 2026** (api-version 2023-05-01, which the plugin
 * already uses):
 * - Container Groups - Create Or Update: `location`, `tags`,
 *   `properties.{osType: Linux, restartPolicy: Never, sku: Standard,
 *   containers[].{name, properties.{image, command[],
 *   resources.requests.{cpu, memoryInGB}}}}`, and no `identity`. Docker
 *   Hub images may be pulled; only x64 images run.
 * - Container Groups - Get: `properties.provisioningState`,
 *   `properties.instanceView.state`,
 *   `containers[].properties.instanceView.currentState.{state, exitCode}`.
 *
 * ACI has no maximum run time, so the container's command is
 * {@link ciContainerCommand}'s watchdog, which ends the container at the
 * job's deadline. It always exits 0: with `restartPolicy: Never` the
 * platform may still restart a container that exits otherwise, and the job
 * reports its own result to the host.
 */
import {
  ciComputeKey,
  ciContainerCommand,
  parseCiContainerSize,
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
  unregisteredProviders,
  type AzureCiCalls,
} from "./ci-shared.js";

export const ACI_DEFAULT_MACHINE = "2vcpu-4gb";
/** Docker's official `buildpack-deps:noble-curl` (Ubuntu 24.04 with curl). */
export const ACI_DEFAULT_IMAGE = "docker.io/library/buildpack-deps:noble-curl";
const ACI_API = "2023-05-01";
const GROUP_NAME = "iwci-job";

export const ACI_PERMISSIONS = {
  ...GROUP_PERMISSIONS,
  groupWrite: {
    permission: "Microsoft.ContainerInstance/containerGroups/write",
    label: "Start the job's container group",
  },
  groupRead: { permission: "Microsoft.ContainerInstance/containerGroups/read", label: "Follow it" },
  groupDelete: {
    permission: "Microsoft.ContainerInstance/containerGroups/delete",
    label: "Delete it when the job ends",
  },
} as const satisfies Record<string, CiMissingPermission>;

/** `cpu` and `memoryInGB` for a `<n>vcpu-<m>gb` machine. */
export function aciResources(machine: string): { cpu: number; memoryInGB: number } {
  const size = parseCiContainerSize(machine);
  // A standard container group takes up to 31 vCPUs and 240 GB; memory in tenths.
  if (size && size.vcpus <= 31 && size.memoryGb <= 240) {
    return { cpu: size.vcpus, memoryInGB: Math.round(size.memoryGb * 10) / 10 };
  }
  throw new Error(
    `Container Instances sizes a group by vCPUs and memory, as \`<vCPUs>vcpu-<GB>gb\` (e.g. ${ACI_DEFAULT_MACHINE}, at most 31 vCPUs and 240 GB), not \`${machine}\`.`,
  );
}

export function containerGroupBody(spec: CiStartSpec, location: string): Record<string, unknown> {
  return {
    location,
    tags: azureTags(spec.tags),
    properties: {
      osType: "Linux",
      restartPolicy: "Never",
      sku: "Standard",
      containers: [
        {
          name: "job",
          properties: {
            image: spec.image ?? ACI_DEFAULT_IMAGE,
            command: ciContainerCommand(spec.bootstrap, spec.maxSeconds, { exitZero: true }),
            resources: { requests: aciResources(spec.machine ?? ACI_DEFAULT_MACHINE) },
          },
        },
      ],
    },
  };
}

function containerGroupPath(subscriptionId: string, group: string): string {
  return `${groupPath(subscriptionId, group)}/providers/Microsoft.ContainerInstance/containerGroups/${GROUP_NAME}?api-version=${ACI_API}`;
}

export function aciHandle(group: string, location: string): CiHandle {
  return {
    id: group,
    region: location,
    label: `azure container instance ${group} (${location})`,
    data: { kind: "container" },
  };
}

export async function aciPreflight(
  calls: AzureCiCalls,
  location: string,
): Promise<CiPreflightResult> {
  const missing = await missingRoleActions(calls, Object.values(ACI_PERMISSIONS));
  const problems = await unregisteredProviders(calls, ["Microsoft.ContainerInstance"]);
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: location };
}

export async function aciStart(
  calls: AzureCiCalls,
  location: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  if (spec.gpu) {
    throw new Error("Container Instances has no GPUs here: use the `vm` kind for a GPU job.");
  }
  const body = containerGroupBody(spec, location);
  const group = groupName("container", ciComputeKey(spec));
  await putGroup(calls, group, location, spec.tags);
  const path = containerGroupPath(calls.subscriptionId, group);
  // A retried start finds the group it made and leaves it running.
  const existing = await calls.arm("GET", path);
  if (existing.status !== 200) {
    ok(await calls.arm("PUT", path, body), "Azure did not start the container group");
  }
  return aciHandle(group, location);
}

export async function aciStatus(calls: AzureCiCalls, handle: CiHandle): Promise<CiComputeStatus> {
  const answer = await calls.arm("GET", containerGroupPath(calls.subscriptionId, handle.id));
  if (answer.status === 404) {
    const group = await calls.arm(
      "GET",
      `${groupPath(calls.subscriptionId, handle.id)}?api-version=${RESOURCES_API}`,
    );
    return group.status === 404 ? { state: "gone" } : { state: "starting" };
  }
  const props = ok<{
    properties?: {
      provisioningState?: string;
      instanceView?: { state?: string };
      containers?: Array<{
        properties?: {
          instanceView?: { currentState?: { state?: string; detailStatus?: string } };
        };
      }>;
    };
  }>(answer, "Azure did not answer the container group").properties;
  const current = props?.containers?.[0]?.properties?.instanceView?.currentState;
  const provisioning = props?.provisioningState ?? "";
  if (provisioning === "Failed" || provisioning === "Canceled" || provisioning === "Unhealthy") {
    return { state: "stopped", detail: current?.detailStatus ?? provisioning };
  }
  if (current?.state === "Running") return { state: "running" };
  if (current?.state === "Terminated" || props?.instanceView?.state === "Stopped") {
    // Billing has stopped; the group lingers until it is deleted.
    return { state: "stopped", detail: current?.detailStatus ?? "Terminated" };
  }
  return { state: "starting", detail: current?.state ?? provisioning };
}
