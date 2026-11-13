/**
 * CI jobs on IBM Cloud Virtual Servers for VPC: one fresh instance per job
 * on the CI network (`ci-shared.ts`), started with the host's bootstrap as
 * its cloud-init user data and deleted (boot volume and network attachment
 * with it) when the job ends.
 *
 * **Wire shapes verified against the VPC OpenAPI document (version
 * 2026-09-24) and the VPC docs, November 2026** (paths typed by plugingen):
 * - `POST /instances` (`InstancePrototypeInstanceByImage`): `name` (at most
 *   63 of `[a-z][-a-z0-9]*`, unique in the region: a second answers 409, and
 *   that is the only idempotency there is), `profile.name`, `zone.name`,
 *   `vpc.id`, `image.id`, `user_data` (at most 65,535, cloud-init images),
 *   `boot_volume_attachment.{delete_volume_on_instance_delete (default
 *   true), volume.{name, profile.name, user_tags}}`,
 *   `primary_network_attachment.virtual_network_interface.{subnet,
 *   security_groups, auto_delete (default true)}`, `metadata_service.enabled`
 *   (default false). No `default_trusted_profile`, so no trusted profile.
 *   The instance prototype takes no tags: they are attached by CRN after.
 * - `GET /instances` (`name`, `vpc.id`, `limit`, `next.href`), `GET`
 *   and `DELETE /instances/{id}`; `status` pending, starting, running,
 *   restarting, stopping, stopped, deleting, failed. Deleting an instance
 *   deletes its boot volume and its auto-delete network interface; it
 *   would leave a floating IP, but the CI network gives none.
 * - `GET /images?visibility=public&status=available`: Ubuntu 24.04 is the
 *   newest image whose `operating_system.name` is `ubuntu-24-04-amd64`.
 *
 * VPC has no run-time limit for a standard instance, so the user data
 * starts a `shutdown` timer before the job and powers the instance off when
 * it ends; the host's teardown and its reaper delete it. Instances are
 * billed per second with no minimum.
 */
import {
  ciComputeKey,
  pathEncode,
  type CiComputeStatus,
  type CiHandle,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { VPC_QUERY } from "./regions.js";
import {
  attachTags,
  ensureNetwork,
  errorText,
  findCiVpc,
  fromIbmTags,
  ibmTags,
  statusOf,
  tagsOn,
  type IbmCiContext,
} from "./ci-shared.js";

export const VSI_DEFAULT_MACHINE = "bx2-2x8";
export const VSI_DEFAULT_IMAGE = "Ubuntu 24.04";
const UBUNTU_OS = "ubuntu-24-04-amd64";
const USER_DATA_MAX = 65_535;

export function instanceName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/** The user data: a shutdown timer, the host's bootstrap, then power off. */
export function userData(bootstrap: string, maxSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(maxSeconds / 60));
  const body = bootstrap.replace(/^#![^\n]*\n/, "");
  return [
    "#!/bin/bash",
    `shutdown -h +${minutes} >/dev/null 2>&1 || true`,
    "(",
    body,
    ")",
    "shutdown -h now",
    "",
  ].join("\n");
}

interface Image {
  id: string;
  name?: string;
  created_at?: string;
  operating_system?: { name?: string };
}

/** The image for a job: an image id (`r006-...`), an image name, or Ubuntu 24.04. */
export async function imageFor(
  ctx: IbmCiContext,
  region: string,
  image: string | undefined,
): Promise<string> {
  const vpc = ctx.api.vpc(region);
  if (image && image !== VSI_DEFAULT_IMAGE) {
    if (/^r\d{3}-[0-9a-f-]{36}$/.test(image)) return image;
    const named = await vpc.get("/images", { query: { ...VPC_QUERY, name: image } });
    const hit = named.images?.[0];
    if (!hit) throw new Error(`There is no image named ${image} in ${region}.`);
    return hit.id;
  }
  let page = await vpc.get("/images", {
    query: { ...VPC_QUERY, visibility: "public", status: ["available"], limit: 100 },
  });
  const ubuntu: Image[] = [];
  for (let i = 0; i < 50; i++) {
    ubuntu.push(...(page.images ?? []).filter((im) => im.operating_system?.name === UBUNTU_OS));
    if (!page.next?.href) break;
    page = await ctx.api.followLink<typeof page>(page.next.href);
  }
  const newest = ubuntu.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
  if (!newest) throw new Error(`There is no public Ubuntu 24.04 image in ${region}.`);
  return newest.id;
}

/** The instance prototype for a job. */
export function instanceBody(
  spec: CiStartSpec,
  network: { vpcId: string; zone: string; subnetId: string; securityGroupId: string },
  imageId: string,
) {
  const data = userData(spec.bootstrap, spec.maxSeconds);
  if (data.length > USER_DATA_MAX) {
    throw new Error(
      `The job's start script is ${data.length} characters as user data; IBM Cloud takes at most ${USER_DATA_MAX}.`,
    );
  }
  const name = instanceName(spec);
  return {
    name,
    profile: { name: spec.machine ?? VSI_DEFAULT_MACHINE },
    zone: { name: network.zone },
    vpc: { id: network.vpcId },
    image: { id: imageId },
    user_data: data,
    boot_volume_attachment: {
      delete_volume_on_instance_delete: true,
      volume: {
        name: `${name}-boot`,
        profile: { name: "general-purpose" },
        user_tags: ibmTags(spec.tags),
      },
    },
    primary_network_attachment: {
      name: "eth0",
      virtual_network_interface: {
        subnet: { id: network.subnetId },
        security_groups: [{ id: network.securityGroupId }],
        auto_delete: true,
      },
    },
    // Off by default; said out loud: no metadata service, no trusted profile.
    metadata_service: { enabled: false },
  };
}

function handleOf(id: string, region: string): CiHandle {
  return { id, region, label: `ibm vsi ${id} (${region})`, data: { kind: "vm" } };
}

async function byName(
  ctx: IbmCiContext,
  region: string,
  name: string,
): Promise<{ id: string; crn?: string } | undefined> {
  const res = await ctx.api.vpc(region).get("/instances", { query: { ...VPC_QUERY, name } });
  return res.instances?.[0];
}

export async function vsiStart(
  ctx: IbmCiContext,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  if (spec.gpu && !/^gx/.test(spec.machine ?? "")) {
    throw new Error(
      "On IBM Cloud a GPU comes with the profile: name a GPU profile in `cloud.machine`, e.g. gx3-16x80x1l4.",
    );
  }
  const name = instanceName(spec);
  // A start retried after a lost answer finds the instance the first made.
  const before = await byName(ctx, region, name);
  if (before) return handleOf(before.id, region);
  const [network, imageId] = await Promise.all([
    ensureNetwork(ctx, region),
    imageFor(ctx, region, spec.image),
  ]);
  const vpc = ctx.api.vpc(region);
  let instance: { id: string; crn?: string };
  try {
    instance = await vpc.post("/instances", {
      query: VPC_QUERY,
      body: instanceBody(spec, network, imageId),
    });
  } catch (err) {
    if (statusOf(err) !== 409) throw err;
    const made = await byName(ctx, region, name);
    if (!made) throw err;
    return handleOf(made.id, region);
  }
  // Tags go on by CRN. An instance the reaper could not find is not left
  // behind: without its tags it is deleted again, and the start fails.
  try {
    if (!instance.crn) throw new Error("IBM Cloud gave the instance no CRN to tag.");
    await attachTags(ctx, instance.crn, ibmTags(spec.tags));
  } catch (err) {
    await vpc
      .delete(`/instances/${pathEncode(instance.id)}`, { query: VPC_QUERY })
      .catch(() => undefined);
    throw new Error(
      `IBM Cloud could not tag the job's instance, so it was deleted: ${errorText(err)}`,
    );
  }
  return handleOf(instance.id, region);
}

export async function vsiStatus(ctx: IbmCiContext, handle: CiHandle): Promise<CiComputeStatus> {
  let instance: { status?: string; status_reasons?: Array<{ message?: string }> };
  try {
    instance = await ctx.api
      .vpc(handle.region ?? ctx.homeRegion)
      .get(`/instances/${pathEncode(handle.id)}`, { query: VPC_QUERY });
  } catch (err) {
    if (statusOf(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = instance.status ?? "";
  const state: CiComputeStatus["state"] =
    status === "pending" || status === "starting"
      ? "starting"
      : status === "running" || status === "restarting"
        ? "running"
        : "stopped";
  const reason = instance.status_reasons?.[0]?.message;
  return { state, detail: reason ? `${status}: ${reason}` : status };
}

export async function vsiTeardown(ctx: IbmCiContext, handle: CiHandle): Promise<void> {
  try {
    await ctx.api
      .vpc(handle.region ?? ctx.homeRegion)
      .delete(`/instances/${pathEncode(handle.id)}`, { query: VPC_QUERY });
  } catch (err) {
    if (statusOf(err) === 404) return;
    throw err;
  }
}

export async function vsiListTagged(
  ctx: IbmCiContext,
  tagKey: string,
  region: string,
): Promise<CiTaggedCompute[]> {
  // Jobs only ever start on the CI network, so its VPC is all there is to read.
  const ciVpc = await findCiVpc(ctx, region);
  if (!ciVpc) return [];
  const out: CiTaggedCompute[] = [];
  let page = await ctx.api
    .vpc(region)
    .get("/instances", { query: { ...VPC_QUERY, "vpc.id": ciVpc.id, limit: 100 } });
  for (let i = 0; i < 100; i++) {
    for (const instance of page.instances ?? []) {
      if (!instance.name?.startsWith("iwci-") || !instance.crn) continue;
      const tags = fromIbmTags(await tagsOn(ctx, instance.crn));
      if (!(tagKey in tags)) continue;
      const status = instance.status ?? "";
      out.push({
        handle: handleOf(instance.id, region),
        tags,
        ...(instance.created_at ? { createdAt: instance.created_at } : {}),
        live: status === "pending" || status === "starting" || status === "running",
      });
    }
    if (!page.next?.href) break;
    page = await ctx.api.followLink<typeof page>(page.next.href);
  }
  return out;
}
