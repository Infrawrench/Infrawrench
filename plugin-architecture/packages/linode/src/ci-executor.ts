/**
 * CI jobs on Akamai Cloud (Linode): one fresh Linode per job, started with
 * the host's bootstrap as its Metadata service user data (cloud-init) and
 * deleted when the job ends.
 *
 * **Wire shapes verified against the Linode API v4 reference and its
 * OpenAPI document (the one `plugingen.json` names), November 2026:**
 * - `POST /linode/instances`: `label` (3 to 64 of letters, digits, `-`, `_`,
 *   `.`, starting with a letter, no doubled punctuation), `region`, `type`,
 *   `image` (`linode/ubuntu24.04`, which has the `cloud-init` capability),
 *   `root_pass` (one of `root_pass`, `authorized_keys`, `authorized_users`
 *   is required), `tags` (each 3 to 50 characters), `metadata.user_data`
 *   (base64, at most 65535 bytes encoded), `booted`, `backups_enabled`,
 *   `private_ip`. Every core region has the Metadata service.
 * - `GET /linode/instances` with an `X-Filter` header (`label`, `tags`),
 *   paged by `page`/`page_size`; `GET`/`DELETE /linode/instances/{id}`
 *   (delete answers `200 {}` and takes the disks with it). `status` is
 *   `running`, `offline`, `booting`, `busy`, `rebooting`, `shutting_down`,
 *   `provisioning`, `deleting`, `migrating`, `rebuilding`, `cloning`,
 *   `restoring`, `stopped` or `billing_suspension`.
 * - Every answer carries `X-OAuth-Scopes`, the token's own scopes (`*` for
 *   everything). `GET /profile/grants` answers `204` for an unrestricted
 *   user and the grants (`global.add_linodes`) for a restricted one.
 * - Billing: by the hour, rounded up, until the Linode is deleted, powered
 *   off or not.
 *
 * **No credentials on the machine.** The Linode gets user data and a random
 * root password nobody keeps (the API refuses to make one without some way
 * in); no token, no account SSH key.
 *
 * **Backstop.** The user data powers the Linode off at the job's deadline.
 * A powered-off Linode is still billed, and the machine holds nothing that
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
  ciThrowawayPassword,
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

import { segment, xFilter, type LinodeApi } from "./api.js";

export const CI_DEFAULT_MACHINE = "g6-standard-2";
export const CI_DEFAULT_IMAGE = "linode/ubuntu24.04";
export const CI_DEFAULT_REGION = "us-east";

export const LINODE_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Linode",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      typicalStartSeconds: 60,
      // Billed by the hour, rounded up.
      minimumBillingSeconds: 3600,
      machineSuggestions: [
        "g6-standard-1",
        "g6-standard-2",
        "g6-standard-4",
        "g6-dedicated-2",
        "g6-dedicated-4",
        "g7-premium-2",
        "g8-dedicated-4-2",
        "g8-dedicated-8-2",
      ],
    },
  ],
  helpLink: {
    label: "Make a token with Linodes read and write",
    url: "https://cloud.linode.com/profile/tokens",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  linodes: {
    permission: "linodes:read_write",
    label: "Create, follow and delete the job's Linode",
  },
  addLinodes: {
    permission: "add_linodes",
    label: "Create Linodes (a grant for restricted users)",
  },
} as const satisfies Record<string, CiMissingPermission>;

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`Linode runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

/** Whether `X-OAuth-Scopes` lets the token write Linodes. */
export function scopesAllowLinodes(header: string | undefined): boolean {
  const scopes = (header ?? "").split(/[\s,]+/).filter(Boolean);
  return scopes.includes("*") || scopes.includes("linodes:read_write");
}

export async function linodeCiPreflight(
  api: LinodeApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const where = region ?? CI_DEFAULT_REGION;
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  const { headers } = await api.getResponse("/profile");
  const scopes = headers["x-oauth-scopes"];
  // A transport that drops headers says nothing either way.
  if (scopes !== undefined && !scopesAllowLinodes(scopes)) missing.push(CI_PERMISSIONS.linodes);
  try {
    const grants = await api.get("/profile/grants");
    // 204 (an unrestricted user) reads as an empty body.
    const global = (grants as { global?: { add_linodes?: boolean } } | undefined)?.global;
    if (global && global.add_linodes !== true) missing.push(CI_PERMISSIONS.addLinodes);
  } catch (err) {
    if (ciHttpStatus(err) !== 403) {
      problems.push(`Linode refused a read of the user's grants: ${String(err)}`);
    }
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

interface Instance {
  id: number;
  label?: string;
  status?: string;
  created?: string;
  tags?: string[];
  region?: string;
}

function handleOf(instance: Pick<Instance, "id">, region: string): CiHandle {
  return {
    id: String(instance.id),
    region,
    label: `linode ${instance.id} (${region})`,
  };
}

/** The create body for a job. */
export function instanceBody(spec: CiStartSpec) {
  return {
    label: ciMachineName(spec),
    region: spec.region ?? CI_DEFAULT_REGION,
    type: spec.machine ?? CI_DEFAULT_MACHINE,
    image: spec.image ?? CI_DEFAULT_IMAGE,
    root_pass: ciThrowawayPassword(),
    tags: ciTagStrings(spec.tags),
    metadata: { user_data: utf8ToBase64(ciCloudInitScript(spec.bootstrap, spec.maxSeconds)) },
    booted: true,
    backups_enabled: false,
    private_ip: false,
  };
}

/**
 * Created dates come without a zone (`2026-11-13T10:00:00`); they are UTC.
 */
function utc(created: string | undefined): string | undefined {
  if (!created) return undefined;
  return /[zZ]|[+-]\d\d:?\d\d$/.test(created) ? created : `${created}Z`;
}

export async function linodeCiStart(api: LinodeApi, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu) {
    throw new Error(
      "On Linode a GPU comes with the plan: name a GPU plan in `cloud.machine` and leave `cloud.gpu` out.",
    );
  }
  const region = spec.region ?? CI_DEFAULT_REGION;
  const label = ciMachineName(spec);
  // The label is the job's: a retry finds the Linode the first start made.
  const { data } = await api.get("/linode/instances", xFilter({ label }));
  const found = (data as Instance[]).find((i) => i.status !== "deleting");
  if (found) return handleOf(found, found.region ?? region);
  const created = await api.post("/linode/instances", { body: instanceBody(spec) });
  return handleOf(created as Instance, region);
}

export async function linodeCiStatus(api: LinodeApi, handle: CiHandle): Promise<CiComputeStatus> {
  let instance: Instance;
  try {
    instance = (await api.get(`/linode/instances/${segment(handle.id)}`)) as Instance;
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = instance.status ?? "";
  const state: CiComputeStatus["state"] =
    status === "provisioning" || status === "booting"
      ? "starting"
      : status === "offline" || status === "stopped" || status === "shutting_down"
        ? "stopped"
        : status === "deleting"
          ? "gone"
          : "running";
  return { state, detail: status };
}

export async function linodeCiTeardown(api: LinodeApi, handle: CiHandle): Promise<void> {
  try {
    await api.delete(`/linode/instances/${segment(handle.id)}`);
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

/** Every Linode tagged for CI. Linodes are listed account-wide, so `regions` does not narrow it. */
export async function linodeCiListTagged(
  api: LinodeApi,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const instances = (await api.getAll(
    "/linode/instances",
    "data",
    xFilter({ tags: ciTagMarker(tagKey) }),
  )) as Instance[];
  const out: CiTaggedCompute[] = [];
  for (const instance of instances) {
    const tags = ciTagsFromStrings(instance.tags ?? []);
    if (!(tagKey in tags)) continue;
    const status = instance.status ?? "";
    if (status === "deleting") continue;
    const created = utc(instance.created);
    out.push({
      handle: handleOf(instance, instance.region ?? ""),
      tags,
      ...(created ? { createdAt: created } : {}),
      live: status !== "offline" && status !== "stopped" && status !== "shutting_down",
    });
  }
  return out;
}
