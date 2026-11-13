/**
 * CI jobs on OpenStack: one fresh Nova server per job, booted from an
 * Ubuntu 24.04 image with the host's bootstrap as its cloud-init user data,
 * and deleted (with its root disk) when the job ends.
 *
 * **Wire shapes verified against the OpenStack API references (Compute
 * v2.1, Identity v3, Image v2, Networking v2.0) and Nova's default policy,
 * November 2026:**
 * - `POST /servers` `{server: {...}}`: `name`, `flavorRef`, `imageRef`,
 *   `user_data` (base64, at most 65535 bytes), `metadata` (keys and values at
 *   most 255 bytes), `networks` (required from microversion 2.37: a list of
 *   `{uuid}`, or `"auto"`), `block_device_mapping_v2` for a flavor with no
 *   local disk (`delete_on_termination` defaults to false, so it is set).
 *   `key_name` is optional and left out; the `adminPass` answered is never
 *   kept.
 * - `GET /servers/detail?name=<regex>` (non-admin filters: `name`, `status`,
 *   `tags` from 2.26; there is no metadata filter), paged by
 *   `limit`/`marker`; `GET`/`DELETE /servers/{id}` (`404` once gone).
 *   `status` is `ACTIVE`, `BUILD`, `SHUTOFF`, `ERROR`, `DELETED`,
 *   `SOFT_DELETED`, `PAUSED`, `SUSPENDED`, `SHELVED`, `SHELVED_OFFLOADED`,
 *   `REBOOT`, `HARD_REBOOT`, `REBUILD`, `RESIZE`, `VERIFY_RESIZE`,
 *   `MIGRATING`, `RESCUE`, `PASSWORD` or `UNKNOWN`.
 * - `GET /v3/auth/tokens` with `X-Subject-Token` answers the token's own
 *   `roles`. Nova's default policy lets `member` (or `admin`) create and
 *   delete servers and `reader` only read them; there is no API to evaluate
 *   a cloud's own policy, so the check reads the roles and says what the
 *   default policy needs.
 *
 * The job's tags ride in the server's metadata, which keeps them as sent;
 * leftovers are found by the `iwci-` name every CI server has, then by
 * metadata.
 *
 * **No credentials on the machine.** The server gets user data and nothing
 * else: no key pair, no application credential, no token.
 *
 * **Backstop.** The user data powers the server off at the job's deadline.
 * Whether a stopped server is still billed depends on the cloud; the
 * machine holds nothing that could delete itself, so billing stops only
 * when the host tears it down or its reaper finds it.
 */
import {
  ciCloudInitScript,
  ciHttpStatus,
  ciMachineName,
  utf8ToBase64,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import type { OpenStackApi } from "./api.js";

export const CI_DEFAULT_IMAGE = "Ubuntu 24.04";
const ROOT_VOLUME_GIB = 20;
/** The smallest flavor picked when the pipeline names none. */
const MIN_VCPUS = 2;
const MIN_RAM_MB = 4096;

export const OPENSTACK_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Nova server",
      // No default flavor: flavor names are each cloud's own. Without one
      // the smallest with 2 vCPUs and 4 GiB is picked.
      defaults: { image: CI_DEFAULT_IMAGE },
      typicalStartSeconds: 90,
    },
  ],
  helpLink: {
    label: "Give the credential the member role on the project",
    url: "https://docs.openstack.org/keystone/latest/admin/service-api-protection.html",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  member: {
    permission: "member",
    label: "Create and delete servers (Nova's default policy needs the member role)",
  },
} as const satisfies Record<string, CiMissingPermission>;

/** Only CI servers have this name prefix; the list filter is a regex. */
const NAME_FILTER = "^iwci-";

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`OpenStack runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

type Obj = Record<string, unknown>;

interface Flavor {
  id: string;
  name?: string;
  vcpus?: number;
  ram?: number;
  disk?: number;
}

interface Server {
  id?: string;
  name?: string;
  status?: string;
  created?: string;
  metadata?: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** The token's role names, from Keystone's own view of it. */
export async function tokenRoles(api: OpenStackApi): Promise<string[]> {
  const { token } = await api.token();
  const res = await api.raw("GET", `${api.authUrl}/auth/tokens`, {
    "X-Auth-Token": token,
    "X-Subject-Token": token,
    Accept: "application/json",
  });
  if (res.status < 200 || res.status >= 300) {
    throw Object.assign(new Error(`Keystone answered ${res.status} for the token`), {
      status: res.status,
    });
  }
  const parsed = JSON.parse(res.body) as { token?: { roles?: Array<{ name?: string }> } };
  return (parsed.token?.roles ?? []).flatMap((r) => (r.name ? [r.name.toLowerCase()] : []));
}

/** The image for `image`: an id, else an exact name, else a public image that reads as Ubuntu 24.04. */
async function imageFor(api: OpenStackApi, image: string): Promise<string | undefined> {
  if (UUID.test(image)) return image;
  const images = await api.paginate<Obj>(
    "image",
    "/v2/images",
    "images",
    { status: "active" },
    {
      limit: 200,
    },
  );
  const name = (i: Obj) => (typeof i["name"] === "string" ? i["name"] : "");
  const exact = images.find((i) => name(i) === image);
  if (exact) return String(exact["id"]);
  if (image !== CI_DEFAULT_IMAGE) return undefined;
  const ubuntu = images.find(
    (i) =>
      (i["os_distro"] === "ubuntu" && String(i["os_version"] ?? "").startsWith("24.04")) ||
      (/ubuntu[\s_-]*24\.04/i.test(name(i)) && !/minimal|gpu|docker/i.test(name(i))),
  );
  return ubuntu ? String(ubuntu["id"]) : undefined;
}

/** The flavor for `machine` (a name or id), or the smallest with 2 vCPUs and 4 GiB. */
async function flavorFor(
  api: OpenStackApi,
  machine: string | undefined,
): Promise<Flavor | undefined> {
  const flavors = (await api.paginate<Obj>(
    "compute",
    "/flavors/detail",
    "flavors",
    {},
    {
      limit: 1000,
    },
  )) as unknown as Flavor[];
  if (machine) return flavors.find((f) => f.id === machine || f.name === machine);
  return flavors
    .filter((f) => (f.vcpus ?? 0) >= MIN_VCPUS && (f.ram ?? 0) >= MIN_RAM_MB)
    .sort((a, b) => (a.vcpus ?? 0) - (b.vcpus ?? 0) || (a.ram ?? 0) - (b.ram ?? 0))[0];
}

/**
 * The network a server joins: the project's one network if it has one, else
 * the one shared external network clouds attach servers to directly, else
 * Nova's auto-allocated topology. Several candidates are ambiguous: a job
 * cannot name a network yet.
 */
async function networksFor(api: OpenStackApi): Promise<Array<{ uuid: string }> | "auto"> {
  if (!(await api.hasService("network"))) return "auto";
  const networks = await api.paginate<Obj>("network", "/v2.0/networks", "networks", {
    status: "ACTIVE",
  });
  const { projectId } = await api.token();
  const external = (n: Obj) => n["router:external"] === true;
  const own = networks.filter((n) => !external(n) && n["project_id"] === projectId);
  const shared = networks.filter((n) => !external(n) && n["shared"] === true);
  const publicNets = networks.filter((n) => external(n) && n["shared"] === true);
  for (const candidates of [own, shared, publicNets]) {
    if (candidates.length === 1) return [{ uuid: String(candidates[0]?.["id"]) }];
    if (candidates.length > 1) {
      const names = candidates.map((n) => String(n["name"] ?? n["id"])).join(", ");
      throw new Error(
        `The project has several networks a CI server could join (${names}), and a job cannot name one yet.`,
      );
    }
  }
  return "auto";
}

export async function openstackCiPreflight(
  api: OpenStackApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  const say = (err: unknown) => (err instanceof Error ? err.message : String(err));
  try {
    const roles = await tokenRoles(api);
    const writes = roles.some((r) => r === "member" || r === "_member_" || r === "admin");
    // Only a token that is plainly read-only is refused: a cloud with roles
    // of its own may grant more than their names say.
    if (!writes && roles.length > 0 && roles.every((r) => r === "reader")) {
      missing.push(CI_PERMISSIONS.member);
    }
  } catch {
    // Keystone would not describe the token: the reads below decide.
  }
  try {
    await api.get("compute", "/servers", { limit: 1 });
  } catch (err) {
    problems.push(`OpenStack refused a list of servers: ${say(err)}`);
  }
  try {
    if (!(await imageFor(api, CI_DEFAULT_IMAGE))) {
      problems.push(
        `There is no active Ubuntu 24.04 image in this project. Name one in \`cloud.image\`.`,
      );
    }
  } catch (err) {
    problems.push(`OpenStack refused a list of images: ${say(err)}`);
  }
  try {
    if (!(await flavorFor(api, undefined))) {
      problems.push("No flavor has 2 vCPUs and 4 GiB of memory; name one in `cloud.machine`.");
    }
  } catch {
    // The start says so.
  }
  try {
    await networksFor(api);
  } catch (err) {
    problems.push(say(err));
  }
  return {
    ok: missing.length === 0 && problems.length === 0,
    missing,
    problems,
    ...((region ?? api.region) ? { region: region ?? api.region } : {}),
  };
}

/** Metadata keys and values are at most 255 bytes. */
function metadataOf(tags: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) out[key.slice(0, 255)] = value.slice(0, 255);
  return out;
}

function tagsOf(metadata: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (key.startsWith("infrawrench-ci")) out[key] = value;
  }
  return out;
}

/** The create body for a job. */
export function serverBody(
  spec: CiStartSpec,
  flavor: Flavor,
  image: string,
  networks: Array<{ uuid: string }> | "auto",
) {
  const local = (flavor.disk ?? 0) > 0;
  return {
    server: {
      name: ciMachineName(spec),
      flavorRef: flavor.id,
      ...(local
        ? { imageRef: image }
        : {
            // A flavor with no local disk boots from a volume, which goes
            // with the server only when told to.
            block_device_mapping_v2: [
              {
                boot_index: 0,
                uuid: image,
                source_type: "image",
                destination_type: "volume",
                volume_size: ROOT_VOLUME_GIB,
                delete_on_termination: true,
              },
            ],
          }),
      user_data: utf8ToBase64(ciCloudInitScript(spec.bootstrap, spec.maxSeconds)),
      metadata: metadataOf(spec.tags),
      networks,
    },
  };
}

function handleOf(id: string, region: string): CiHandle {
  return {
    id,
    ...(region ? { region } : {}),
    label: `openstack server ${id}${region ? ` (${region})` : ""}`,
  };
}

async function serversNamed(api: OpenStackApi, name: string): Promise<Server[]> {
  return (await api.paginate<Obj>("compute", "/servers/detail", "servers", {
    name,
  })) as unknown as Server[];
}

export async function openstackCiStart(api: OpenStackApi, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu) {
    throw new Error(
      "On OpenStack a GPU comes with the flavor: name a GPU flavor in `cloud.machine` and leave `cloud.gpu` out.",
    );
  }
  if (spec.region && api.region && spec.region !== api.region) {
    throw new Error(
      `This OpenStack connection works in ${api.region}; a job cannot move it to ${spec.region}.`,
    );
  }
  const name = ciMachineName(spec);
  // The name is the job's: a retry finds the server the first start made.
  const found = (await serversNamed(api, `^${name}$`)).find(
    (s) => s.name === name && s.status !== "DELETED" && s.status !== "SOFT_DELETED",
  );
  if (found?.id) return handleOf(found.id, api.region);
  const flavor = await flavorFor(api, spec.machine);
  if (!flavor) {
    throw new Error(
      spec.machine
        ? `OpenStack has no flavor \`${spec.machine}\` in this project.`
        : "No flavor has 2 vCPUs and 4 GiB of memory; name one in `cloud.machine`.",
    );
  }
  const imageName = spec.image ?? CI_DEFAULT_IMAGE;
  const image = await imageFor(api, imageName);
  if (!image) throw new Error(`OpenStack has no active image \`${imageName}\` in this project.`);
  const networks = await networksFor(api);
  const { server } = await api.json<{ server?: Server }>("compute", "POST", "/servers", {
    body: serverBody(spec, flavor, image, networks),
  });
  if (!server?.id) throw new Error("Nova started no server");
  return handleOf(server.id, api.region);
}

export async function openstackCiStatus(
  api: OpenStackApi,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  let server: Server | undefined;
  try {
    ({ server } = await api.get<{ server?: Server }>(
      "compute",
      `/servers/${encodeURIComponent(handle.id)}`,
    ));
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = (server?.status ?? "").toUpperCase();
  const state: CiComputeStatus["state"] = !server
    ? "gone"
    : status === "BUILD"
      ? "starting"
      : status === "DELETED" || status === "SOFT_DELETED"
        ? "gone"
        : status === "ACTIVE" ||
            status === "REBOOT" ||
            status === "HARD_REBOOT" ||
            status === "MIGRATING" ||
            status === "PASSWORD"
          ? "running"
          : "stopped";
  return { state, detail: status };
}

export async function openstackCiTeardown(api: OpenStackApi, handle: CiHandle): Promise<void> {
  try {
    await api.request("compute", "DELETE", `/servers/${encodeURIComponent(handle.id)}`);
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

/**
 * Every CI server in the connection's project and region carrying `tagKey`.
 * A connection works in one region, so `regions` does not widen it.
 */
export async function openstackCiListTagged(
  api: OpenStackApi,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const server of await serversNamed(api, NAME_FILTER)) {
    if (!server.id || !server.metadata || !(tagKey in server.metadata)) continue;
    const status = (server.status ?? "").toUpperCase();
    if (status === "DELETED" || status === "SOFT_DELETED") continue;
    out.push({
      handle: handleOf(server.id, api.region),
      tags: tagsOf(server.metadata),
      ...(server.created ? { createdAt: server.created } : {}),
      live: status === "ACTIVE" || status === "BUILD",
    });
  }
  return out;
}
