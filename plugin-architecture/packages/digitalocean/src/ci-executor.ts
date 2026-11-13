/**
 * CI jobs on DigitalOcean: one fresh Droplet per job, started with the
 * host's bootstrap as its user data and destroyed when the job ends.
 *
 * **Wire shapes verified against DigitalOcean's OpenAPI document (the one
 * `plugingen.json` names) and docs, November 2026:**
 * - `POST /v2/droplets` (`droplet_single_create`): `name`, `region`, `size`,
 *   `image` (a slug, `ubuntu-24-04-x64`), `ssh_keys` (ids or fingerprints of
 *   keys already on the team), `user_data` (plain text, at most 64 KiB, a
 *   cloud-config file or a shell script), `tags` (created if new, needs
 *   `tag:create`), `monitoring`, `with_droplet_agent: false` to skip the
 *   console agent, `ipv6`, `backups`.
 * - `GET /v2/droplets?tag_name=` (exact tag, needs `tag:read`), `GET`/`DELETE
 *   /v2/droplets/{id}`; `status` is `new`, `active`, `off` or `archive`.
 * - `POST /v2/account/keys` `{name, public_key}`, `DELETE
 *   /v2/account/keys/{id}`; `POST /v2/tags`, `GET`/`DELETE /v2/tags/{name}`
 *   (`resources.count`). Tag names are `[a-zA-Z0-9_\-:]`, at most 255.
 * - Scopes: `droplet:create` (with its required read scopes), `droplet:read`,
 *   `droplet:delete`, `tag:create`, `tag:read`, `tag:delete`,
 *   `ssh_key:create`, `ssh_key:read`, `ssh_key:delete`. A token lacking one
 *   answers `403 forbidden`.
 * - Billing: per second at the hourly rate, at least 60 seconds or $0.01;
 *   a powered-off Droplet is billed until it is destroyed.
 *
 * **No credentials on the machine.** The Droplet gets user data and nothing
 * else: no token, and no team SSH key. DigitalOcean emails a root password
 * for every Droplet started without an SSH key, so a start adds a throwaway
 * public key (its private half is never kept), names it at create, and
 * removes it as soon as the Droplet has been made.
 *
 * **Backstop.** The user data powers the Droplet off at the job's deadline
 * (`shutdown -h`). A powered-off Droplet is still billed, and the machine
 * holds nothing that could destroy it, so billing stops only when the host
 * tears it down or its reaper finds it by tag.
 *
 * **Preflight.** DigitalOcean cannot tell a token its own scopes, so the
 * check sends requests that cannot change anything (an empty create body,
 * deletes of ids that do not exist) and reads `403` as the scope missing.
 */
import {
  CI_JOB_TAG,
  CI_RUN_TAG,
  ciCloudInitScript,
  ciHttpStatus,
  ciMachineName,
  ciTagMarker,
  ciTagString,
  ciTagStrings,
  ciTagsFromStrings,
  ciThrowawaySshKey,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { idSegment, type DoApi } from "./api.js";

export const CI_DEFAULT_MACHINE = "s-2vcpu-4gb";
export const CI_DEFAULT_IMAGE = "ubuntu-24-04-x64";
export const CI_DEFAULT_REGION = "nyc3";

export const DO_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Droplet",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      typicalStartSeconds: 60,
      // Per second, at least 60 seconds (or $0.01).
      minimumBillingSeconds: 60,
      machineSuggestions: [
        "s-1vcpu-2gb",
        "s-2vcpu-4gb",
        "s-4vcpu-8gb",
        "c-2",
        "c-4",
        "c-8",
        "g-2vcpu-8gb",
        "m-2vcpu-16gb",
      ],
    },
  ],
  helpLink: {
    label: "Make a token with these scopes",
    url: "https://cloud.digitalocean.com/account/api/tokens",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_SCOPES = {
  dropletRead: { permission: "droplet:read", label: "Follow the job's Droplet" },
  dropletCreate: { permission: "droplet:create", label: "Start the job's Droplet" },
  dropletDelete: { permission: "droplet:delete", label: "Destroy it when the job ends" },
  tagCreate: { permission: "tag:create", label: "Tag it as a CI job's" },
  tagRead: { permission: "tag:read", label: "Find it and leftovers by tag" },
  tagDelete: { permission: "tag:delete", label: "Remove the job's tags afterwards" },
  keyCreate: {
    permission: "ssh_key:create",
    label: "Add a throwaway SSH key, so no root password is emailed",
  },
  keyRead: { permission: "ssh_key:read", label: "Hand that key to the Droplet" },
  keyDelete: { permission: "ssh_key:delete", label: "Remove that key once the Droplet has it" },
} as const satisfies Record<string, CiMissingPermission>;

/** A droplet id DigitalOcean never gives out, for deletes that must find nothing. */
const NO_SUCH_ID = "0";

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`DigitalOcean runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

/** Runs a probe and says whether the token was refused for want of a scope. */
async function refused(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return false;
  } catch (err) {
    return ciHttpStatus(err) === 403;
  }
}

export async function doCiPreflight(
  api: DoApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const where = region ?? CI_DEFAULT_REGION;
  const probes: Array<[CiMissingPermission, () => Promise<unknown>]> = [
    [CI_SCOPES.dropletRead, () => api.get("/droplets", { query: { per_page: 1 } })],
    [
      CI_SCOPES.dropletCreate,
      () => api.written<"droplets_create">("/droplets", { method: "POST", body: "{}" }),
    ],
    [CI_SCOPES.dropletDelete, () => api.delete(`/droplets/${idSegment(NO_SUCH_ID)}`)],
    [CI_SCOPES.tagRead, () => api.get("/tags", { query: { per_page: 1 } })],
    [
      CI_SCOPES.tagCreate,
      () => api.written<"tags_create">("/tags", { method: "POST", body: "{}" }),
    ],
    [CI_SCOPES.tagDelete, () => api.delete(`/tags/${idSegment("iwci-preflight-no-such-tag")}`)],
    [CI_SCOPES.keyRead, () => api.get("/account/keys", { query: { per_page: 1 } })],
    [
      CI_SCOPES.keyCreate,
      () => api.written<"sshKeys_create">("/account/keys", { method: "POST", body: "{}" }),
    ],
    [CI_SCOPES.keyDelete, () => api.delete(`/account/keys/${idSegment(NO_SUCH_ID)}`)],
  ];
  const missing: CiMissingPermission[] = [];
  for (const [scope, probe] of probes) {
    if (await refused(probe)) missing.push(scope);
  }
  const problems: string[] = [];
  try {
    const { regions } = await api.get("/regions", { query: { per_page: 200 } });
    const found = regions.find((r) => r.slug === where);
    if (!found) {
      problems.push(
        `DigitalOcean has no region \`${where}\`. Name one such as nyc3, fra1 or sgp1.`,
      );
    } else if (!found.available) {
      problems.push(`DigitalOcean is not taking new Droplets in ${where}. Use another region.`);
    } else if (!found.sizes.includes(CI_DEFAULT_MACHINE)) {
      problems.push(
        `${where} does not offer the default size ${CI_DEFAULT_MACHINE}; name one it offers in \`cloud.machine\`.`,
      );
    }
  } catch {
    // Not being able to look is no reason to refuse: the start says so.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

interface Droplet {
  id: number;
  name?: string;
  status?: string;
  created_at?: string;
  tags?: string[] | null;
  region?: { slug?: string };
}

function handleOf(droplet: Pick<Droplet, "id">, region: string, keyId?: number): CiHandle {
  return {
    id: String(droplet.id),
    region,
    label: `digitalocean droplet ${droplet.id} (${region})`,
    ...(keyId !== undefined ? { data: { sshKey: String(keyId) } } : {}),
  };
}

/** The Droplet a job already has, found by its job tag. */
async function existing(api: DoApi, spec: CiStartSpec): Promise<Droplet | undefined> {
  const job = spec.tags[CI_JOB_TAG];
  if (!job) return undefined;
  const { droplets } = await api.get("/droplets", {
    query: { tag_name: ciTagString(CI_JOB_TAG, job), per_page: 20 },
  });
  return (droplets ?? []).find((d) => d.status !== "archive");
}

/** The create body for a job. */
export function dropletBody(spec: CiStartSpec, sshKey: number | string) {
  return {
    name: ciMachineName(spec),
    region: spec.region ?? CI_DEFAULT_REGION,
    size: spec.machine ?? CI_DEFAULT_MACHINE,
    image: spec.image ?? CI_DEFAULT_IMAGE,
    ssh_keys: [sshKey],
    user_data: ciCloudInitScript(spec.bootstrap, spec.maxSeconds),
    tags: ciTagStrings(spec.tags),
    monitoring: false,
    with_droplet_agent: false,
    backups: false,
    ipv6: false,
  };
}

async function deleteKey(api: DoApi, id: string): Promise<void> {
  try {
    await api.delete(`/account/keys/${idSegment(id)}`);
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

export async function doCiStart(api: DoApi, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu) {
    throw new Error(
      "On DigitalOcean a GPU comes with the size: name a GPU Droplet size in `cloud.machine` and leave `cloud.gpu` out.",
    );
  }
  const region = spec.region ?? CI_DEFAULT_REGION;
  // The job's tag makes a start idempotent: a retry finds the Droplet the
  // first start made rather than making a second.
  const found = await existing(api, spec);
  if (found) return handleOf(found, found.region?.slug ?? region);
  const name = ciMachineName(spec);
  const { ssh_key } = await api.post("/account/keys", {
    body: { name, public_key: await ciThrowawaySshKey(name) },
  });
  const keyId = ssh_key.id;
  if (keyId === undefined) throw new Error("DigitalOcean made no SSH key");
  try {
    const answer = await api.post("/droplets", { body: dropletBody(spec, keyId) });
    const droplet = "droplet" in answer ? answer.droplet : undefined;
    if (!droplet?.id) throw new Error("DigitalOcean started no Droplet");
    return handleOf(droplet, region, keyId);
  } finally {
    // The Droplet has its copy of the key; the team needs none.
    await deleteKey(api, String(keyId)).catch(() => undefined);
  }
}

export async function doCiStatus(api: DoApi, handle: CiHandle): Promise<CiComputeStatus> {
  let droplet: Droplet;
  try {
    ({ droplet } = await api.get(`/droplets/${idSegment(handle.id)}`));
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = droplet.status ?? "";
  const state: CiComputeStatus["state"] =
    status === "new"
      ? "starting"
      : status === "active"
        ? "running"
        : status === "archive"
          ? "gone"
          : "stopped";
  return { state, detail: status };
}

/** Removes a per-job tag once nothing carries it any more. */
async function dropTagIfUnused(api: DoApi, tag: string): Promise<void> {
  try {
    const { tag: found } = await api.get(`/tags/${idSegment(tag)}`);
    if ((found?.resources?.count ?? 0) > 0) return;
    await api.delete(`/tags/${idSegment(tag)}`);
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

export async function doCiTeardown(api: DoApi, handle: CiHandle): Promise<void> {
  let tags: string[] = [];
  try {
    const { droplet } = await api.get(`/droplets/${idSegment(handle.id)}`);
    tags = droplet.tags ?? [];
    await api.delete(`/droplets/${idSegment(handle.id)}`);
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
  const key = handle.data?.["sshKey"];
  if (key) await deleteKey(api, key);
  // The run's and job's tags would otherwise pile up, one pair per job. The
  // organization's tag and the markers are shared and stay.
  const sent = ciTagsFromStrings(tags);
  for (const key of [CI_RUN_TAG, CI_JOB_TAG]) {
    const value = sent[key];
    if (value) await dropTagIfUnused(api, ciTagString(key, value)).catch(() => undefined);
  }
}

/**
 * Every Droplet tagged for CI. Droplets are listed account-wide, so
 * `regions` does not narrow it: a leftover is found wherever it is.
 */
export async function doCiListTagged(api: DoApi, tagKey: string): Promise<CiTaggedCompute[]> {
  const droplets = await api.getAll("/droplets", "droplets", {
    query: { tag_name: ciTagMarker(tagKey) },
  });
  const out: CiTaggedCompute[] = [];
  for (const droplet of droplets as Droplet[]) {
    const tags = ciTagsFromStrings(droplet.tags ?? []);
    if (!(tagKey in tags)) continue;
    const status = droplet.status ?? "";
    if (status === "archive") continue;
    out.push({
      handle: handleOf(droplet, droplet.region?.slug ?? ""),
      tags,
      ...(droplet.created_at ? { createdAt: droplet.created_at } : {}),
      live: status === "new" || status === "active",
    });
  }
  return out;
}
