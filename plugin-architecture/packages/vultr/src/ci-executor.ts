/**
 * CI jobs on Vultr: one fresh Cloud Compute instance per job, started with
 * the host's bootstrap as its cloud-init user data and destroyed when the
 * job ends.
 *
 * **Wire shapes verified against Vultr's API v2 (its Go client `govultr`,
 * its docs and the public catalog endpoints), November 2026:**
 * - `POST /v2/instances` (`202 {instance}`): `region`, `plan`, `os_id`
 *   (2284 is "Ubuntu 24.04 LTS x64" in `GET /v2/os`), `label`, `hostname`,
 *   `user_data` (base64: the API, unlike the console, wants it encoded),
 *   `tags`, `backups: "disabled"`, `enable_ipv6`, `activation_email`.
 * - `GET /v2/instances?label=|tag=` (cursor paging), `GET`/`DELETE
 *   /v2/instances/{id}` (`404` once gone). `status` is `active`, `pending`,
 *   `suspended` or `resizing`; `power_status` `running` or `stopped`;
 *   `server_status` `none`, `locked`, `installingbooting` or `ok`.
 * - `GET /v2/account` carries `acls`, what a sub-user's key may do.
 * - Billing: by the hour, at least one hour, until the instance is
 *   destroyed, stopped or not.
 *
 * **No credentials on the machine.** The instance gets user data and no
 * SSH key; the root password Vultr makes is never read. No API key reaches
 * it.
 *
 * **Backstop.** The user data powers the instance off at the job's
 * deadline. A stopped instance is still billed, and the machine holds
 * nothing that could destroy it, so billing stops only when the host tears
 * it down or its reaper finds it by tag.
 *
 * **Preflight.** A key cannot list its own permissions beyond the account's
 * `acls`; which ACL gates which call is not documented, so the check reads
 * `provisioning` and `subscriptions` as needed for a sub-user (an
 * administrator, `manage_users`, has everything) and reads the instances.
 */
import {
  ciCloudInitScript,
  ciHttpStatus,
  ciMachineName,
  ciTagMarker,
  ciTagStrings,
  ciTagsFromStrings,
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

import type { VultrApi } from "./api.js";

export const CI_DEFAULT_MACHINE = "vc2-2c-4gb";
export const CI_DEFAULT_IMAGE = "Ubuntu 24.04";
/** "Ubuntu 24.04 LTS x64" in `GET /v2/os`. */
export const UBUNTU_2404_OS_ID = 2284;
export const CI_DEFAULT_REGION = "ewr";

export const VULTR_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Cloud Compute instance",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      typicalStartSeconds: 90,
      // Billed by the hour, at least one.
      minimumBillingSeconds: 3600,
      machineSuggestions: [
        "vc2-1c-2gb",
        "vc2-2c-4gb",
        "vc2-4c-8gb",
        "vc2-6c-16gb",
        "vhf-2c-4gb",
        "vhp-2c-4gb-amd",
        "voc-c-2c-4gb-50s-amd",
        "vc2-8c-32gb",
      ],
    },
  ],
  helpLink: {
    label: "Give the API user these permissions",
    url: "https://my.vultr.com/settings/#settingsapi",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_ACLS = {
  provisioning: { permission: "provisioning", label: "Deploy the job's instance" },
  subscriptions: { permission: "subscriptions", label: "Follow and destroy it" },
} as const satisfies Record<string, CiMissingPermission>;

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`Vultr runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

export async function vultrCiPreflight(
  api: VultrApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const where = region ?? CI_DEFAULT_REGION;
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  try {
    const { account } = await api.get<{ account?: { acls?: string[] } }>("/account");
    const acls = account?.acls ?? [];
    // An empty list says nothing; an administrator may do everything.
    if (acls.length > 0 && !acls.includes("manage_users")) {
      for (const acl of Object.values(CI_ACLS)) {
        if (!acls.includes(acl.permission)) missing.push(acl);
      }
    }
  } catch (err) {
    if (ciHttpStatus(err) !== 403)
      problems.push(`Vultr refused a read of the account: ${String(err)}`);
  }
  try {
    await api.get("/instances", { per_page: 1 });
  } catch (err) {
    if (ciHttpStatus(err) === 403 || ciHttpStatus(err) === 401) {
      if (!missing.includes(CI_ACLS.subscriptions)) missing.push(CI_ACLS.subscriptions);
    } else {
      problems.push(`Vultr refused a list of instances: ${String(err)}`);
    }
  }
  try {
    const { regions } = await api.get<{ regions?: Array<{ id?: string }> }>("/regions", {
      per_page: 500,
    });
    if (regions && !regions.some((r) => r.id === where)) {
      problems.push(
        `Vultr has no region \`${where}\`. Name one such as ewr, ord, ams, fra or sgp.`,
      );
    }
  } catch {
    // Not being able to look is no reason to refuse: the start says so.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

interface Instance {
  id: string;
  label?: string;
  status?: string;
  power_status?: string;
  server_status?: string;
  date_created?: string;
  region?: string;
  tags?: string[] | null;
}

function handleOf(instance: Pick<Instance, "id">, region: string): CiHandle {
  return { id: instance.id, region, label: `vultr instance ${instance.id} (${region})` };
}

/** Where the image goes: `os_id` for an OS (the default, or a number), else a Marketplace `image_id`. */
function imageField(image: string | undefined): { os_id: number } | { image_id: string } {
  if (!image || image === CI_DEFAULT_IMAGE) return { os_id: UBUNTU_2404_OS_ID };
  if (/^\d+$/.test(image)) return { os_id: Number(image) };
  return { image_id: image };
}

/** The create body for a job. */
export function instanceBody(spec: CiStartSpec) {
  const name = ciMachineName(spec);
  return {
    region: spec.region ?? CI_DEFAULT_REGION,
    plan: spec.machine ?? CI_DEFAULT_MACHINE,
    ...imageField(spec.image),
    label: name,
    hostname: name,
    user_data: utf8ToBase64(ciCloudInitScript(spec.bootstrap, spec.maxSeconds)),
    tags: ciTagStrings(spec.tags),
    backups: "disabled",
    enable_ipv6: false,
    activation_email: false,
  };
}

export async function vultrCiStart(api: VultrApi, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu) {
    throw new Error(
      "On Vultr a GPU comes with the plan: name a Cloud GPU plan in `cloud.machine` and leave `cloud.gpu` out.",
    );
  }
  const region = spec.region ?? CI_DEFAULT_REGION;
  const label = ciMachineName(spec);
  // The label is the job's: a retry finds the instance the first start made.
  const found = (await api.all<Instance>("/instances", "instances", { label })).find(
    (i) => i.label === label,
  );
  if (found) return handleOf(found, found.region ?? region);
  const { instance } = await api.send<{ instance?: Instance }>(
    "POST",
    "/instances",
    instanceBody(spec),
  );
  if (!instance?.id) throw new Error("Vultr deployed no instance");
  return handleOf(instance, instance.region ?? region);
}

export async function vultrCiStatus(api: VultrApi, handle: CiHandle): Promise<CiComputeStatus> {
  let instance: Instance | undefined;
  try {
    ({ instance } = await api.get<{ instance?: Instance }>(
      `/instances/${encodeURIComponent(handle.id)}`,
    ));
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  if (!instance) return { state: "gone" };
  const detail = [instance.status, instance.power_status, instance.server_status]
    .filter(Boolean)
    .join(" / ");
  const state: CiComputeStatus["state"] =
    instance.power_status === "stopped" || instance.status === "suspended"
      ? "stopped"
      : instance.status === "pending" || instance.server_status === "installingbooting"
        ? "starting"
        : "running";
  return { state, detail };
}

export async function vultrCiTeardown(api: VultrApi, handle: CiHandle): Promise<void> {
  try {
    await api.send("DELETE", `/instances/${encodeURIComponent(handle.id)}`);
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

/** Every instance tagged for CI. Instances are listed account-wide, so `regions` does not narrow it. */
export async function vultrCiListTagged(api: VultrApi, tagKey: string): Promise<CiTaggedCompute[]> {
  const instances = await api.all<Instance>("/instances", "instances", {
    tag: ciTagMarker(tagKey),
  });
  const out: CiTaggedCompute[] = [];
  for (const instance of instances) {
    const tags = ciTagsFromStrings(instance.tags ?? []);
    if (!(tagKey in tags)) continue;
    out.push({
      handle: handleOf(instance, instance.region ?? ""),
      tags,
      ...(instance.date_created ? { createdAt: instance.date_created } : {}),
      live: instance.power_status !== "stopped" && instance.status !== "suspended",
    });
  }
  return out;
}
