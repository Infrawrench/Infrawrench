/**
 * CI jobs on Azure: `vm` on Virtual Machines (`ci-vm.ts`), `container` on
 * Container Instances (`ci-aci.ts`) and `build` on ACR Tasks
 * (`ci-acr.ts`). Each job's compute lives in a resource group of its own
 * (`ci-shared.ts`), so teardown is deleting that group, and the reaper finds
 * leftovers by the group's tags. Nothing a job runs on has a managed
 * identity.
 *
 * Container Apps jobs were left out on purpose: a job needs a Container Apps
 * environment, which takes minutes to make per job or is a standing
 * resource the connection would have to name, where a container group
 * starts on its own in seconds.
 */
import type {
  CiComputeStatus,
  CiExecutorDeclaration,
  CiExecutorKind,
  CiHandle,
  CiPreflightResult,
  CiStartSpec,
  CiTaggedCompute,
} from "@infrawrench/plugin-base";

import {
  ACI_DEFAULT_IMAGE,
  ACI_DEFAULT_MACHINE,
  aciHandle,
  aciPreflight,
  aciStart,
  aciStatus,
} from "./ci-aci.js";
import {
  ACR_DEFAULT_IMAGE,
  ACR_DEFAULT_MACHINE,
  acrPreflight,
  acrStart,
  acrStatus,
  cancelRun,
} from "./ci-acr.js";
import { deleteGroup, kindOfGroup, listTaggedGroups, type AzureCiCalls } from "./ci-shared.js";
import {
  VM_DEFAULT_IMAGE,
  VM_DEFAULT_MACHINE,
  vmHandle,
  vmPreflight,
  vmStart,
  vmStatus,
} from "./ci-vm.js";

/** Where a job runs when the pipeline names no region: Azure connections carry none. */
export const CI_DEFAULT_LOCATION = "eastus";

export const AZURE_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Azure virtual machine",
      defaults: {
        machine: VM_DEFAULT_MACHINE,
        image: VM_DEFAULT_IMAGE,
        region: CI_DEFAULT_LOCATION,
      },
      typicalStartSeconds: 120,
      // Billed for each full minute it runs.
      minimumBillingSeconds: 60,
      gpus: true,
      machineSuggestions: [
        "Standard_D2s_v5",
        "Standard_D4s_v5",
        "Standard_D8s_v5",
        "Standard_F8s_v2",
        "Standard_D4ps_v5",
        "Standard_NC4as_T4_v3",
      ],
    },
    {
      kind: "container",
      label: "Container Instances group",
      defaults: {
        machine: ACI_DEFAULT_MACHINE,
        image: ACI_DEFAULT_IMAGE,
        region: CI_DEFAULT_LOCATION,
      },
      typicalStartSeconds: 45,
      machineSuggestions: ["1vcpu-2gb", "2vcpu-4gb", "4vcpu-8gb", "4vcpu-16gb"],
    },
    {
      kind: "build",
      label: "ACR Tasks run",
      defaults: {
        machine: ACR_DEFAULT_MACHINE,
        image: ACR_DEFAULT_IMAGE,
        region: CI_DEFAULT_LOCATION,
      },
      // A registry is made for each job before its run starts.
      typicalStartSeconds: 90,
      machineSuggestions: ["2vcpu"],
    },
  ],
  helpLink: {
    label: "Assign a role with these actions to the app registration",
    url: "https://portal.azure.com/#view/Microsoft_Azure_Billing/SubscriptionsBladeV2",
  },
} as const satisfies CiExecutorDeclaration;

function unsupported(kind: CiExecutorKind): Error {
  return new Error(
    `Azure runs CI jobs of kind \`vm\`, \`container\` and \`build\`, not \`${kind}\`.`,
  );
}

export function azureCiPreflight(
  calls: AzureCiCalls,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  const where = region ?? CI_DEFAULT_LOCATION;
  if (kind === "vm") return vmPreflight(calls, where);
  if (kind === "container") return aciPreflight(calls, where);
  if (kind === "build") return acrPreflight(calls, where);
  return Promise.reject(unsupported(kind));
}

export function azureCiStart(calls: AzureCiCalls, spec: CiStartSpec): Promise<CiHandle> {
  const where = spec.region ?? CI_DEFAULT_LOCATION;
  if (spec.kind === "vm") return vmStart(calls, where, spec);
  if (spec.kind === "container") return aciStart(calls, where, spec);
  if (spec.kind === "build") return acrStart(calls, where, spec);
  return Promise.reject(unsupported(spec.kind));
}

export function azureCiStatus(calls: AzureCiCalls, handle: CiHandle): Promise<CiComputeStatus> {
  const kind = kindOfGroup(handle.id);
  if (kind === "container") return aciStatus(calls, handle);
  if (kind === "build") return acrStatus(calls, handle);
  return vmStatus(calls, handle);
}

export async function azureCiTeardown(calls: AzureCiCalls, handle: CiHandle): Promise<void> {
  if (!kindOfGroup(handle.id)) {
    throw new Error(`\`${handle.id}\` is not a resource group Infrawrench CI made`);
  }
  if (kindOfGroup(handle.id) === "build") await cancelRun(calls, handle);
  await deleteGroup(calls, handle.id);
}

/**
 * Every CI resource group carrying `tagKey`, in `regions` when any are
 * named. Groups being deleted are left out: their teardown is under way.
 */
export async function azureCiListTagged(
  calls: AzureCiCalls,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const wanted = new Set(regions.map((r) => r.toLowerCase()));
  const out: CiTaggedCompute[] = [];
  for (const group of await listTaggedGroups(calls, tagKey)) {
    if (group.deleting) continue;
    if (wanted.size > 0 && !wanted.has(group.location.toLowerCase())) continue;
    const kind = kindOfGroup(group.name);
    const handle =
      kind === "container"
        ? aciHandle(group.name, group.location)
        : kind === "build"
          ? {
              id: group.name,
              region: group.location,
              label: `azure acr ${group.name} (${group.location})`,
              data: { kind: "build" },
            }
          : vmHandle(group.name, group.location);
    const { state } = await azureCiStatus(calls, handle).catch(() => ({
      state: "stopped" as const,
    }));
    out.push({
      handle,
      tags: group.tags,
      ...(group.createdAt ? { createdAt: group.createdAt } : {}),
      live: state === "starting" || state === "running",
    });
  }
  return out;
}
