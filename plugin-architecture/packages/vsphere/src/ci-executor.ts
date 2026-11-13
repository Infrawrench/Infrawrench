/**
 * CI jobs on vSphere: one VM per job, cloned from a template the pipeline
 * names (`cloud.image`), given the bootstrap as cloud-init user data, and
 * deleted when the job ends.
 *
 * **Wire shapes verified against the vSphere Automation API reference
 * (8.0.3 for field casing, 9.0 and 9.1), November 2026:**
 * - `POST /api/vcenter/vm?action=clone` with `{ source, name, placement?,
 *   power_on }` answers the new VM's id. A placement left out is the
 *   source's; a template has no resource pool of its own, so the job's
 *   cluster (`cloud.region`, or the only cluster there is) is passed.
 * - `PUT /api/vcenter/vm/{vm}/guest/customization` with a `cloud_config` of
 *   type `CLOUDINIT` (`metadata`, `userdata`), on the powered-off clone:
 *   cloud-init runs it at the first power-on. vCenter 7.0 U3 and later; the
 *   template needs open-vm-tools 11.3+, cloud-init 21.1+ and
 *   `disable_vmware_customization: false`.
 * - `POST /api/vcenter/vm/{vm}/power?action=start|stop`, `GET .../power`
 *   (`state`), `DELETE /api/vcenter/vm/{vm}` (powered off first). An unknown
 *   VM answers 404.
 * - `GET /api/vcenter/vm?names=` matches exact names only.
 * - Tagging: a category `infrawrench-ci` (`MULTIPLE`, VirtualMachine) and a
 *   tag per organization's CI scope (the `infrawrench-ci` tag's value),
 *   attached with `tag-association/{tag}?action=attach` and listed with
 *   `?action=list-attached-objects`.
 *
 * The VM's name is `iwci-<the CI job's id>`, so a retry after a lost answer
 * finds the VM it made, and listing gives the job back. vSphere keeps no
 * other per-VM text the REST API can read (notes are SOAP only), so the run
 * id is not kept on the VM.
 *
 * The backstop is the guest's own: the bootstrap runs behind a `shutdown -h`
 * timer. vSphere has no "delete on power-off", so a VM that stopped on its
 * own stays, powered off, until the host's teardown or reaper deletes it.
 */
import {
  CI_JOB_TAG,
  CI_TAG,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { VsphereApiError, type Query } from "./api.js";

/** The parts of `VsphereApi` the executor uses. */
export interface VsphereCalls {
  request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    opts?: { query?: Query; body?: unknown },
  ): Promise<T>;
}

/** The tag category every CI VM's tag is in. */
export const CI_CATEGORY = "infrawrench-ci";
const NAME_PREFIX = "iwci-";

export const VSPHERE_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "VM cloned from a template",
      defaults: {},
      typicalStartSeconds: 120,
    },
  ],
  helpLink: {
    label: "Give the vCenter user a role with these privileges",
    url: "https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vsphere/8-0/vsphere-security-8-0/defined-privileges/virtual-machine-provisioning-privileges.html",
  },
} as const satisfies CiExecutorDeclaration;

/**
 * What a CI job needs from the vCenter role. vCenter has no API to ask
 * whether a user holds a privilege without trying the operation, so these
 * are documented here and named again when an operation is denied.
 */
export const CI_PRIVILEGES = [
  "VirtualMachine.Provisioning.Clone",
  "VirtualMachine.Provisioning.DeployTemplate",
  "VirtualMachine.Provisioning.Customize",
  "VirtualMachine.Inventory.CreateFromExisting",
  "VirtualMachine.Inventory.Delete",
  "VirtualMachine.Interact.PowerOn",
  "VirtualMachine.Interact.PowerOff",
  "Resource.AssignVMToPool",
  "Datastore.AllocateSpace",
  "InventoryService.Tagging.CreateCategory",
  "InventoryService.Tagging.CreateTag",
  "InventoryService.Tagging.AttachTag",
  "InventoryService.Tagging.ObjectAttachable",
] as const;

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") {
    throw new Error(`vSphere runs CI jobs of kind \`vm\` only, not \`${kind}\`.`);
  }
}

function status(err: unknown): number | undefined {
  return err instanceof VsphereApiError ? err.status : undefined;
}

function denied(err: unknown): Error {
  if (status(err) !== 403) return err instanceof Error ? err : new Error(String(err));
  return new Error(
    `${err instanceof Error ? err.message : String(err)} A CI job needs ${CI_PRIVILEGES.join(", ")}.`,
    { cause: err },
  );
}

/** The VM's name: the CI job's id behind a prefix, so the id can be read back. */
export function vmName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  const source = spec.tags[CI_JOB_TAG] ?? spec.name;
  return `${NAME_PREFIX}${source}`.slice(0, 80);
}

/**
 * The cloud-init user data: a script behind a power-off timer, and a
 * power-off after it.
 */
export function userData(bootstrap: string, maxSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(maxSeconds / 60));
  const body = bootstrap.replace(/^#![^\n]*\n/, "");
  return [
    "#!/bin/sh",
    `shutdown -h +${minutes} >/dev/null 2>&1 || true`,
    "(",
    body,
    ")",
    "shutdown -h now",
    "",
  ].join("\n");
}

/** The guest customization that hands the clone its user data. */
export function customization(name: string, bootstrap: string, maxSeconds: number) {
  const host = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, 63)
    .replace(/-+$/, "");
  return {
    spec: {
      configuration_spec: {
        cloud_config: {
          type: "CLOUDINIT",
          cloudinit: {
            metadata: `instance-id: ${host}\nlocal-hostname: ${host}\n`,
            userdata: userData(bootstrap, maxSeconds),
          },
        },
      },
      global_DNS_settings: {},
      interfaces: [],
    },
  };
}

interface VmSummary {
  vm: string;
  name: string;
  power_state?: string;
}

async function findVm(api: VsphereCalls, name: string): Promise<VmSummary | undefined> {
  const found = await api.request<VmSummary[]>("GET", "/vcenter/vm", { query: { names: [name] } });
  return found?.[0];
}

/** The template a pipeline named: a VM id (`vm-42`) or an exact name. */
async function findSource(api: VsphereCalls, image: string): Promise<string> {
  if (/^vm-\d+$/.test(image)) return image;
  const found = await api.request<VmSummary[]>("GET", "/vcenter/vm", { query: { names: [image] } });
  if (!found || found.length === 0) throw new Error(`No VM or template named ${image} in vCenter.`);
  if (found.length > 1) {
    throw new Error(
      `More than one VM is named ${image}; name the template by id in \`cloud.image\` (${found.map((v) => v.vm).join(", ")}).`,
    );
  }
  return found[0]!.vm;
}

/** Where the clone goes: the cluster, resource pool or host `region` names, or the only cluster. */
async function placement(
  api: VsphereCalls,
  region: string | undefined,
): Promise<Record<string, string> | undefined> {
  const byName = async (path: string, key: string, id: string) => {
    if (!region) return undefined;
    const found = await api.request<Array<Record<string, string>>>("GET", path, {
      query: { names: [region] },
    });
    return found?.[0]?.[key] ? { [id]: found[0][key]! } : undefined;
  };
  if (region) {
    const found =
      (await byName("/vcenter/cluster", "cluster", "cluster")) ??
      (await byName("/vcenter/resource-pool", "resource_pool", "resource_pool")) ??
      (await byName("/vcenter/host", "host", "host"));
    if (!found) {
      throw new Error(`No cluster, resource pool or host named ${region} in vCenter.`);
    }
    return found;
  }
  const clusters = await api.request<Array<{ cluster: string }>>("GET", "/vcenter/cluster");
  return clusters?.length === 1 ? { cluster: clusters[0]!.cluster } : undefined;
}

/** The id of the tag for one CI scope, made (with its category) the first time. */
async function scopeTag(api: VsphereCalls, scope: string, create: boolean): Promise<string | null> {
  const categories = (await api.request<string[]>("GET", "/cis/tagging/category")) ?? [];
  let category: string | undefined;
  for (const id of categories) {
    const c = await api.request<{ name?: string }>(
      "GET",
      `/cis/tagging/category/${encodeURIComponent(id)}`,
    );
    if (c?.name === CI_CATEGORY) {
      category = id;
      break;
    }
  }
  if (!category) {
    if (!create) return null;
    category = await api.request<string>("POST", "/cis/tagging/category", {
      body: {
        name: CI_CATEGORY,
        description: "Infrawrench CI jobs' VMs",
        cardinality: "MULTIPLE",
        associable_types: ["VirtualMachine"],
      },
    });
  }
  const tags =
    (await api.request<string[]>("POST", "/cis/tagging/tag", {
      query: { action: "list-tags-for-category" },
      body: { category_id: category },
    })) ?? [];
  for (const id of tags) {
    const t = await api.request<{ name?: string }>(
      "GET",
      `/cis/tagging/tag/${encodeURIComponent(id)}`,
    );
    if (t?.name === scope) return id;
  }
  if (!create) return null;
  return api.request<string>("POST", "/cis/tagging/tag", {
    body: {
      name: scope,
      description: "Infrawrench CI jobs of one organization",
      category_id: category,
    },
  });
}

function handleOf(vm: string, name: string): CiHandle {
  return { id: vm, label: `vsphere vm ${vm} ${name}`, data: { name } };
}

export async function ciPreflight(
  api: VsphereCalls,
  kind: CiExecutorKind,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const problems: string[] = [];
  try {
    await api.request("GET", "/vcenter/vm", { query: { names: ["infrawrench-ci-preflight"] } });
    await api.request("GET", "/cis/tagging/category");
  } catch (err) {
    problems.push(`vCenter did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  // vCenter cannot say whether a user holds a privilege without trying the
  // operation, so nothing is listed as missing here; a denied operation
  // names the privileges when a job starts.
  return { ok: problems.length === 0, missing: [], problems };
}

export async function ciStart(api: VsphereCalls, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu)
    throw new Error("A vSphere CI job gets the template's devices; `cloud.gpu` is not offered.");
  if (spec.machine) {
    throw new Error(
      "A vSphere CI job is sized by its template: the clone API cannot change CPUs or memory, so leave `cloud.machine` out and pick a template of the size you want.",
    );
  }
  if (!spec.image) {
    throw new Error(
      "Name the VM template to clone in `cloud.image` (its name or its id, like vm-42).",
    );
  }
  const name = vmName(spec);
  const scope = spec.tags[CI_TAG];
  try {
    const existing = await findVm(api, name);
    if (existing) return handleOf(existing.vm, name);
    const source = await findSource(api, spec.image);
    const where = await placement(api, spec.region);
    const vm = await api.request<string>("POST", "/vcenter/vm", {
      query: { action: "clone" },
      body: { source, name, power_on: false, ...(where ? { placement: where } : {}) },
    });
    const handle = handleOf(vm, name);
    try {
      if (scope) {
        const tag = await scopeTag(api, scope, true);
        if (tag) {
          await api.request("POST", `/cis/tagging/tag-association/${encodeURIComponent(tag)}`, {
            query: { action: "attach" },
            body: { object_id: { type: "VirtualMachine", id: vm } },
          });
        }
      }
      await api.request("PUT", `/vcenter/vm/${encodeURIComponent(vm)}/guest/customization`, {
        body: customization(name, spec.bootstrap, spec.maxSeconds),
      });
      await api.request("POST", `/vcenter/vm/${encodeURIComponent(vm)}/power`, {
        query: { action: "start" },
      });
    } catch (err) {
      // Nothing half-started outlives a failed start.
      await ciTeardown(api, handle).catch(() => undefined);
      throw err;
    }
    return handle;
  } catch (err) {
    throw denied(err);
  }
}

export async function ciStatus(api: VsphereCalls, handle: CiHandle): Promise<CiComputeStatus> {
  let power: { state?: string };
  try {
    power = await api.request("GET", `/vcenter/vm/${encodeURIComponent(handle.id)}/power`);
  } catch (err) {
    if (status(err) === 404) return { state: "gone" };
    throw err;
  }
  if (power?.state === "POWERED_ON") return { state: "running" };
  return { state: "stopped", ...(power?.state ? { detail: power.state } : {}) };
}

export async function ciTeardown(api: VsphereCalls, handle: CiHandle): Promise<void> {
  const vm = `/vcenter/vm/${encodeURIComponent(handle.id)}`;
  try {
    try {
      await api.request("POST", `${vm}/power`, { query: { action: "stop" } });
    } catch (err) {
      // 400 AlreadyInDesiredState: it is already off.
      if (status(err) !== 400) throw err;
    }
    await api.request("DELETE", vm);
  } catch (err) {
    if (status(err) === 404) return;
    throw denied(err);
  }
}

export async function ciListTagged(api: VsphereCalls, tagKey: string): Promise<CiTaggedCompute[]> {
  if (tagKey !== CI_TAG) return [];
  const categories = (await api.request<string[]>("GET", "/cis/tagging/category")) ?? [];
  let category: string | undefined;
  for (const id of categories) {
    const c = await api.request<{ name?: string }>(
      "GET",
      `/cis/tagging/category/${encodeURIComponent(id)}`,
    );
    if (c?.name === CI_CATEGORY) category = id;
  }
  if (!category) return [];
  const tags =
    (await api.request<string[]>("POST", "/cis/tagging/tag", {
      query: { action: "list-tags-for-category" },
      body: { category_id: category },
    })) ?? [];
  const out: CiTaggedCompute[] = [];
  for (const tagId of tags) {
    const tag = await api.request<{ name?: string }>(
      "GET",
      `/cis/tagging/tag/${encodeURIComponent(tagId)}`,
    );
    const objects =
      (await api.request<Array<{ type?: string; id?: string }>>(
        "POST",
        `/cis/tagging/tag-association/${encodeURIComponent(tagId)}`,
        { query: { action: "list-attached-objects" } },
      )) ?? [];
    const ids = objects.filter((o) => o.type === "VirtualMachine" && o.id).map((o) => o.id!);
    if (ids.length === 0) continue;
    const vms =
      (await api.request<VmSummary[]>("GET", "/vcenter/vm", { query: { vms: ids } })) ?? [];
    for (const vm of vms) {
      const job = vm.name.startsWith(NAME_PREFIX) ? vm.name.slice(NAME_PREFIX.length) : undefined;
      out.push({
        handle: handleOf(vm.vm, vm.name),
        tags: { [CI_TAG]: tag?.name ?? "", ...(job ? { [CI_JOB_TAG]: job } : {}) },
        live: vm.power_state === "POWERED_ON",
      });
    }
  }
  return out;
}
