/**
 * CI jobs on Proxmox VE: one VM per job, cloned from a template the
 * pipeline names (`cloud.image`, a VMID or a template's name), started, and
 * handed the bootstrap through the QEMU guest agent.
 *
 * **Wire shapes verified against the Proxmox VE API viewer schema
 * (`apidoc.js`, PVE 9.2) and qemu-server's source, November 2026:**
 * - `POST /nodes/{node}/qemu/{vmid}/clone` (`newid`, `name` as a DNS name,
 *   `description`, `target`) returns a UPID; the new VM is locked `clone`
 *   until that task ends. A template clones linked by default.
 * - `GET /cluster/nextid` proposes a free VMID; `GET /cluster/resources
 *   ?type=vm` lists every guest with `vmid`, `name`, `node`, `status`,
 *   `tags`, `template`.
 * - `PUT /nodes/{node}/qemu/{vmid}/config`: `cores`, `memory` (MiB),
 *   `agent`, `tags` (`[a-z0-9_][a-z0-9_+.-]*`, lowercased) and
 *   `description` (at most 8192 characters, where the tags are kept as sent).
 * - `POST .../status/start`; `POST .../agent/ping`; `POST .../agent/exec`
 *   with `command` as a list (no shell) and `input-data` as its standard
 *   input. PVE 9 wants `VM.GuestAgent.Unrestricted` for exec, PVE 8
 *   `VM.Monitor`.
 * - `POST .../status/stop` then `DELETE /nodes/{node}/qemu/{vmid}` with
 *   `purge` and `destroy-unreferenced-disks`: a running VM cannot be
 *   destroyed.
 * - `GET /access/permissions` gives the token's own effective privileges.
 *
 * Proxmox cannot take cloud-init user data over its API (only a snippets
 * file already on a storage), so the template needs the QEMU guest agent
 * (`qemu-guest-agent`) installed and enabled; cloud-init is not required.
 * Containers are not offered: the API has no way to run a command in an LXC
 * container (`pct exec` is local to the node) and no user data for one.
 *
 * The backstop is the guest's own: the bootstrap runs behind a `shutdown -h`
 * timer, so the VM powers off once the job's time is up. Proxmox has no
 * "destroy on shutdown", so a VM that stopped on its own stays until the
 * host's teardown or reaper destroys it; it uses no CPU or memory then.
 */
import {
  CI_JOB_TAG,
  CI_TAG,
  ciComputeKey,
  ciShellQuote,
  parseCiContainerSize,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import type { FormValue } from "./api.js";
import type { PveClusterResource } from "./mappers.js";

/** The parts of `ProxmoxApi` the executor uses. */
export interface PveCalls {
  get<T>(path: string, params?: Record<string, FormValue>): Promise<T>;
  post<T>(path: string, params?: Record<string, FormValue>): Promise<T>;
  put<T>(path: string, params?: Record<string, FormValue>): Promise<T>;
  delete<T>(path: string, params?: Record<string, FormValue>): Promise<T>;
  waitForTask(node: string, upid: string, opts?: { timeoutMs?: number }): Promise<boolean>;
}

/** How a test or a host waits between polls. */
export type Sleep = (ms: number) => Promise<void>;

const DEFAULT_MACHINE = "2vcpu-4gb";
/** The tag every CI VM carries, in the form Proxmox keeps tags. */
export const PVE_CI_TAG = "infrawrench-ci";
/** Where the description keeps the tags as sent. */
const TAGS_PREFIX = "infrawrench-ci-tags: ";
const CLONE_TIMEOUT_MS = 10 * 60_000;
const AGENT_TIMEOUT_MS = 5 * 60_000;

export const PROXMOX_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "VM cloned from a template",
      defaults: { machine: DEFAULT_MACHINE },
      typicalStartSeconds: 90,
      machineSuggestions: ["1vcpu-2gb", "2vcpu-4gb", "4vcpu-8gb", "8vcpu-16gb", "16vcpu-32gb"],
    },
  ],
  helpLink: {
    label: "Give the API token a role with these privileges",
    url: "https://pve.proxmox.com/wiki/User_Management#pveum_permission_management",
  },
} as const satisfies CiExecutorDeclaration;

/** Privileges a CI job needs, with what each is for. */
export const CI_PRIVILEGES = [
  { permission: "VM.Clone", label: "Clone the template" },
  { permission: "VM.Allocate", label: "Create the job's VM and destroy it after" },
  { permission: "VM.Config.CPU", label: "Size its CPUs" },
  { permission: "VM.Config.Memory", label: "Size its memory" },
  { permission: "VM.Config.Options", label: "Tag it as a CI job's" },
  { permission: "VM.PowerMgmt", label: "Start and stop it" },
  { permission: "VM.Audit", label: "Follow it and find leftovers" },
  { permission: "Datastore.AllocateSpace", label: "Give it a disk" },
  { permission: "SDN.Use", label: "Attach it to the template's network bridge" },
] as const satisfies readonly CiMissingPermission[];

const AGENT_PRIVILEGE = {
  permission: "VM.GuestAgent.Unrestricted",
  label: "Run the job through the guest agent (VM.Monitor on Proxmox VE 8)",
} as const satisfies CiMissingPermission;

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") {
    throw new Error(
      `Proxmox VE runs CI jobs of kind \`vm\` only: its API cannot run a command in a container, so \`${kind}\` is not offered.`,
    );
  }
}

/** `2vcpu-4gb` and the like as whole cores and MiB; null when it is not that shape. */
export function parseMachine(machine: string): { cores: number; memory: number } | null {
  const size = parseCiContainerSize(machine);
  if (!size || !Number.isInteger(size.vcpus)) return null;
  return { cores: size.vcpus, memory: Math.round(size.memoryGb * 1024) };
}

/** A DNS name for the VM, from the CI job's id: the same id, the same name. */
export function vmName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/** The description that keeps the tags as sent. */
export function describeTags(tags: Readonly<Record<string, string>>): string {
  return `Infrawrench CI job. Destroyed when the job ends.\n${TAGS_PREFIX}${JSON.stringify(tags)}`;
}

/** The tags a VM's description kept; the CI tag alone when it kept none. */
export function tagsOf(description: string | undefined): Record<string, string> {
  const line = description?.split("\n").find((l) => l.startsWith(TAGS_PREFIX));
  if (line) {
    try {
      const parsed = JSON.parse(line.slice(TAGS_PREFIX.length)) as unknown;
      if (parsed && typeof parsed === "object") {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        );
      }
    } catch {
      // Fall through.
    }
  }
  return {};
}

/**
 * What the guest agent runs: the bootstrap (on standard input) written to a
 * file, then run detached behind a power-off timer, and a power-off after it.
 */
export function agentCommand(maxSeconds: number): string[] {
  const minutes = Math.max(1, Math.ceil(maxSeconds / 60));
  const run = [
    `shutdown -h +${minutes} >/dev/null 2>&1 || true`,
    "sh /run/iwci-bootstrap.sh",
    "shutdown -h now",
  ].join("; ");
  return [
    "/bin/sh",
    "-c",
    `umask 077; cat > /run/iwci-bootstrap.sh && (setsid sh -c ${ciShellQuote(run)} > /var/log/iwci-bootstrap.log 2>&1 < /dev/null &)`,
  ];
}

const seg = encodeURIComponent;

function hasTag(r: PveClusterResource): boolean {
  return (r.tags ?? "").split(/[;,\s]+/).some((t) => t.toLowerCase() === PVE_CI_TAG);
}

async function guests(api: PveCalls): Promise<PveClusterResource[]> {
  const all = (await api.get<PveClusterResource[]>("/cluster/resources", { type: "vm" })) ?? [];
  return all.filter((r) => r.type === "qemu");
}

/** The template a pipeline named, by VMID or by name. */
export function findTemplate(all: PveClusterResource[], image: string): PveClusterResource {
  const wanted = image.trim();
  const templates = all.filter((r) => r.template === 1 || r.template === true);
  const byId = templates.filter((t) => String(t.vmid) === wanted);
  const match = byId.length > 0 ? byId : templates.filter((t) => t.name === wanted);
  if (match.length === 1 && match[0]?.vmid !== undefined && match[0].node) return match[0];
  if (match.length > 1) {
    throw new Error(
      `More than one template is named ${wanted}; name it by VMID in \`cloud.image\` (${match.map((t) => t.vmid).join(", ")}).`,
    );
  }
  const names = templates.map((t) => `${t.vmid}${t.name ? ` (${t.name})` : ""}`).slice(0, 10);
  throw new Error(
    `No VM template ${wanted} on this cluster.${names.length ? ` Templates: ${names.join(", ")}.` : ""}`,
  );
}

function handleOf(node: string, vmid: number, name: string): CiHandle {
  return {
    id: String(vmid),
    region: node,
    label: `proxmox vm ${vmid} ${name} on ${node}`,
    data: { node, vmid: String(vmid), name },
  };
}

function whereOf(handle: CiHandle): { node: string; vmid: string } {
  return {
    node: handle.data?.["node"] ?? handle.region ?? "",
    vmid: handle.data?.["vmid"] ?? handle.id,
  };
}

function isGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: unknown } | null)?.status;
  return status === 404 || /does not exist|no such VM|not found/i.test(msg);
}

export async function ciPreflight(api: PveCalls, kind: CiExecutorKind): Promise<CiPreflightResult> {
  requireVm(kind);
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  let perms: Record<string, Record<string, number | boolean>> = {};
  try {
    perms = (await api.get<typeof perms>("/access/permissions")) ?? {};
  } catch (err) {
    problems.push(
      `Proxmox VE did not say what this token may do: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Held on `/`, `/vms`, a VM, a pool or a storage: a broad approximation,
  // since a pipeline may name any template.
  const held = new Set<string>();
  for (const [path, privs] of Object.entries(perms)) {
    if (!/^\/($|vms|pool|storage|sdn)/.test(path)) continue;
    for (const [priv, on] of Object.entries(privs ?? {})) if (on !== 0) held.add(priv);
  }
  if (problems.length === 0) {
    for (const p of CI_PRIVILEGES) if (!held.has(p.permission)) missing.push(p);
    if (!held.has("VM.GuestAgent.Unrestricted") && !held.has("VM.Monitor")) {
      missing.push(AGENT_PRIVILEGE);
    }
  }
  try {
    const all = await guests(api);
    if (!all.some((r) => r.template === 1 || r.template === true)) {
      problems.push(
        "There is no VM template on this cluster. Make one with the QEMU guest agent installed and enabled (Options, QEMU Guest Agent), then name it in `cloud.image`.",
      );
    }
  } catch {
    // The privileges above already say whether it may look.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems };
}

export async function ciStart(
  api: PveCalls,
  spec: CiStartSpec,
  sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu) {
    throw new Error("A Proxmox VE CI job gets the template's devices; `cloud.gpu` is not offered.");
  }
  if (!spec.image) {
    throw new Error("Name the VM template to clone in `cloud.image` (its VMID or its name).");
  }
  const machine = spec.machine ?? DEFAULT_MACHINE;
  const size = parseMachine(machine);
  if (!size) {
    throw new Error(
      `\`cloud.machine\` for a Proxmox VE job is whole vCPUs and memory, like ${DEFAULT_MACHINE}, not ${machine}.`,
    );
  }
  const name = vmName(spec);
  const all = await guests(api);
  // A retry after a lost answer finds the VM it already made.
  const existing = all.find((r) => r.name === name && hasTag(r));
  if (existing?.vmid !== undefined && existing.node) {
    const config = await api.get<{ description?: string }>(
      `/nodes/${seg(existing.node)}/qemu/${existing.vmid}/config`,
    );
    if (tagsOf(config?.description)[CI_JOB_TAG] === spec.tags[CI_JOB_TAG]) {
      return handleOf(existing.node, existing.vmid, name);
    }
  }
  const template = findTemplate(all, spec.image);
  const node = spec.region ?? template.node!;
  const newid = Number(await api.get<number | string>("/cluster/nextid"));
  const upid = await api.post<string>(`/nodes/${seg(template.node!)}/qemu/${template.vmid}/clone`, {
    newid,
    name,
    description: describeTags(spec.tags),
    ...(node !== template.node ? { target: node } : {}),
  });
  const handle = handleOf(node, newid, name);
  try {
    if (!(await api.waitForTask(template.node!, upid, { timeoutMs: CLONE_TIMEOUT_MS }))) {
      throw new Error(`Cloning template ${template.vmid} did not finish in 10 minutes.`);
    }
    const vm = `/nodes/${seg(node)}/qemu/${newid}`;
    await api.put(`${vm}/config`, {
      cores: size.cores,
      memory: size.memory,
      agent: "1",
      tags: PVE_CI_TAG,
      description: describeTags(spec.tags),
    });
    const started = await api.post<string>(`${vm}/status/start`);
    if (started) await api.waitForTask(node, started, { timeoutMs: 120_000 });
    const deadline = Date.now() + AGENT_TIMEOUT_MS;
    for (;;) {
      try {
        await api.post(`${vm}/agent/ping`);
        break;
      } catch (err) {
        if (Date.now() >= deadline) {
          throw new Error(
            `The VM's QEMU guest agent did not answer in 5 minutes. Install and enable qemu-guest-agent in template ${template.vmid}.`,
            { cause: err },
          );
        }
        await sleep(5_000);
      }
    }
    await api.post(`${vm}/agent/exec`, {
      command: agentCommand(spec.maxSeconds),
      "input-data": spec.bootstrap,
    });
  } catch (err) {
    // Nothing half-started outlives a failed start.
    await ciTeardown(api, handle).catch(() => undefined);
    throw err;
  }
  return handle;
}

export async function ciStatus(api: PveCalls, handle: CiHandle): Promise<CiComputeStatus> {
  const { node, vmid } = whereOf(handle);
  let current: { status?: string; lock?: string; qmpstatus?: string };
  try {
    current = await api.get(`/nodes/${seg(node)}/qemu/${seg(vmid)}/status/current`);
  } catch (err) {
    if (isGone(err)) return { state: "gone" };
    throw err;
  }
  if (current?.lock === "clone" || current?.lock === "create") return { state: "starting" };
  if (current?.status === "running") return { state: "running" };
  return current?.qmpstatus
    ? { state: "stopped", detail: current.qmpstatus }
    : { state: "stopped" };
}

export async function ciTeardown(api: PveCalls, handle: CiHandle): Promise<void> {
  const { node, vmid } = whereOf(handle);
  const vm = `/nodes/${seg(node)}/qemu/${seg(vmid)}`;
  try {
    const current = await api.get<{ status?: string }>(`${vm}/status/current`);
    if (current?.status === "running") {
      const upid = await api.post<string>(`${vm}/status/stop`, { timeout: 30 });
      if (upid) await api.waitForTask(node, upid, { timeoutMs: 120_000 });
    }
    const upid = await api.delete<string>(vm, { purge: 1, "destroy-unreferenced-disks": 1 });
    if (upid) await api.waitForTask(node, upid, { timeoutMs: 300_000 });
  } catch (err) {
    if (isGone(err)) return;
    throw err;
  }
}

export async function ciListTagged(api: PveCalls, tagKey: string): Promise<CiTaggedCompute[]> {
  if (tagKey !== CI_TAG && tagKey.toLowerCase() !== PVE_CI_TAG) return [];
  const out: CiTaggedCompute[] = [];
  for (const r of await guests(api)) {
    if (!hasTag(r) || r.vmid === undefined || !r.node || r.template) continue;
    const config = await api
      .get<{ description?: string }>(`/nodes/${seg(r.node)}/qemu/${r.vmid}/config`)
      .catch(() => undefined);
    const tags = tagsOf(config?.description);
    out.push({
      handle: handleOf(r.node, r.vmid, r.name ?? String(r.vmid)),
      tags: Object.keys(tags).length > 0 ? tags : { [CI_TAG]: "" },
      live: r.status === "running" || r.lock === "clone",
    });
  }
  return out;
}
