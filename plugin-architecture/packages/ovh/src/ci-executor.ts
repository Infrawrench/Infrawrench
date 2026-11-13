/**
 * CI jobs on OVHcloud Public Cloud: one fresh instance per job, made through
 * the OVH API (`/cloud/project/{serviceName}/instance`, which this plugin
 * already signs) with the host's bootstrap as its user data, and deleted
 * when the job ends. Public Cloud runs on OpenStack, but the connection
 * holds OVH API keys, not OpenStack credentials, so everything here goes
 * through the OVH API.
 *
 * **Wire shapes verified against the OVH API schema
 * (`eu.api.ovh.com/v1/cloud.json` and `auth.json`, the console's source)
 * and docs, November 2026:**
 * - `POST /cloud/project/{sn}/instance` (`cloud.ProjectInstanceCreation`,
 *   answered synchronously with the instance): `name`, `flavorId` and
 *   `region` (required), `imageId`, `userData` (text), `monthlyBilling`,
 *   `sshKeyId` (optional), `networks` (left out: the public network).
 * - `GET .../flavor?region=` (`id`, `name`), `GET
 *   .../image?osType=linux&region=` (`id`, `name`, "Ubuntu 24.04"),
 *   `GET .../instance?region=` (`id`, `name`, `status`, `created`,
 *   `region`), `GET`/`DELETE .../instance/{id}` (`404` once gone).
 * - Instances take no tags and no metadata through this API, so the job's
 *   tags ride in the instance's name, after `iwci-<job key>`, as
 *   `ciTagStrings` writes them.
 * - `GET /auth/currentCredential` answers the consumer key's `rules`
 *   (`{method, path}`, `*` matching the rest of a path). IAM policies can
 *   still refuse a call the rules allow.
 * - Billing: hourly instances are billed by the second after a first
 *   minute, from `ACTIVE`; a stopped (`SHUTOFF`) instance is billed as a
 *   running one until it is deleted (only a shelved one stops the bill).
 *
 * **No credentials on the machine.** The instance gets user data and no SSH
 * key; OVH API keys never leave the host.
 *
 * **Backstop.** The user data powers the instance off at the job's
 * deadline. A stopped instance is still billed, and the machine holds
 * nothing that could delete itself, so billing stops only when the host
 * tears it down or its reaper finds it by name.
 */
import {
  ciCloudInitScript,
  ciHttpStatus,
  ciMachineName,
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

import type { OvhApi } from "./extras.js";

export const CI_DEFAULT_MACHINE = "b3-8";
export const CI_DEFAULT_IMAGE = "Ubuntu 24.04";
export const CI_DEFAULT_REGION = "GRA11";

export const OVH_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Public Cloud instance",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      typicalStartSeconds: 90,
      // By the second after a first minute.
      minimumBillingSeconds: 60,
      machineSuggestions: ["d2-4", "d2-8", "b2-7", "b3-8", "b3-16", "c3-4", "c3-8", "b2-15"],
    },
  ],
  helpLink: {
    label: "Create API keys with these rights",
    url: "https://www.ovh.com/auth/api/createToken",
  },
} as const satisfies CiExecutorDeclaration;

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`OVHcloud runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

/** Whether an access rule's path pattern covers `path`: `*` matches anything after it. */
export function ruleCovers(pattern: string, path: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(path);
}

interface Rule {
  method?: string;
  path?: string;
}

/** The calls a CI job makes, as the consumer key's rules must allow them. */
function neededCalls(projectPath: string): Array<[string, string, string]> {
  return [
    ["POST", `${projectPath}/instance`, "Create the job's instance"],
    ["GET", `${projectPath}/instance`, "Find it and leftovers"],
    ["GET", `${projectPath}/instance/{instanceId}`, "Follow it"],
    ["DELETE", `${projectPath}/instance/{instanceId}`, "Delete it when the job ends"],
    ["GET", `${projectPath}/flavor`, "Find the flavor"],
    ["GET", `${projectPath}/image`, "Find the Ubuntu image"],
  ];
}

export async function ovhCiPreflight(
  api: OvhApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const where = region ?? CI_DEFAULT_REGION;
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  const project = api.cloudPath("");
  try {
    const credential = await api.fetch<{ rules?: Rule[]; status?: string }>(
      "/auth/currentCredential",
    );
    if (credential.status && credential.status !== "validated") {
      problems.push(`The consumer key is ${credential.status}; validate it or make a new one.`);
    }
    const rules = credential.rules ?? [];
    for (const [method, path, label] of neededCalls(project)) {
      const allowed = rules.some(
        (r) => r.method === method && typeof r.path === "string" && ruleCovers(r.path, path),
      );
      if (!allowed) missing.push({ permission: `${method} ${path}`, label });
    }
  } catch (err) {
    problems.push(`OVH would not describe the consumer key: ${String(err)}`);
  }
  try {
    const regions = await api.listUpRegions();
    if (regions.length > 0 && !regions.includes(where)) {
      problems.push(
        `The project has no region ${where} up. Name one of ${regions.slice(0, 8).join(", ")}.`,
      );
    }
  } catch {
    // Not being able to look is no reason to refuse: the start says so.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

interface Instance {
  id?: string;
  name?: string;
  status?: string;
  created?: string;
  region?: string;
}

/** The instance's name: the machine name, then the job's tags. */
export function instanceName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  // The `key:value` strings only: the bare markers add nothing a name needs.
  return [ciMachineName(spec), ...ciTagStrings(spec.tags).filter((s) => s.includes(":"))].join(" ");
}

function tagsOfName(name: string): Record<string, string> {
  return ciTagsFromStrings(name.split(" ").slice(1));
}

function handleOf(instance: Instance, region: string): CiHandle {
  const id = instance.id ?? "";
  return { id, region, label: `ovh instance ${id} (${region})` };
}

async function instancesIn(api: OvhApi, region: string): Promise<Instance[]> {
  return (
    (await api.fetch<Instance[] | null>(
      api.cloudPath(`/instance?region=${encodeURIComponent(region)}`),
    )) ?? []
  );
}

async function idByName(api: OvhApi, suffix: string, name: string): Promise<string | undefined> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return name;
  const rows =
    (await api.fetch<Array<{ id?: string; name?: string; osType?: string }> | null>(
      api.cloudPath(suffix),
    )) ?? [];
  const named = rows.filter((r) => r.name === name);
  return (named.find((r) => (r.osType ?? "linux") === "linux") ?? named[0])?.id;
}

/** The create body for a job, given the region's flavor and image ids. */
export function instanceBody(spec: CiStartSpec, flavorId: string, imageId: string) {
  return {
    name: instanceName(spec),
    flavorId,
    imageId,
    region: spec.region ?? CI_DEFAULT_REGION,
    userData: ciCloudInitScript(spec.bootstrap, spec.maxSeconds),
    monthlyBilling: false,
  };
}

export async function ovhCiStart(api: OvhApi, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu) {
    throw new Error(
      "On OVHcloud a GPU comes with the flavor: name a GPU flavor in `cloud.machine` and leave `cloud.gpu` out.",
    );
  }
  const region = spec.region ?? CI_DEFAULT_REGION;
  const prefix = ciMachineName(spec);
  // The name starts with the job's key: a retry finds the first start's instance.
  const found = (await instancesIn(api, region)).find(
    (i) =>
      (i.name ?? "").split(" ")[0] === prefix && i.status !== "DELETED" && i.status !== "DELETING",
  );
  if (found?.id) return handleOf(found, region);
  const machine = spec.machine ?? CI_DEFAULT_MACHINE;
  const r = encodeURIComponent(region);
  const flavorId = await idByName(api, `/flavor?region=${r}`, machine);
  if (!flavorId) throw new Error(`OVHcloud has no flavor \`${machine}\` in ${region}.`);
  const image = spec.image ?? CI_DEFAULT_IMAGE;
  const imageId = await idByName(api, `/image?osType=linux&region=${r}`, image);
  if (!imageId) throw new Error(`OVHcloud has no image \`${image}\` in ${region}.`);
  const created = await api.fetch<Instance>(api.cloudPath("/instance"), {
    method: "POST",
    body: JSON.stringify(instanceBody(spec, flavorId, imageId)),
  });
  if (!created?.id) throw new Error("OVHcloud started no instance");
  return handleOf(created, created.region ?? region);
}

export async function ovhCiStatus(api: OvhApi, handle: CiHandle): Promise<CiComputeStatus> {
  let instance: Instance;
  try {
    instance = await api.fetch<Instance>(
      api.cloudPath(`/instance/${encodeURIComponent(handle.id)}`),
    );
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = (instance?.status ?? "").toUpperCase();
  const state: CiComputeStatus["state"] =
    status === "BUILD" || status === "BUILDING"
      ? "starting"
      : status === "DELETED" || status === "DELETING" || status === "SOFT_DELETED"
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

export async function ovhCiTeardown(api: OvhApi, handle: CiHandle): Promise<void> {
  try {
    await api.fetch(api.cloudPath(`/instance/${encodeURIComponent(handle.id)}`), {
      method: "DELETE",
    });
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

/** Every CI instance carrying `tagKey` in `regions` (the default region when empty). */
export async function ovhCiListTagged(
  api: OvhApi,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const region of regions.length > 0 ? [...new Set(regions)] : [CI_DEFAULT_REGION]) {
    for (const instance of await instancesIn(api, region)) {
      const name = instance.name ?? "";
      if (!instance.id || !name.startsWith("iwci-")) continue;
      const tags = tagsOfName(name);
      if (!(tagKey in tags)) continue;
      const status = (instance.status ?? "").toUpperCase();
      if (status === "DELETED" || status === "DELETING") continue;
      out.push({
        handle: handleOf(instance, instance.region ?? region),
        tags,
        ...(instance.created ? { createdAt: instance.created } : {}),
        live: status === "ACTIVE" || status === "BUILD" || status === "BUILDING",
      });
    }
  }
  return out;
}
