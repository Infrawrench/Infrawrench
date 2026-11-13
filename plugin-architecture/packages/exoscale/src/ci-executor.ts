/**
 * CI jobs on Exoscale: one fresh Compute instance per job, started with the
 * host's bootstrap as its cloud-init user data and destroyed when the job
 * ends.
 *
 * **Wire shapes verified against Exoscale's API v2 OpenAPI document
 * (`openapi-v2.exoscale.com/source.json`, the one `plugingen.json` names)
 * and docs, November 2026:**
 * - `POST /instance` (per zone, `api-{zone}.exoscale.com/v2`), an operation
 *   whose `reference.id` is the instance: `name`, `instance-type: {id}`
 *   (from `GET /instance-type`, `family` and `size`), `template: {id}`
 *   (from `GET /template?visibility=public`, "Linux Ubuntu 24.04 LTS
 *   64-bit"), `disk-size` (GiB, 10 or more), `user-data` (base64, at most
 *   32768 characters), `labels`, `public-ip-assignment: "inet4"`.
 * - `GET /instance` (no paging), `GET`/`DELETE /instance/{id}` (an
 *   operation; the local disk goes with the instance). `state` is
 *   `starting`, `running`, `stopping`, `stopped`, `destroying`, `destroyed`,
 *   `expunging`, `migrating` or `error`.
 * - Label values start with something other than a digit and hold letters,
 *   digits and `* + ! - _ ?`, at most 128 characters: tag values are encoded
 *   (`ciEncodeTagValue`) behind a `t` and decoded on the way back.
 * - IAM: `GET /api-key/{key}` names the key's `role-id`; `GET
 *   /iam-role/{id}` its `policy` (`default-service-strategy`, and per
 *   service `type` `allow`, `deny` or `rules`). Both are `iam` calls, which a
 *   key limited to compute may not make.
 * - Billing: by the second for a running instance; a stopped one costs only
 *   its disk, until it is destroyed.
 *
 * **No credentials on the machine.** The instance gets user data and
 * nothing else: no API key, no account SSH key.
 *
 * **Backstop.** The user data powers the instance off at the job's
 * deadline, which ends the compute bill; its disk is billed until the host
 * tears it down or its reaper finds it by label. The machine holds nothing
 * that could destroy itself.
 */
import {
  ciCloudInitScript,
  ciDecodeTagValue,
  ciEncodeTagValue,
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

import { DEFAULT_ZONE, rawId, type ExoscaleApi, type ZoneApi } from "./api.js";

export const CI_DEFAULT_MACHINE = "standard.medium";
export const CI_DEFAULT_IMAGE = "Linux Ubuntu 24.04 LTS 64-bit";
export const CI_DEFAULT_REGION = DEFAULT_ZONE;
const DISK_GIB = 20;

export const EXOSCALE_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Compute instance",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      typicalStartSeconds: 45,
      machineSuggestions: [
        "standard.small",
        "standard.medium",
        "standard.large",
        "standard.extra-large",
        "standard.huge",
        "cpu.extra-large",
      ],
    },
  ],
  helpLink: {
    label: "Give the API key's role compute access",
    url: "https://portal.exoscale.com/iam/roles",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  compute: {
    permission: "compute",
    label: "Create, follow and destroy the job's instance",
  },
} as const satisfies Record<string, CiMissingPermission>;

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`Exoscale runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

/** A tag value as a label value: never starting with a digit, only characters labels take. */
export function labelValue(value: string): string {
  return `t${ciEncodeTagValue(value)}`;
}

function tagValue(label: string): string {
  return ciDecodeTagValue(label.startsWith("t") ? label.slice(1) : label);
}

export function labelsOf(tags: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) out[key] = labelValue(value);
  return out;
}

function tagsOf(labels: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (key.startsWith("infrawrench-ci")) out[key] = tagValue(value);
  }
  return out;
}

export async function exoscaleCiPreflight(
  api: ExoscaleApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const zone = region ?? CI_DEFAULT_REGION;
  const z = api.at(zone);
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  try {
    const key = await z.get(`/api-key/${rawId(api.apiKey)}`);
    const roleId = key["role-id"];
    if (roleId) {
      const role = await z.get(`/iam-role/${rawId(roleId)}`);
      const policy = role.policy;
      const compute = policy?.services?.["compute"];
      const denied =
        compute?.type === "deny" ||
        (compute === undefined && policy?.["default-service-strategy"] === "deny");
      // A `rules` policy is CEL, which cannot be judged without running it;
      // the start says so when a rule refuses it.
      if (denied) missing.push(CI_PERMISSIONS.compute);
    }
  } catch {
    // A key without `iam` access cannot read its own role: the reads below decide.
  }
  try {
    await z.get("/instance");
  } catch (err) {
    if (ciHttpStatus(err) === 403) {
      if (!missing.includes(CI_PERMISSIONS.compute)) missing.push(CI_PERMISSIONS.compute);
    } else {
      problems.push(`Exoscale refused a list of instances in ${zone}: ${String(err)}`);
    }
  }
  try {
    if (!(await templateId(z, CI_DEFAULT_IMAGE))) {
      problems.push(`Exoscale offers no ${CI_DEFAULT_IMAGE} template in ${zone}.`);
    }
  } catch {
    // The start says so.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: zone };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function templateId(z: ZoneApi, image: string): Promise<string | undefined> {
  if (UUID.test(image)) return image;
  const { templates } = await z.get("/template", { query: { visibility: "public" } });
  return (templates ?? []).find((t) => t.name === image)?.id;
}

/** `family.size`, e.g. `standard.medium`, or an instance type's id. */
async function instanceTypeId(z: ZoneApi, machine: string): Promise<string | undefined> {
  if (UUID.test(machine)) return machine;
  const [family, size] = machine.split(".");
  const { "instance-types": types } = await z.get("/instance-type");
  return (types ?? []).find((t) => t.family === family && t.size === size)?.id;
}

/** The create body for a job, given the zone's instance type and template. */
export function instanceBody(spec: CiStartSpec, typeId: string, template: string) {
  return {
    name: ciMachineName(spec),
    "instance-type": { id: typeId },
    template: { id: template },
    "disk-size": DISK_GIB,
    "user-data": utf8ToBase64(ciCloudInitScript(spec.bootstrap, spec.maxSeconds)),
    labels: labelsOf(spec.tags),
    "public-ip-assignment": "inet4",
    "auto-start": true,
  };
}

function handleOf(id: string, zone: string): CiHandle {
  return { id, region: zone, label: `exoscale instance ${id} (${zone})` };
}

export async function exoscaleCiStart(api: ExoscaleApi, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu) {
    throw new Error(
      "On Exoscale a GPU comes with the instance type: name one in `cloud.machine`, e.g. gpu3.small, and leave `cloud.gpu` out.",
    );
  }
  const zone = spec.region ?? CI_DEFAULT_REGION;
  const z = api.at(zone);
  const name = ciMachineName(spec);
  // The name is the job's: a retry finds the instance the first start made.
  const { instances } = await z.get("/instance");
  const found = (instances ?? []).find(
    (i) => i.name === name && i.state !== "destroying" && i.state !== "destroyed",
  );
  if (found?.id) return handleOf(found.id, zone);
  const machine = spec.machine ?? CI_DEFAULT_MACHINE;
  const typeId = await instanceTypeId(z, machine);
  if (!typeId) throw new Error(`Exoscale has no instance type \`${machine}\` in ${zone}.`);
  const image = spec.image ?? CI_DEFAULT_IMAGE;
  const template = await templateId(z, image);
  if (!template) throw new Error(`Exoscale has no template \`${image}\` in ${zone}.`);
  const op = await z.settle(z.post("/instance", { body: instanceBody(spec, typeId, template) }));
  const id = op.reference?.id;
  if (!id) throw new Error("Exoscale started no instance");
  return handleOf(id, zone);
}

export async function exoscaleCiStatus(
  api: ExoscaleApi,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  const z = api.at(handle.region ?? CI_DEFAULT_REGION);
  let state: string;
  try {
    state = (await z.get(`/instance/${rawId(handle.id)}`)).state ?? "";
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  const mapped: CiComputeStatus["state"] =
    state === "starting"
      ? "starting"
      : state === "running" || state === "migrating"
        ? "running"
        : state === "destroying" || state === "destroyed" || state === "expunging"
          ? "gone"
          : "stopped";
  return { state: mapped, detail: state };
}

export async function exoscaleCiTeardown(api: ExoscaleApi, handle: CiHandle): Promise<void> {
  const z = api.at(handle.region ?? CI_DEFAULT_REGION);
  try {
    await z.settle(z.delete(`/instance/${rawId(handle.id)}`));
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

/** Every instance labelled for CI in `regions` (every zone when empty). */
export async function exoscaleCiListTagged(
  api: ExoscaleApi,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const zones = regions.length > 0 ? [...new Set(regions)] : await api.zones();
  const out: CiTaggedCompute[] = [];
  for (const zone of zones) {
    const { instances } = await api.at(zone).get("/instance");
    for (const instance of instances ?? []) {
      const labels = instance.labels ?? {};
      if (!instance.id || !(tagKey in labels)) continue;
      const state = instance.state ?? "";
      if (state === "destroying" || state === "destroyed" || state === "expunging") continue;
      out.push({
        handle: handleOf(instance.id, zone),
        tags: tagsOf(labels),
        ...(instance["created-at"] ? { createdAt: instance["created-at"] } : {}),
        live: state === "starting" || state === "running" || state === "migrating",
      });
    }
  }
  return out;
}
