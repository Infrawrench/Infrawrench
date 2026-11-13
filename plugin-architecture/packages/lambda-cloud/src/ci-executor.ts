/**
 * CI jobs on Lambda Cloud: one fresh on-demand GPU instance per job, started
 * with the host's bootstrap as cloud-init user data and terminated when the
 * job ends.
 *
 * **Wire shapes verified against Lambda's OpenAPI document (1.10.0,
 * `cloud.lambda.ai/api/v1/openapi.json`) and docs, November 2026:**
 * - `POST /instance-operations/launch`: `region_name`, `instance_type_name`,
 *   `ssh_key_names` ("currently, exactly one SSH key must be specified"),
 *   `name` (at most 64 characters), `hostname` (`^[a-z0-9][0-9a-z-]{0,62}$`),
 *   `image` (`{id}` or `{family}`; omitted is the latest Lambda Stack),
 *   `user_data` (cloud-init, plain text, at most 1 MB), `tags`
 *   (`[{key, value}]`, keys `^[a-z][a-z0-9-:]+$` up to 55 characters, values
 *   up to 128). Launches are limited to one per 12 seconds.
 * - `GET /instances` (pages by `page_token`, no tag filter) and
 *   `GET /instances/{id}`; `status` is `booting`, `active`, `unhealthy`,
 *   `terminating`, `terminated` or `preempted`. An unknown id answers 404
 *   `global/object-does-not-exist`.
 * - `POST /instance-operations/terminate` `{instance_ids}`; 404 for an id
 *   that does not exist.
 * - `POST /ssh-keys` `{name, public_key}`, `DELETE /ssh-keys/{id}`.
 * - `GET /instance-types`: each type with `instance_type.specs.gpus`,
 *   `gpu_description` and `regions_with_capacity_available`, which is how a
 *   `cloud.gpu` request becomes a type and a region with room for it.
 *
 * **No credentials on the machine.** The instance gets the user data and a
 * throwaway SSH key whose private half is never kept (Lambda requires one);
 * the key object is deleted as soon as the launch answers.
 *
 * **Backstop.** Lambda bills in one-minute increments until an instance is
 * terminated, and its docs say a shutdown from inside the guest does not
 * stop billing (the instance goes to Alert status instead). So the user data
 * only stops the job at its deadline (`timeout`), it does not power off; the
 * host's teardown and its reaper, which finds instances by tag, are what end
 * the bill. Lambda has no run-time limit or self-termination for instances.
 *
 * **Preflight.** Lambda's IAM has roles but no call that checks a permission
 * by name, so the check makes harmless calls: reads of instances and SSH
 * keys, and a terminate and a key delete of ids that do not exist (403 means
 * the permission is missing, 404 that it is there). Launch and key creation
 * cannot be tried without making something; the Workspace Member and Owner
 * roles, which grant the probed permissions, grant those too.
 */
import {
  CI_JOB_TAG,
  ciGpuMatches,
  ciHttpStatus,
  ciMachineName,
  ciShellQuote,
  ciThrowawaySshKey,
  parseCiGpu,
  pathEncode,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { listInstances, listOf, unwrap, type LambdaApi } from "./api.js";
import type { LInstance, LInstanceTypeItem } from "./types.js";

export const CI_DEFAULT_MACHINE = "gpu_1x_a10";
/** Lambda's own default when `image` is left out. */
export const CI_DEFAULT_IMAGE = "Lambda Stack";

export const LAMBDA_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "On-demand GPU instance",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE },
      // "Instances might take several minutes to launch."
      typicalStartSeconds: 300,
      // Billed in one-minute increments.
      minimumBillingSeconds: 60,
      gpus: true,
      machineSuggestions: [
        "gpu_1x_a10",
        "gpu_1x_a6000",
        "gpu_1x_a100_sxm4",
        "gpu_1x_h100_pcie",
        "gpu_1x_h100_sxm5",
        "gpu_1x_gh200",
        "gpu_8x_a100_80gb_sxm4",
        "gpu_8x_h100_sxm5",
      ],
    },
  ],
  helpLink: {
    label: "Give the API key's identity the Workspace Member role",
    url: "https://docs.lambda.ai/public-cloud/predefined-roles/",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  readInstances: { permission: "Instance: Read", label: "Follow the job's instance" },
  terminate: { permission: "Instance: Terminate", label: "Remove it when the job ends" },
  readKeys: { permission: "SSH Key: Read", label: "Find the job's SSH key" },
  deleteKey: {
    permission: "SSH Key: Delete",
    label: "Remove the throwaway SSH key the launch needs",
  },
} as const satisfies Record<string, CiMissingPermission>;

/** An instance id that cannot exist, for permission probes. */
const NO_SUCH_ID = "00000000000000000000000000000000";
const TAG_KEY = /^[a-z][a-z0-9-:]{1,54}$/;

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`Lambda Cloud runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

/**
 * A tag key as Lambda takes it. The CI keys fit as they are; any other key
 * goes as `x-` and its UTF-8 bytes in hex, which {@link tagKeyOf} reverses.
 */
export function lambdaTagKey(key: string): string {
  if (TAG_KEY.test(key) && !key.startsWith("x-")) return key;
  const hex = Array.from(new TextEncoder().encode(key))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `x-${hex}`.slice(0, 55);
}

function tagKeyOf(key: string): string {
  const hex = /^x-((?:[0-9a-f]{2})+)$/.exec(key)?.[1];
  if (!hex) return key;
  const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  return new TextDecoder().decode(bytes);
}

export function lambdaTags(tags: Readonly<Record<string, string>>) {
  return Object.entries(tags).map(([key, value]) => ({
    key: lambdaTagKey(key),
    value: value.slice(0, 128),
  }));
}

function tagsOf(instance: LInstance): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of instance.tags ?? []) out[tagKeyOf(tag.key)] = tag.value;
  return out;
}

/**
 * The user data: the bootstrap as root, stopped at the job's deadline. It
 * does not power off: on Lambda that keeps billing and sends the instance to
 * Alert status.
 */
export function lambdaUserData(bootstrap: string, maxSeconds: number): string {
  const seconds = Math.max(60, Math.ceil(maxSeconds));
  return [
    "#!/bin/bash",
    "# Infrawrench CI: run the job, and stop it once its time is up.",
    `timeout --kill-after=30 ${seconds} /bin/bash -c ${ciShellQuote(bootstrap)}`,
    "",
  ].join("\n");
}

/** The GPU model words of an instance type's name: `gpu_8x_h100_sxm5` is `h100 sxm5`. */
function modelOf(typeName: string): string {
  return typeName.replace(/^gpu_\d+x_/, "").replace(/_/g, " ");
}

function matchesGpu(item: LInstanceTypeItem, type: string, count: number): boolean {
  const t = item.instance_type;
  return (
    t.specs.gpus === count &&
    (ciGpuMatches(type, modelOf(t.name)) || ciGpuMatches(type, t.gpu_description))
  );
}

/** The instance type and region a job runs on, from its machine, GPU and region. */
export async function placeJob(
  types: () => Promise<LInstanceTypeItem[]>,
  spec: Pick<CiStartSpec, "machine" | "gpu" | "region">,
): Promise<{ machine: string; region: string }> {
  const gpu = spec.gpu ? parseCiGpu(spec.gpu) : undefined;
  const named = spec.machine && spec.machine !== CI_DEFAULT_MACHINE ? spec.machine : undefined;
  if (!gpu && spec.region)
    return { machine: spec.machine ?? CI_DEFAULT_MACHINE, region: spec.region };
  const all = await types();
  let candidates: LInstanceTypeItem[];
  if (gpu && !named) {
    candidates = all.filter((item) => matchesGpu(item, gpu.type, gpu.count));
    if (candidates.length === 0) {
      const offered = [...new Set(all.map((i) => i.instance_type.gpu_description))].sort();
      throw new Error(
        `Lambda Cloud has no instance type with ${gpu.count} ${gpu.type} GPU${gpu.count === 1 ? "" : "s"}. It offers ${offered.join(", ") || "none right now"}.`,
      );
    }
  } else {
    const machine = spec.machine ?? CI_DEFAULT_MACHINE;
    candidates = all.filter((item) => item.instance_type.name === machine);
    if (candidates.length === 0) {
      throw new Error(`Lambda Cloud has no instance type \`${machine}\`.`);
    }
    if (gpu && !candidates.some((item) => matchesGpu(item, gpu.type, gpu.count))) {
      throw new Error(
        `\`${machine}\` does not have ${gpu.count} ${gpu.type} GPU${gpu.count === 1 ? "" : "s"}; leave \`cloud.machine\` out to pick by \`cloud.gpu\`.`,
      );
    }
  }
  const withRoom = candidates
    .map((item) => ({
      item,
      regions: item.regions_with_capacity_available
        .map((r) => r.name)
        .filter((r) => !spec.region || r === spec.region),
    }))
    .filter((c) => c.regions.length > 0)
    .sort(
      (a, b) =>
        a.item.instance_type.price_cents_per_hour - b.item.instance_type.price_cents_per_hour,
    );
  const best = withRoom[0];
  if (!best) {
    const names = candidates.map((c) => c.instance_type.name).join(", ");
    throw new Error(
      `Lambda Cloud has no capacity for ${names}${spec.region ? ` in ${spec.region}` : ""} right now. Try again later, or another region or GPU.`,
    );
  }
  return { machine: best.item.instance_type.name, region: best.regions[0]! };
}

function imageOf(image: string | undefined): { id: string } | { family: string } | undefined {
  if (!image || image === CI_DEFAULT_IMAGE) return undefined;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(image)
    ? { id: image }
    : { family: image };
}

/** The launch body for a job, once its type, region and key are known. */
export function launchBody(
  spec: CiStartSpec,
  placed: { machine: string; region: string },
  keyName: string,
) {
  const name = ciMachineName(spec);
  const image = imageOf(spec.image);
  return {
    region_name: placed.region,
    instance_type_name: placed.machine,
    ssh_key_names: [keyName],
    name,
    hostname: name,
    ...(image ? { image } : {}),
    user_data: lambdaUserData(spec.bootstrap, spec.maxSeconds),
    tags: lambdaTags(spec.tags),
  };
}

function handleOf(instance: LInstance): CiHandle {
  const region = instance.region?.name ?? "";
  return {
    id: instance.id,
    region,
    label: `lambda-cloud instance ${instance.id.slice(0, 12)} (${region})`,
  };
}

async function quietly(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best effort: an SSH key costs nothing and holds no private half.
  }
}

async function findInstance(api: LambdaApi, spec: CiStartSpec): Promise<LInstance | undefined> {
  const name = ciMachineName(spec);
  const job = spec.tags[CI_JOB_TAG];
  return (await listInstances(api)).find(
    (i) =>
      i.name === name &&
      i.status !== "terminated" &&
      i.status !== "terminating" &&
      (!job || tagsOf(i)[CI_JOB_TAG] === job),
  );
}

export async function lambdaCiPreflight(
  api: LambdaApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  const probe = async (permission: CiMissingPermission, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      const status = ciHttpStatus(err);
      if (status === 403) missing.push(permission);
      else if (status !== 404) {
        problems.push(
          `Lambda Cloud refused a check: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  await probe(CI_PERMISSIONS.readInstances, () =>
    api.get("/instances", { query: { page_size: 1 } }),
  );
  await probe(CI_PERMISSIONS.readKeys, () => api.get("/ssh-keys"));
  await probe(CI_PERMISSIONS.terminate, () =>
    api.post("/instance-operations/terminate", { body: { instance_ids: [NO_SUCH_ID] } }),
  );
  await probe(CI_PERMISSIONS.deleteKey, () => api.delete(`/ssh-keys/${pathEncode(NO_SUCH_ID)}`));
  if (region) {
    try {
      const regions = listOf(await api.get("/regions"), "/regions");
      if (!regions.some((r) => r.name === region)) {
        problems.push(
          `Lambda Cloud has no region \`${region}\`. Name one such as ${regions
            .slice(0, 4)
            .map((r) => r.name)
            .join(", ")}.`,
        );
      }
    } catch {
      // Not being able to look is no reason to refuse: the launch says so.
    }
  }
  return {
    ok: missing.length === 0 && problems.length === 0,
    missing,
    problems,
    ...(region ? { region } : {}),
  };
}

export async function lambdaCiStart(
  api: LambdaApi,
  types: () => Promise<LInstanceTypeItem[]>,
  spec: CiStartSpec,
): Promise<CiHandle> {
  requireVm(spec.kind);
  // The job's name makes a start idempotent: a retry finds what the first made.
  const found = await findInstance(api, spec);
  if (found) return handleOf(found);
  const placed = await placeJob(types, spec);
  const keyName = ciMachineName(spec);
  const keys = listOf(await api.get("/ssh-keys"), "/ssh-keys");
  let keyId = keys.find((k) => k.name === keyName)?.id;
  if (!keyId) {
    const created = unwrap(
      await api.post("/ssh-keys", {
        body: { name: keyName, public_key: await ciThrowawaySshKey(keyName) },
      }),
    );
    keyId = created?.id;
  }
  try {
    const launched = unwrap(
      await api.post("/instance-operations/launch", {
        body: launchBody(spec, placed, keyName),
      }),
    );
    const id = launched?.instance_ids?.[0];
    if (!id) throw new Error("Lambda Cloud launched no instance");
    return {
      id,
      region: placed.region,
      label: `lambda-cloud instance ${id.slice(0, 12)} (${placed.region})`,
    };
  } finally {
    // The instance has its copy of the key; the account needs none.
    const id = keyId;
    if (id) await quietly(() => api.delete(`/ssh-keys/${pathEncode(id)}`));
  }
}

export async function lambdaCiStatus(api: LambdaApi, handle: CiHandle): Promise<CiComputeStatus> {
  let instance: LInstance | undefined;
  try {
    instance = unwrap(await api.get(`/instances/${pathEncode(handle.id)}`));
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  if (!instance) return { state: "gone" };
  const status = instance.status;
  const state: CiComputeStatus["state"] =
    status === "booting"
      ? "starting"
      : status === "active" || status === "unhealthy"
        ? "running"
        : status === "terminating" || status === "terminated"
          ? "gone"
          : "stopped";
  return { state, detail: status };
}

export async function lambdaCiTeardown(api: LambdaApi, handle: CiHandle): Promise<void> {
  try {
    await api.post("/instance-operations/terminate", { body: { instance_ids: [handle.id] } });
  } catch (err) {
    if (ciHttpStatus(err) === 404) return;
    // An instance already on its way out may refuse a second terminate.
    const now = await lambdaCiStatus(api, handle).catch(() => undefined);
    if (now?.state === "gone") return;
    throw err;
  }
}

/**
 * Every instance carrying the tag. Lambda's list has no tag filter, so it
 * lists them all and keeps the tagged ones; it is account-wide, so `regions`
 * does not narrow it.
 */
export async function lambdaCiListTagged(
  api: LambdaApi,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const instance of await listInstances(api)) {
    const tags = tagsOf(instance);
    if (!(tagKey in tags)) continue;
    if (instance.status === "terminated") continue;
    out.push({
      handle: handleOf(instance),
      tags,
      live:
        instance.status === "booting" ||
        instance.status === "active" ||
        instance.status === "unhealthy",
    });
  }
  return out;
}
