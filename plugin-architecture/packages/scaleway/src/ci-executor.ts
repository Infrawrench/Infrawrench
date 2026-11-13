/**
 * CI jobs on Scaleway: `vm` is a fresh Instance per job (here), `container`
 * a Serverless Jobs run (`ci-jobs.ts`). Both go over the plain REST surface
 * (`https://api.scaleway.com`, `X-Auth-Token`), so tests drive them with a
 * fake and no SDK.
 *
 * **Instances, verified against Scaleway's Instance API v1 (its generated Go
 * SDK and CLI, the docs repository and the public catalog endpoints),
 * November 2026:**
 * - `POST /instance/v1/zones/{zone}/servers`: `name`, `commercial_type`,
 *   `image` (a UUID, from `GET /marketplace/v2/local-images?image_label=
 *   ubuntu_noble&zone=&type=instance_sbs`, matched on
 *   `compatible_commercial_types`), `project`, `tags`, `volumes` (a map keyed
 *   `"0"`; `sbs_volume` sizes in bytes), `dynamic_ip_required: true` (a
 *   dynamic address, released with the server; no flexible IP is made). The
 *   server is created stopped.
 * - `PATCH .../servers/{id}/user_data/cloud-init` (`text/plain`) before
 *   `POST .../servers/{id}/action` `{"action": "poweron"}`.
 * - `GET .../servers?name=&tags=&page=&per_page=` (`name` is a substring),
 *   `GET .../servers/{id}` (`404` once gone); `state` is `running`,
 *   `stopped`, `stopped in place`, `starting`, `stopping` or `locked`.
 * - `{"action": "terminate"}` deletes a running server and its local volumes
 *   but only detaches SBS volumes, and `DELETE .../servers/{id}` wants a
 *   stopped one; the root SBS volume is then `DELETE
 *   /block/v1/zones/{zone}/volumes/{id}`, once it is no longer `in_use`.
 * - IAM v1alpha1: `GET /iam/v1alpha1/api-keys/{access_key}` (`application_id`
 *   or `user_id`, `default_project_id`), `GET /iam/v1alpha1/policies?
 *   application_ids=`, `GET /iam/v1alpha1/rules?policy_id=`
 *   (`permission_set_names`). Reading them needs `IAMReadOnly`; without it,
 *   or for a user's key, the check falls back to harmless reads.
 * - Billing: CPU Instances by the hour of uptime; a powered-off server stops
 *   the compute bill, its volume is billed until deleted.
 *
 * **No credentials on the machine.** The server gets cloud-init user data
 * and nothing else. Scaleway also injects the project's SSH keys into every
 * Instance; their owners could log in, but no API key reaches it.
 *
 * **Backstop.** The user data powers the server off at the job's deadline,
 * which ends the compute bill; its volume is billed until the host tears it
 * down or its reaper finds it by tag. The machine holds nothing that could
 * delete itself.
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
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import {
  JOBS_DEFAULT_IMAGE,
  JOBS_DEFAULT_MACHINE,
  JOBS_DEFAULT_REGION,
  jobsListTagged,
  jobsPreflight,
  jobsStart,
  jobsStatus,
  jobsTeardown,
} from "./ci-jobs.js";
import { grantedSets, lacking, projectOf, type ScwCiContext } from "./ci-shared.js";
import { SCW_ZONES } from "./locations.js";

export const VM_DEFAULT_MACHINE = "PLAY2-NANO";
export const VM_DEFAULT_IMAGE = "ubuntu_noble";
export const VM_DEFAULT_REGION = "fr-par-1";
const ROOT_BYTES = 20_000_000_000;

export const SCALEWAY_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Instance",
      defaults: { machine: VM_DEFAULT_MACHINE, image: VM_DEFAULT_IMAGE, region: VM_DEFAULT_REGION },
      typicalStartSeconds: 60,
      // CPU Instances are billed by the hour of uptime.
      minimumBillingSeconds: 3600,
      machineSuggestions: [
        "PLAY2-NANO",
        "PLAY2-MICRO",
        "BASIC3-X2C-4G",
        "BASIC2-A2C-4G",
        "COMPUTE3-X2C-4G",
        "POP2-2C-8G",
        "PRO2-XXS",
        "DEV1-M",
      ],
    },
    {
      kind: "container",
      label: "Serverless Jobs run",
      defaults: {
        machine: JOBS_DEFAULT_MACHINE,
        image: JOBS_DEFAULT_IMAGE,
        region: JOBS_DEFAULT_REGION,
      },
      typicalStartSeconds: 30,
      machineSuggestions: ["1vcpu-2gb", "2vcpu-4gb", "4vcpu-8gb", "6vcpu-16gb"],
    },
  ],
  helpLink: {
    label: "Give the API key's application these permission sets",
    url: "https://console.scaleway.com/iam/applications",
  },
} as const satisfies CiExecutorDeclaration;

export const VM_PERMISSIONS = {
  instances: {
    permission: "InstancesFullAccess",
    label: "Create, follow and delete the job's Instance",
  },
  block: { permission: "BlockStorageFullAccess", label: "Delete its root volume afterwards" },
} as const satisfies Record<string, CiMissingPermission>;

function unsupported(kind: CiExecutorKind): Error {
  return new Error(`Scaleway runs CI jobs of kind \`vm\` and \`container\`, not \`${kind}\`.`);
}

async function vmPreflight(ctx: ScwCiContext, zone: string): Promise<CiPreflightResult> {
  const missing = lacking(await grantedSets(ctx), Object.values(VM_PERMISSIONS));
  const problems: string[] = [];
  try {
    await ctx.rest.fetch(`/instance/v1/zones/${zone}/servers?per_page=1`);
  } catch (err) {
    if (ciHttpStatus(err) === 403) {
      if (!missing.includes(VM_PERMISSIONS.instances)) missing.push(VM_PERMISSIONS.instances);
    } else {
      problems.push(`Scaleway refused a list of Instances in ${zone}: ${String(err)}`);
    }
  }
  try {
    await projectOf(ctx);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  try {
    if (!(await imageFor(ctx, zone, VM_DEFAULT_IMAGE, VM_DEFAULT_MACHINE))) {
      problems.push(`Scaleway offers no Ubuntu 24.04 image for ${VM_DEFAULT_MACHINE} in ${zone}.`);
    }
  } catch {
    // The start says so.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: zone };
}

interface Server {
  id?: string;
  name?: string;
  state?: string;
  zone?: string;
  tags?: string[];
  creation_date?: string;
  volumes?: Record<string, { id?: string; volume_type?: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The image UUID: the pipeline's, or the Marketplace's local image for the label that fits the type. */
async function imageFor(
  ctx: ScwCiContext,
  zone: string,
  image: string,
  machine: string,
): Promise<string | undefined> {
  if (UUID.test(image)) return image;
  const { local_images } = await ctx.rest.fetch<{
    local_images?: Array<{ id?: string; arch?: string; compatible_commercial_types?: string[] }>;
  }>(
    `/marketplace/v2/local-images?image_label=${encodeURIComponent(image)}&zone=${zone}&type=instance_sbs&page_size=100`,
  );
  const images = local_images ?? [];
  const fits = images.find((i) => i.compatible_commercial_types?.includes(machine));
  return (fits ?? images.find((i) => i.arch === "x86_64"))?.id;
}

function sbsVolumes(server: Server): string[] {
  return Object.values(server.volumes ?? {}).flatMap((v) =>
    v.id && v.volume_type === "sbs_volume" ? [v.id] : [],
  );
}

function vmHandle(server: Server, zone: string): CiHandle {
  const id = server.id ?? "";
  const volumes = sbsVolumes(server);
  return {
    id,
    region: zone,
    label: `scaleway instance ${id} (${zone})`,
    data: { kind: "vm", ...(volumes.length ? { volumes: volumes.join(",") } : {}) },
  };
}

/** The create body for a job, given the image's UUID and the project. */
export function serverBody(spec: CiStartSpec, image: string, project: string) {
  return {
    name: ciMachineName(spec),
    commercial_type: spec.machine ?? VM_DEFAULT_MACHINE,
    image,
    project,
    tags: ciTagStrings(spec.tags),
    dynamic_ip_required: true,
    boot_type: "local",
    volumes: { "0": { boot: true, volume_type: "sbs_volume", size: ROOT_BYTES } },
  };
}

async function serverIn(ctx: ScwCiContext, zone: string, id: string): Promise<Server | undefined> {
  try {
    const { server } = await ctx.rest.fetch<{ server?: Server }>(
      `/instance/v1/zones/${zone}/servers/${encodeURIComponent(id)}`,
    );
    return server;
  } catch (err) {
    if (ciHttpStatus(err) === 404) return undefined;
    throw err;
  }
}

/** Hand a stopped server its user data and power it on. */
async function boot(ctx: ScwCiContext, zone: string, id: string, spec: CiStartSpec): Promise<void> {
  const base = `/instance/v1/zones/${zone}/servers/${encodeURIComponent(id)}`;
  await ctx.rest.fetch(`${base}/user_data/cloud-init`, {
    method: "PATCH",
    headers: { "Content-Type": "text/plain" },
    body: ciCloudInitScript(spec.bootstrap, spec.maxSeconds),
  });
  await ctx.rest.fetch(`${base}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "poweron" }),
  });
}

async function vmStart(ctx: ScwCiContext, spec: CiStartSpec): Promise<CiHandle> {
  if (spec.gpu) {
    throw new Error(
      "On Scaleway a GPU comes with the Instance type: name a GPU type in `cloud.machine` and leave `cloud.gpu` out.",
    );
  }
  const zone = spec.region ?? VM_DEFAULT_REGION;
  const name = ciMachineName(spec);
  // The name is the job's: a retry finds the server the first start made,
  // and boots it if that start stopped before the power-on.
  const { servers } = await ctx.rest.fetch<{ servers?: Server[] }>(
    `/instance/v1/zones/${zone}/servers?name=${encodeURIComponent(name)}&per_page=100`,
  );
  const found = (servers ?? []).find((s) => s.name === name);
  if (found?.id) {
    if (found.state === "stopped") await boot(ctx, zone, found.id, spec);
    return vmHandle(found, zone);
  }
  const machine = spec.machine ?? VM_DEFAULT_MACHINE;
  const image = await imageFor(ctx, zone, spec.image ?? VM_DEFAULT_IMAGE, machine);
  if (!image) {
    throw new Error(
      `Scaleway has no image \`${spec.image ?? VM_DEFAULT_IMAGE}\` for ${machine} in ${zone}.`,
    );
  }
  const project = await projectOf(ctx);
  const { server } = await ctx.rest.fetch<{ server?: Server }>(
    `/instance/v1/zones/${zone}/servers`,
    {
      method: "POST",
      body: JSON.stringify(serverBody(spec, image, project)),
    },
  );
  if (!server?.id) throw new Error("Scaleway created no Instance");
  await boot(ctx, zone, server.id, spec);
  return vmHandle(server, zone);
}

async function vmStatus(ctx: ScwCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  const server = await serverIn(ctx, handle.region ?? VM_DEFAULT_REGION, handle.id);
  if (!server) return { state: "gone" };
  const status = server.state ?? "";
  const state: CiComputeStatus["state"] =
    status === "starting" ? "starting" : status === "running" ? "running" : "stopped";
  return { state, detail: status };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function vmTeardown(ctx: ScwCiContext, handle: CiHandle): Promise<void> {
  const zone = handle.region ?? VM_DEFAULT_REGION;
  const base = `/instance/v1/zones/${zone}/servers/${encodeURIComponent(handle.id)}`;
  let server = await serverIn(ctx, zone, handle.id);
  const volumes = new Set((handle.data?.["volumes"] ?? "").split(",").filter(Boolean));
  if (server) {
    for (const id of sbsVolumes(server)) volumes.add(id);
    try {
      if (server.state === "stopped") {
        await ctx.rest.fetch(base, { method: "DELETE" });
      } else if (server.state !== "stopping") {
        await ctx.rest.fetch(`${base}/action`, {
          method: "POST",
          body: JSON.stringify({ action: "terminate" }),
        });
      }
    } catch (err) {
      if (ciHttpStatus(err) !== 404) throw err;
    }
    // The root volume is only free once the server is gone.
    for (let attempt = 0; attempt < 12 && server; attempt++) {
      await (ctx.sleep ?? sleep)(5_000);
      server = await serverIn(ctx, zone, handle.id);
    }
    if (server) {
      throw new Error(
        `Scaleway Instance ${handle.id} is still ${server.state ?? "going"}; its volume goes once it has.`,
      );
    }
  }
  for (const id of volumes) {
    try {
      await ctx.rest.fetch(`/block/v1/zones/${zone}/volumes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch (err) {
      if (ciHttpStatus(err) !== 404) throw err;
    }
  }
}

async function vmListTagged(
  ctx: ScwCiContext,
  tagKey: string,
  zones: readonly string[],
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const zone of zones) {
    for (let page = 1; page <= 100; page++) {
      const { servers } = await ctx.rest.fetch<{ servers?: Server[] }>(
        `/instance/v1/zones/${zone}/servers?tags=${encodeURIComponent(ciTagMarker(tagKey))}&per_page=100&page=${page}`,
      );
      for (const server of servers ?? []) {
        const tags = ciTagsFromStrings(server.tags ?? []);
        if (!server.id || !(tagKey in tags)) continue;
        out.push({
          handle: vmHandle(server, zone),
          tags,
          ...(server.creation_date ? { createdAt: server.creation_date } : {}),
          live: server.state === "running" || server.state === "starting",
        });
      }
      if ((servers ?? []).length < 100) break;
    }
  }
  return out;
}

const isJob = (handle: CiHandle) => handle.data?.["kind"] === "container";

export async function scalewayCiPreflight(
  ctx: ScwCiContext,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  if (kind === "vm") return vmPreflight(ctx, region ?? VM_DEFAULT_REGION);
  if (kind === "container") return jobsPreflight(ctx, region ?? JOBS_DEFAULT_REGION);
  throw unsupported(kind);
}

export function scalewayCiStart(ctx: ScwCiContext, spec: CiStartSpec): Promise<CiHandle> {
  if (spec.kind === "vm") return vmStart(ctx, spec);
  if (spec.kind === "container") return jobsStart(ctx, spec);
  throw unsupported(spec.kind);
}

export function scalewayCiStatus(ctx: ScwCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  return isJob(handle) ? jobsStatus(ctx, handle) : vmStatus(ctx, handle);
}

export function scalewayCiTeardown(ctx: ScwCiContext, handle: CiHandle): Promise<void> {
  return isJob(handle) ? jobsTeardown(ctx, handle) : vmTeardown(ctx, handle);
}

/**
 * Everything tagged for CI: Instances in the zones of `regions` and job
 * definitions in their regions (every zone and region when empty). A kind
 * the key may not list hides nothing else.
 */
export async function scalewayCiListTagged(
  ctx: ScwCiContext,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const quiet = async (list: Promise<CiTaggedCompute[]>) => {
    try {
      return await list;
    } catch (err) {
      if (ciHttpStatus(err) === 403) return [];
      throw err;
    }
  };
  const zones =
    regions.length > 0
      ? [...new Set(regions)].filter((r) => SCW_ZONES.includes(r))
      : [...SCW_ZONES];
  const jobRegions =
    regions.length > 0
      ? [...new Set(regions.filter((r) => !SCW_ZONES.includes(r)))]
      : ["fr-par", "nl-ams", "pl-waw"];
  return [
    ...(await quiet(vmListTagged(ctx, tagKey, zones))),
    ...(await quiet(jobsListTagged(ctx, tagKey, jobRegions))),
  ];
}
