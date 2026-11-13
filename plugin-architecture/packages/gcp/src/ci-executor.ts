/**
 * CI jobs on Google Cloud: `vm` on Compute Engine (`ci-compute.ts`),
 * `container` as Cloud Run jobs (`ci-run-jobs.ts`) and `build` on Cloud
 * Build (`ci-cloud-build.ts`). None of them holds a useful credential:
 * the instance has no service account, and the job and the build run as
 * `infrawrench-ci-runner`, a service account with no roles (`ci-shared.ts`).
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
  BUILD_DEFAULT_IMAGE,
  BUILD_DEFAULT_MACHINE,
  BUILD_MACHINES,
  buildListTagged,
  buildPreflight,
  buildStart,
  buildStatus,
  buildTeardown,
} from "./ci-cloud-build.js";
import {
  COMPUTE_DEFAULT_IMAGE,
  COMPUTE_DEFAULT_MACHINE,
  computeListTagged,
  computePreflight,
  computeStart,
  computeStatus,
  computeTeardown,
} from "./ci-compute.js";
import {
  RUN_DEFAULT_IMAGE,
  RUN_DEFAULT_MACHINE,
  runListTagged,
  runPreflight,
  runStart,
  runStatus,
  runTeardown,
} from "./ci-run-jobs.js";
import { isApiDisabled, type GcpCiCalls } from "./ci-shared.js";

/** Where a job runs when the pipeline names no region: GCP keys carry none. */
export const CI_DEFAULT_REGION = "us-central1";

export const GCP_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Compute Engine instance",
      defaults: {
        machine: COMPUTE_DEFAULT_MACHINE,
        image: COMPUTE_DEFAULT_IMAGE,
        region: CI_DEFAULT_REGION,
      },
      typicalStartSeconds: 60,
      // Billed per second after the first minute.
      minimumBillingSeconds: 60,
      gpus: true,
      machineSuggestions: [
        "e2-standard-2",
        "e2-standard-4",
        "e2-highcpu-8",
        "n2-standard-4",
        "c3-standard-4",
        "c4a-standard-4",
        "t2a-standard-4",
        "g2-standard-4",
      ],
    },
    {
      kind: "container",
      label: "Cloud Run job",
      defaults: {
        machine: RUN_DEFAULT_MACHINE,
        image: RUN_DEFAULT_IMAGE,
        region: CI_DEFAULT_REGION,
      },
      typicalStartSeconds: 30,
      // Jobs are billed for an instance's whole life, with a one-minute minimum.
      minimumBillingSeconds: 60,
      machineSuggestions: ["1vcpu-2gb", "2vcpu-4gb", "4vcpu-8gb", "4vcpu-16gb", "8vcpu-32gb"],
    },
    {
      kind: "build",
      label: "Cloud Build build",
      defaults: {
        machine: BUILD_DEFAULT_MACHINE,
        image: BUILD_DEFAULT_IMAGE,
        region: CI_DEFAULT_REGION,
      },
      typicalStartSeconds: 30,
      machineSuggestions: BUILD_MACHINES,
    },
  ],
  helpLink: {
    label: "Grant these permissions to the service account",
    url: "https://console.cloud.google.com/iam-admin/iam",
  },
} as const satisfies CiExecutorDeclaration;

function kindOf(handle: CiHandle): CiExecutorKind {
  const kind = handle.data?.["kind"];
  return kind === "container" || kind === "build" ? kind : "vm";
}

function unsupported(kind: CiExecutorKind): Error {
  return new Error(
    `Google Cloud runs CI jobs of kind \`vm\`, \`container\` and \`build\`, not \`${kind}\`.`,
  );
}

export function gcpCiPreflight(
  calls: GcpCiCalls,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  const where = region ?? CI_DEFAULT_REGION;
  if (kind === "vm") return computePreflight(calls, where);
  if (kind === "container") return runPreflight(calls, where);
  if (kind === "build") return buildPreflight(calls, where);
  return Promise.reject(unsupported(kind));
}

export function gcpCiStart(calls: GcpCiCalls, spec: CiStartSpec): Promise<CiHandle> {
  const region = spec.region ?? CI_DEFAULT_REGION;
  if (spec.kind === "vm") return computeStart(calls, region, spec);
  if (spec.kind === "container") return runStart(calls, region, spec);
  if (spec.kind === "build") return buildStart(calls, region, spec);
  return Promise.reject(unsupported(spec.kind));
}

export function gcpCiStatus(calls: GcpCiCalls, handle: CiHandle): Promise<CiComputeStatus> {
  const kind = kindOf(handle);
  if (kind === "container") return runStatus(calls, handle);
  if (kind === "build") return buildStatus(calls, handle);
  return computeStatus(calls, handle);
}

export function gcpCiTeardown(calls: GcpCiCalls, handle: CiHandle): Promise<void> {
  const kind = kindOf(handle);
  if (kind === "container") return runTeardown(calls, handle);
  if (kind === "build") return buildTeardown(calls, handle);
  return computeTeardown(calls, handle);
}

/**
 * Everything tagged in `regions` (the default region when empty), across the
 * three kinds. A kind whose API the project never switched on, or which the
 * key may not list, has nothing to find, and does not hide the others.
 */
export async function gcpCiListTagged(
  calls: GcpCiCalls,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const where = regions.length > 0 ? regions : [CI_DEFAULT_REGION];
  const quiet = async (list: Promise<CiTaggedCompute[]>): Promise<CiTaggedCompute[]> => {
    try {
      return await list;
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      if (isApiDisabled(err) || status === 403) return [];
      throw err;
    }
  };
  const [vms, jobs, builds] = await Promise.all([
    quiet(computeListTagged(calls, tagKey, where)),
    quiet(runListTagged(calls, tagKey, where)),
    quiet(buildListTagged(calls, tagKey, where)),
  ]);
  return [...vms, ...jobs, ...builds];
}
