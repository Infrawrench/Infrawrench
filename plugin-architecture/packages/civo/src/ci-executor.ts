/**
 * CI jobs on Civo: one fresh compute instance per job, started with the
 * host's bootstrap as its user script and deleted when the job ends.
 *
 * **Wire shapes verified against Civo's API reference
 * (`civo.com/api/instances`), its docs repository and its CLI, November
 * 2026:**
 * - `POST /v2/instances` (region in the query and the body): `hostname`,
 *   `size`, `network_id` (the region's `default` network from `GET
 *   /v2/networks`), `template_id` (a disk image id, per region: `name ==
 *   "ubuntu-noble"` in `GET /v2/disk_images`), `public_ip: "create"`,
 *   `script` (plain text, run as root at the end of cloud-init), `tags` (one
 *   space-separated string; answered as an array). Without `ssh_key_id`
 *   Civo sets a random password and returns it, which is never read.
 * - `GET /v2/instances?region=&tags=` (`{page, pages, items}`), `GET` and
 *   `DELETE /v2/instances/{id}?region=` (`{"result":"success"}`). `status`
 *   is `BUILDING` or `ACTIVE` in the reference; the CLI also knows
 *   `SHUTOFF`, `REBOOTING`, `INSTANCE-CREATE`, `INSTALLING`, `STOPPING` and
 *   `MIGRATING`.
 * - Keys are per account with no scopes, so the preflight is a set of
 *   harmless reads: the instances, the default network, the image and the
 *   quota.
 * - Billing: by the hour, rounded up, and a stopped instance "is chargeable,
 *   and is exactly the same as an active instance".
 *
 * **No credentials on the machine.** The instance gets the script and
 * nothing else: no API key, no account SSH key.
 *
 * **Backstop.** The script powers the instance off at the job's deadline. A
 * stopped instance is still billed, and the machine holds nothing that
 * could delete it, so billing stops only when the host tears it down or its
 * reaper finds it by tag.
 */
import {
  ciCloudInitScript,
  ciHttpStatus,
  ciMachineName,
  ciTagMarker,
  ciTagStrings,
  ciTagsFromStrings,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import type { CivoApi } from "./api.js";
import type { CivoDiskImage, CivoInstance, CivoNetwork } from "./types.js";

export const CI_DEFAULT_MACHINE = "g4s.medium";
export const CI_DEFAULT_IMAGE = "ubuntu-noble";
export const CI_DEFAULT_REGION = "LON1";

export const CIVO_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Compute instance",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      typicalStartSeconds: 90,
      // Billed by the hour, rounded up.
      minimumBillingSeconds: 3600,
      machineSuggestions: ["g4s.small", "g4s.medium", "g4s.large", "g4s.xlarge", "g4s.2xlarge"],
    },
  ],
} as const satisfies CiExecutorDeclaration;

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`Civo runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

const regionOf = (region: string | undefined) => (region ?? CI_DEFAULT_REGION).toUpperCase();

async function defaultNetwork(api: CivoApi, region: string): Promise<CivoNetwork | undefined> {
  const networks = await api.list<CivoNetwork>("/networks", { region });
  return networks.find((n) => n.default);
}

/** The disk image for `image`: an id, or a name such as `ubuntu-noble`. */
async function diskImage(
  api: CivoApi,
  region: string,
  image: string,
): Promise<CivoDiskImage | undefined> {
  const images = await api.get<CivoDiskImage[] | null>("/disk_images", { region });
  return (images ?? []).find((i) => i.id === image || i.name === image);
}

export async function civoCiPreflight(
  api: CivoApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const where = regionOf(region);
  const problems: string[] = [];
  const say = (err: unknown) => (err instanceof Error ? err.message : String(err));
  try {
    await api.get("/instances", { region: where, per_page: 1 });
  } catch (err) {
    problems.push(`Civo refused a list of instances in ${where}: ${say(err)}`);
  }
  try {
    if (!(await defaultNetwork(api, where))) {
      problems.push(`There is no default network in ${where}, which a CI instance starts on.`);
    }
  } catch (err) {
    problems.push(`Civo refused a list of networks in ${where}: ${say(err)}`);
  }
  try {
    if (!(await diskImage(api, where, CI_DEFAULT_IMAGE))) {
      problems.push(`Civo offers no ${CI_DEFAULT_IMAGE} image in ${where}.`);
    }
  } catch {
    // The start says so.
  }
  try {
    const quota = await api.get<{ instance_count_usage?: number; instance_count_limit?: number }>(
      "/quota",
    );
    const { instance_count_usage: used, instance_count_limit: limit } = quota;
    if (typeof used === "number" && typeof limit === "number" && used >= limit) {
      problems.push(
        `The account is at its limit of ${limit} instances. Ask Civo for more, or remove some.`,
      );
    }
  } catch {
    // Not being able to look is no reason to refuse.
  }
  return { ok: problems.length === 0, missing: [], problems, region: where };
}

function handleOf(instance: Pick<CivoInstance, "id">, region: string): CiHandle {
  return { id: instance.id, region, label: `civo instance ${instance.id} (${region})` };
}

/** The create body for a job, given the region's network and image. */
export function instanceBody(spec: CiStartSpec, networkId: string, templateId: string) {
  return {
    hostname: ciMachineName(spec),
    size: spec.machine ?? CI_DEFAULT_MACHINE,
    template_id: templateId,
    network_id: networkId,
    count: 1,
    public_ip: "create",
    script: ciCloudInitScript(spec.bootstrap, spec.maxSeconds),
    tags: ciTagStrings(spec.tags).join(" "),
  };
}

export async function civoCiStart(api: CivoApi, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu) {
    throw new Error(
      "On Civo a GPU comes with the size: name a GPU size in `cloud.machine` and leave `cloud.gpu` out.",
    );
  }
  const region = regionOf(spec.region);
  const hostname = ciMachineName(spec);
  // The hostname is the job's: a retry finds the instance the first start made.
  const instances = await api.list<CivoInstance>("/instances", { region });
  const found = instances.find((i) => i.hostname === hostname);
  if (found) return handleOf(found, region);
  const network = await defaultNetwork(api, region);
  if (!network) throw new Error(`There is no default network in Civo ${region}.`);
  const image = await diskImage(api, region, spec.image ?? CI_DEFAULT_IMAGE);
  if (!image)
    throw new Error(`Civo has no disk image \`${spec.image ?? CI_DEFAULT_IMAGE}\` in ${region}.`);
  const created = await api.send<CivoInstance>(
    "POST",
    "/instances",
    region,
    instanceBody(spec, network.id, image.id),
  );
  if (!created.id) throw new Error("Civo started no instance");
  return handleOf(created, region);
}

export async function civoCiStatus(api: CivoApi, handle: CiHandle): Promise<CiComputeStatus> {
  let instance: CivoInstance;
  try {
    instance = await api.get<CivoInstance>(`/instances/${encodeURIComponent(handle.id)}`, {
      region: regionOf(handle.region),
    });
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = (instance.status ?? "").toUpperCase();
  const state: CiComputeStatus["state"] =
    status === "BUILDING" || status === "INSTANCE-CREATE" || status === "INSTALLING"
      ? "starting"
      : status === "SHUTOFF" || status === "STOPPING" || status === "STOPPED"
        ? "stopped"
        : "running";
  return { state, detail: status };
}

export async function civoCiTeardown(api: CivoApi, handle: CiHandle): Promise<void> {
  try {
    await api.send(
      "DELETE",
      `/instances/${encodeURIComponent(handle.id)}`,
      regionOf(handle.region),
    );
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

/** Every instance tagged for CI in `regions` (the default region when empty). */
export async function civoCiListTagged(
  api: CivoApi,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  const wanted = regions.length > 0 ? [...new Set(regions.map(regionOf))] : [CI_DEFAULT_REGION];
  for (const region of wanted) {
    const instances = await api.list<CivoInstance>("/instances", {
      region,
      tags: ciTagMarker(tagKey),
    });
    for (const instance of instances) {
      const tags = ciTagsFromStrings(instance.tags ?? []);
      if (!(tagKey in tags)) continue;
      const status = (instance.status ?? "").toUpperCase();
      out.push({
        handle: handleOf(instance, region),
        tags,
        ...(instance.created_at ? { createdAt: instance.created_at } : {}),
        live: status !== "SHUTOFF" && status !== "STOPPING" && status !== "STOPPED",
      });
    }
  }
  return out;
}
