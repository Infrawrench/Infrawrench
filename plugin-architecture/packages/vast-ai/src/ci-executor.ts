/**
 * CI jobs on Vast.ai: one instance per job, rented from the cheapest
 * verified on-demand offer that fits, and destroyed when the job ends.
 *
 * Only the `container` kind: a Vast.ai instance is a Docker container on a
 * host from the marketplace. (The create body has a `vm` flag for hosts
 * that offer VMs, but that is a host feature, not something a job can
 * count on finding.)
 *
 * **Wire shapes verified against Vast.ai's OpenAPI document
 * (`https://docs.vast.ai/api-reference/openapi.yaml`, the one
 * `plugingen.json` names) and docs, November 2026:**
 * - `POST /api/v0/bundles/` searches offers: `verified`, `rentable`,
 *   `rented`, `external` (`{eq}`), `gpu_name` and `num_gpus` (`{in}`),
 *   `type: "ondemand"`, `order: [["dph_total", "asc"]]`, `limit`. Offers
 *   give `id`, `gpu_name`, `num_gpus`, `cpu_cores_effective`, `cpu_ram`
 *   (MB), `disk_space` (GB), `dph_total`, `geolocation`.
 * - `PUT /api/v0/asks/{offer}/` rents one: `image`, `runtype: "args"`
 *   (entrypoint mode, the image's own entrypoint gets `args`), `args`,
 *   `env`, `label`, `disk`, `target_state: "running"`, `cancel_unavail`;
 *   answers `{success, new_contract}`, the instance id.
 * - `GET /api/v1/instances/` (cursor-paged, `select_filters` on `label`)
 *   and `GET /api/v0/instances/{id}/` give `label`, `actual_status`
 *   (`null`, `loading`, `running`, `exited`, `offline`, `unknown`),
 *   `intended_status`, `start_date` and `extra_env` (`[key, value]` pairs).
 * - `DELETE /api/v0/instances/{id}/` destroys; an unknown id answers 404.
 *
 * Instances have no tags: the name `iwci-<job key>` is the `label`, and the
 * tags ride in the `INFRAWRENCH_CI_TAGS` environment variable (base64 of
 * their JSON, not secret), which the instance listing returns.
 *
 * **Billing.** Compute bills by the second while the instance is active, and
 * storage by the second for as long as it exists, stopped or not, so only
 * destroying it ends the bill. There is no documented minimum. At zero
 * credit Vast stops instances but does not destroy them.
 *
 * **Credentials on the instance.** The connection's key never reaches it.
 * Vast injects `CONTAINER_API_KEY`, "a restricted key ... it can only start,
 * stop, or destroy that specific instance". The instance's command keeps it
 * out of the job's environment and uses it to destroy its own instance when
 * the job ends or its time is up (a job running as root can still read it
 * from `/proc/1/environ`). Account-level environment variables set in the
 * Vast console are injected into every instance, this one included.
 *
 * **Backstop.** Vast has no time limit for an instance, so the job runs under
 * `ciContainerCommand`'s watchdog and the instance destroys itself
 * afterwards; the host's teardown and its reaper destroy what that misses.
 */
import {
  CI_JOB_TAG,
  base64ToUtf8,
  ciBootstrapWithTools,
  ciContainerCommand,
  ciGpuMatches,
  ciHttpStatus,
  ciMachineName,
  parseCiContainerSize,
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

import type { VastApi } from "./api.js";
import type { operations } from "./api-types.gen.js";
import type { VInstance, VOffer } from "./types.js";

export const CI_DEFAULT_MACHINE = "4vcpu-16gb";
/** Ubuntu 24.04 with curl and CA certificates: what the bootstrap needs. */
export const CI_DEFAULT_IMAGE = "docker.io/library/buildpack-deps:noble-curl";
/** The environment variable that keeps the job's tags, as base64 of their JSON. */
export const TAGS_ENV = "INFRAWRENCH_CI_TAGS";
/** The instance's disk, in GB. */
export const CI_DISK_GB = 32;
/** How many offers one start tries before it gives up (others may rent them first). */
const MAX_RENT_TRIES = 3;

export const VAST_CI_EXECUTOR = {
  kinds: [
    {
      kind: "container",
      label: "Instance (GPU container)",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE },
      // No documented start time; hosts pull the image, which dominates.
      typicalStartSeconds: 180,
      // Billed by the second with no minimum, so no minimumBillingSeconds.
      gpus: true,
      machineSuggestions: [
        "4vcpu-16gb",
        "8vcpu-32gb",
        "16vcpu-64gb",
        "RTX 3090",
        "RTX 4090",
        "RTX 5090",
        "RTX A6000",
        "L40S",
        "A100 SXM4",
        "H100 SXM",
        "H200",
      ],
    },
  ],
  helpLink: {
    label: "Create a Vast.ai API key with instance read and write",
    url: "https://cloud.vast.ai/manage-keys/",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  read: { permission: "instance_read", label: "Follow the job's instance and find leftovers" },
  write: {
    permission: "instance_write",
    label: "Rent the job's instance and destroy it when the job ends",
  },
} as const satisfies Record<string, CiMissingPermission>;

function requireContainer(kind: CiExecutorKind): void {
  if (kind !== "container") {
    throw new Error(`Vast.ai runs CI jobs of kind \`container\` (an instance), not \`${kind}\`.`);
  }
}

export function encodeTags(tags: Readonly<Record<string, string>>): string {
  return utf8ToBase64(JSON.stringify(tags));
}

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

/** An environment variable from `extra_env`, which lists `[key, value]` pairs. */
export function envValue(extraEnv: unknown, key: string): string | undefined {
  if (!Array.isArray(extraEnv)) return undefined;
  for (const entry of extraEnv as unknown[]) {
    if (Array.isArray(entry) && entry[0] === key && typeof entry[1] === "string") return entry[1];
    if (typeof entry === "string" && entry.startsWith(`${key}=`))
      return entry.slice(key.length + 1);
  }
  return undefined;
}

function tagsOfInstance(instance: VInstance): Record<string, string> | null {
  return decodeTags(envValue((instance as { extra_env?: unknown }).extra_env, TAGS_ENV));
}

/**
 * The instance's argv in entrypoint mode: the job under the watchdog, with
 * Vast's instance key out of its environment, then the instance destroying
 * itself with that key.
 */
export function instanceArgs(bootstrap: string, maxSeconds: number): string[] {
  const [, , watchdog, , script] = ciContainerCommand(ciBootstrapWithTools(bootstrap), maxSeconds);
  const outer = [
    'iwci_key="${CONTAINER_API_KEY:-}"',
    "unset CONTAINER_API_KEY",
    'sh -c "$1" iwci "$2"',
    "status=$?",
    'if [ -n "$iwci_key" ] && [ -n "${CONTAINER_ID:-}" ]; then',
    '  curl -fsS -m 30 -X DELETE -H "Authorization: Bearer $iwci_key" "https://console.vast.ai/api/v0/instances/$CONTAINER_ID/" >/dev/null 2>&1 || true',
    "fi",
    'exit "$status"',
  ].join("\n");
  return ["/bin/sh", "-c", outer, "iwci", watchdog ?? "", script ?? ""];
}

/** What the job asks of an offer. */
export interface OfferNeeds {
  /** The GPU type as written, or none for any GPU. */
  gpuType?: string;
  gpuCount: number;
  vcpus: number;
  memoryGb: number;
  region?: string;
}

/**
 * Reads `cloud.machine` and `cloud.gpu`: a machine is `<vCPUs>vcpu-<GB>gb`,
 * the least an offer must have, or a GPU type (`RTX 4090`); `cloud.gpu`
 * names the GPU and how many. Every Vast.ai offer comes with GPUs, so a job
 * without either gets the cheapest single GPU that fits.
 */
export function offerNeeds(spec: Pick<CiStartSpec, "machine" | "gpu" | "region">): OfferNeeds {
  const machine = spec.machine ?? CI_DEFAULT_MACHINE;
  const size = parseCiContainerSize(machine);
  const region = spec.region ? { region: spec.region } : {};
  const floor = size ? { vcpus: size.vcpus, memoryGb: size.memoryGb } : { vcpus: 0, memoryGb: 0 };
  if (spec.gpu) {
    const { type, count } = parseCiGpu(spec.gpu);
    if (!size && !ciGpuMatches(type, machine) && !ciGpuMatches(machine, type)) {
      throw new Error(
        `\`cloud.machine\` names ${machine} and \`cloud.gpu\` ${type}; name one GPU.`,
      );
    }
    return { gpuType: type, gpuCount: count, ...floor, ...region };
  }
  if (size) return { gpuCount: 1, ...floor, ...region };
  return { gpuType: machine, gpuCount: 1, ...floor, ...region };
}

/** Spellings Vast may store a GPU under: as written, with `_` for spaces and back. */
export function gpuNameVariants(type: string): string[] {
  const t = type.trim();
  const forms = [t, t.replace(/_/g, " "), t.replace(/\s+/g, "_")];
  return [...new Set([...forms, ...forms.map((f) => f.toUpperCase())])];
}

type OfferQuery = ApiBody<operations["searchOffers"]>;

export function offerQuery(needs: OfferNeeds, gpuNames?: string[]): OfferQuery {
  return {
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    external: { eq: false },
    type: "ondemand",
    num_gpus: { in: [needs.gpuCount] },
    ...(gpuNames ? { gpu_name: { in: gpuNames } } : {}),
    order: [["dph_total", "asc"]],
    limit: gpuNames || !needs.gpuType ? 64 : 1000,
  };
}

/** Whether an offer fits, beyond what the search filtered on. */
export function offerFits(offer: VOffer, needs: OfferNeeds): boolean {
  if (typeof offer.id !== "number") return false;
  if (needs.gpuType && !ciGpuMatches(needs.gpuType, offer.gpu_name ?? "")) return false;
  if ((offer.disk_space ?? 0) < CI_DISK_GB) return false;
  if ((offer.cpu_cores_effective ?? 0) < needs.vcpus) return false;
  if ((offer.cpu_ram ?? 0) < needs.memoryGb * 1000) return false;
  if (needs.region) {
    const where = (offer.geolocation ?? "").toLowerCase();
    if (!where.split(/[\s,]+/).includes(needs.region.toLowerCase())) return false;
  }
  return true;
}

async function search(api: VastApi, body: OfferQuery): Promise<VOffer[]> {
  const res: { offers?: VOffer[] | VOffer } = await api.post("/api/v0/bundles/", { body });
  const offers = res?.offers;
  return Array.isArray(offers) ? offers : offers ? [offers] : [];
}

/**
 * Offers that fit, cheapest first: by the GPU's name as written, then (when
 * Vast spells it differently) from the cheapest thousand with that many GPUs.
 */
export async function findOffers(api: VastApi, needs: OfferNeeds): Promise<VOffer[]> {
  const fit = (offers: VOffer[]) => offers.filter((o) => offerFits(o, needs));
  if (!needs.gpuType) return fit(await search(api, offerQuery(needs)));
  const named = fit(await search(api, offerQuery(needs, gpuNameVariants(needs.gpuType))));
  if (named.length > 0) return named;
  return fit(await search(api, offerQuery(needs)));
}

/** The rent body for a job. */
export function rentBody(spec: CiStartSpec): ApiBody<operations["createInstance"]> {
  return {
    client_id: "me",
    image: spec.image ?? CI_DEFAULT_IMAGE,
    runtype: "args",
    args: instanceArgs(spec.bootstrap, spec.maxSeconds),
    env: { [TAGS_ENV]: encodeTags(spec.tags) },
    label: ciMachineName(spec),
    disk: CI_DISK_GB,
    target_state: "running",
    cancel_unavail: true,
  };
}

function handleOf(id: number | string, offer?: VOffer): CiHandle {
  const where = offer?.geolocation;
  return {
    id: String(id),
    ...(where ? { region: where } : {}),
    label: `vast.ai instance ${id}${offer?.gpu_name ? ` (${offer.num_gpus ?? 1}x ${offer.gpu_name})` : ""}`,
  };
}

async function listInstances(api: VastApi, label?: string): Promise<VInstance[]> {
  return api.getAll("/api/v1/instances/", "instances", {
    pageSize: 25,
    ...(label ? { query: { select_filters: JSON.stringify({ label: { eq: label } }) } } : {}),
  });
}

function denied(err: unknown): boolean {
  const status = ciHttpStatus(err);
  return status === 401 || status === 403;
}

function isGone(err: unknown): boolean {
  if (ciHttpStatus(err) === 404) return true;
  const body = (err as { body?: unknown } | null)?.body;
  return typeof body === "string" && /not[_ ]found|no_such_instance/i.test(body);
}

export async function vastCiPreflight(
  api: VastApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireContainer(kind);
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  // A key cannot say what it may do: a read, and a destroy of an instance
  // that does not exist, which a key without instance_write refuses first.
  try {
    await api.get("/api/v1/instances/", { query: { limit: 1 } });
  } catch (err) {
    if (denied(err)) missing.push(CI_PERMISSIONS.read);
    else problems.push(`Vast.ai refused a read: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await api.delete(`/api/v0/instances/${pathEncode(0)}/`);
  } catch (err) {
    if (denied(err)) missing.push(CI_PERMISSIONS.write);
  }
  try {
    const user = await api.get("/api/v0/users/current/");
    const credit = (user as { credit?: unknown } | undefined)?.credit;
    if (typeof credit === "number" && credit <= 0) {
      problems.push(
        "This Vast.ai account has no credit, and Vast stops instances at zero. Add credit on the Billing page.",
      );
    }
  } catch {
    // A key without user_read cannot see its credit: no reason to refuse.
  }
  return {
    ok: missing.length === 0 && problems.length === 0,
    missing,
    problems,
    ...(region ? { region } : {}),
  };
}

export async function vastCiStart(api: VastApi, spec: CiStartSpec): Promise<CiHandle> {
  requireContainer(spec.kind);
  const name = ciMachineName(spec);
  // Renting has no idempotency key, so a start first looks for the instance
  // a lost answer left behind, by its label and the job's tag.
  const job = spec.tags[CI_JOB_TAG];
  const found = (await listInstances(api, name)).find(
    (i) =>
      i.label === name &&
      typeof i.id === "number" &&
      (job === undefined || tagsOfInstance(i)?.[CI_JOB_TAG] === job),
  );
  if (found?.id !== undefined) return handleOf(found.id);
  const needs = offerNeeds(spec);
  const offers = await findOffers(api, needs);
  if (offers.length === 0) {
    const gpu = needs.gpuType ? `${needs.gpuCount}x ${needs.gpuType}` : `${needs.gpuCount} GPU`;
    throw new Error(
      `Vast.ai has no verified on-demand offer with ${gpu}, ${needs.vcpus} vCPUs, ${needs.memoryGb} GB of memory and ${CI_DISK_GB} GB of disk${needs.region ? ` in ${needs.region}` : ""} right now.`,
    );
  }
  const body = rentBody(spec);
  let last: unknown;
  for (const offer of offers.slice(0, MAX_RENT_TRIES)) {
    try {
      const res = await api.put(`/api/v0/asks/${pathEncode(offer.id!)}/`, { body });
      const id = res?.new_contract;
      if (!id) throw new Error("Vast.ai accepted the offer but gave no instance id");
      return handleOf(id, offer);
    } catch (err) {
      // Someone else may have rented it since the search: try the next.
      if (denied(err)) throw err;
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function vastCiStatus(api: VastApi, handle: CiHandle): Promise<CiComputeStatus> {
  let instance: VInstance | undefined;
  try {
    const res = await api.get(`/api/v0/instances/${pathEncode(handle.id)}/`);
    instance = res?.instances;
  } catch (err) {
    if (isGone(err)) return { state: "gone" };
    throw err;
  }
  if (!instance || typeof instance !== "object" || instance.id === undefined) {
    return { state: "gone" };
  }
  const actual = instance.actual_status ?? null;
  const detail = instance.status_msg ?? actual ?? "provisioning";
  if (actual === "running") return { state: "running", detail };
  if (actual === "exited" || actual === "stopped" || instance.intended_status === "stopped") {
    return { state: "stopped", detail };
  }
  // `offline` and `unknown` mean Vast has lost the host's heartbeat, not that the job ended.
  if (actual === "offline" || actual === "unknown") return { state: "running", detail };
  return { state: "starting", detail };
}

export async function vastCiTeardown(api: VastApi, handle: CiHandle): Promise<void> {
  try {
    await api.delete(`/api/v0/instances/${pathEncode(handle.id)}/`);
  } catch (err) {
    if (isGone(err)) return;
    throw err;
  }
}

/** Every instance whose kept tags carry `tagKey`. Instances are account-wide. */
export async function vastCiListTagged(api: VastApi, tagKey: string): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const instance of await listInstances(api)) {
    if (instance.id === undefined || !instance.label?.startsWith("iwci-")) continue;
    const tags = tagsOfInstance(instance);
    if (!tags || !(tagKey in tags)) continue;
    const actual = instance.actual_status ?? null;
    out.push({
      handle: handleOf(instance.id),
      tags,
      ...(instance.start_date
        ? { createdAt: new Date(instance.start_date * 1000).toISOString() }
        : {}),
      live: instance.intended_status !== "stopped" && actual !== "exited" && actual !== "stopped",
    });
  }
  return out;
}
