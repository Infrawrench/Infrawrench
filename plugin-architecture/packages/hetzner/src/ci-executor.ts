/**
 * CI jobs on Hetzner Cloud: one fresh server per job, started with the
 * host's bootstrap as its cloud-init user data and deleted when the job ends.
 *
 * **Wire shapes verified against Hetzner's Cloud OpenAPI document
 * (`docs.hetzner.cloud/cloud.spec.json`, the one `plugingen.json` names) and
 * docs, November 2026:**
 * - `POST /servers`: `name` (unique per project, an RFC 1123 hostname),
 *   `server_type`, `image` (`ubuntu-24.04`), `location`, `user_data`
 *   (cloud-init, at most 32 KiB), `labels`, `ssh_keys` (ids or names),
 *   `public_net.{enable_ipv4, ipv4, enable_ipv6}`, `start_after_create`.
 * - `GET /servers?label_selector=` (`k`, `k==v`), `GET`/`DELETE
 *   /servers/{id}`; `status` is `running`, `initializing`, `starting`,
 *   `stopping`, `off`, `deleting`, `migrating`, `rebuilding` or `unknown`.
 * - `POST /primary_ips` `{name, type, location, auto_delete, labels}`:
 *   with `auto_delete` the address goes when its server does. Deleting a
 *   server only detaches the Primary IPs it was given otherwise.
 * - `POST /ssh_keys` `{name, public_key, labels}`, `DELETE /ssh_keys/{id}`.
 * - Labels: keys and values at most 63 characters, starting and ending with
 *   a letter or digit, with `-`, `_` and `.` between. Tag values are
 *   encoded to fit and decoded on the way back (`ciEncodeTagValue`).
 * - Tokens are Read or Read & Write per project; a read-only token answers
 *   `403 forbidden` to a write.
 * - Billing: by the hour, rounded up ("a server created for a few minutes is
 *   billed one whole hour"), until the server is deleted, whatever its state.
 *
 * **No credentials on the machine.** The server gets user data and a
 * throwaway SSH key whose private half is never kept (so no root password
 * is generated for it); the key object is deleted as soon as the server is
 * made.
 *
 * **Backstop.** The user data powers the server off at the job's deadline.
 * A powered-off server is still billed, and the machine holds nothing that
 * could delete it, so billing stops only when the host tears it down or its
 * reaper finds it by label.
 *
 * **Preflight.** A token cannot tell what it may do, so the check reads the
 * project and sends a delete of an SSH key id that does not exist: `403`
 * means a read-only token, `404` a Read & Write one.
 */
import {
  CI_JOB_TAG,
  ciCloudInitScript,
  ciDecodeTagValue,
  ciEncodeTagValue,
  ciHttpStatus,
  ciMachineName,
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
import { pathEncode } from "@infrawrench/plugin-base";

import type { CloudApi } from "./api.js";

export const CI_DEFAULT_MACHINE = "cpx22";
export const CI_DEFAULT_IMAGE = "ubuntu-24.04";
export const CI_DEFAULT_REGION = "fsn1";

export const HETZNER_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Cloud server",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      typicalStartSeconds: 45,
      // Billed by the hour, rounded up.
      minimumBillingSeconds: 3600,
      machineSuggestions: ["cpx22", "cpx32", "cpx42", "cx23", "cx33", "cax11", "cax21", "ccx13"],
    },
  ],
  helpLink: {
    label: "Make a Read & Write API token in the project",
    url: "https://console.hetzner.com/projects",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  write: {
    permission: "Read & Write",
    label: "Create, label and delete the job's server, its address and its SSH key",
  },
  read: { permission: "Read", label: "Follow the job's server and find leftovers" },
} as const satisfies Record<string, CiMissingPermission>;

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`Hetzner Cloud runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

/** The job's tags as labels: keys as they are, values encoded to fit. */
export function labelsOf(tags: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) out[key] = ciEncodeTagValue(value);
  return out;
}

function tagsOf(labels: Readonly<Record<string, string>> | null | undefined, tagKey: string) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (key === tagKey || key.startsWith("infrawrench-ci")) out[key] = ciDecodeTagValue(value);
  }
  return out;
}

export async function hetznerCiPreflight(
  api: CloudApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const where = region ?? CI_DEFAULT_REGION;
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  try {
    await api.get("/servers", { query: { per_page: 1 } });
  } catch (err) {
    if (ciHttpStatus(err) === 403) missing.push(CI_PERMISSIONS.read);
    else problems.push(`Hetzner Cloud refused a read: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await api.delete(`/ssh_keys/${pathEncode(0)}`);
  } catch (err) {
    if (ciHttpStatus(err) === 403) missing.push(CI_PERMISSIONS.write);
  }
  try {
    const { locations } = await api.get("/locations", { query: { name: where } });
    if (locations.length === 0) {
      problems.push(
        `Hetzner Cloud has no location \`${where}\`. Name one such as fsn1, nbg1, hel1, ash, hil or sin.`,
      );
    }
  } catch {
    // Not being able to look is no reason to refuse: the start says so.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

interface Server {
  id: number;
  name?: string;
  status?: string;
  created?: string;
  labels?: Record<string, string>;
  datacenter?: { location?: { name?: string } } | null;
  public_net?: { ipv4?: { id?: number | null } | null } | null;
}

function serverHandle(server: Server, location: string, primaryIp?: number): CiHandle {
  return {
    id: String(server.id),
    region: location,
    label: `hetzner server ${server.id} (${location})`,
    data: {
      kind: "server",
      ...(primaryIp !== undefined ? { primaryIp: String(primaryIp) } : {}),
    },
  };
}

function locationOf(server: Server, fallback: string): string {
  return server.datacenter?.location?.name ?? fallback;
}

async function findServer(api: CloudApi, spec: CiStartSpec): Promise<Server | undefined> {
  const job = spec.tags[CI_JOB_TAG];
  const { servers } = await api.get("/servers", {
    query: job
      ? { label_selector: `${CI_JOB_TAG}==${ciEncodeTagValue(job)}` }
      : { name: ciMachineName(spec) },
  });
  return (servers as Server[]).find((s) => s.status !== "deleting");
}

/** The job's own IPv4 Primary IP, made with `auto_delete` so it goes with the server. */
async function ensurePrimaryIp(api: CloudApi, spec: CiStartSpec, location: string) {
  const name = ciMachineName(spec);
  const { primary_ips } = await api.get("/primary_ips", { query: { name } });
  const found = primary_ips[0];
  if (found) return found.id;
  const { primary_ip } = await api.post("/primary_ips", {
    body: { name, type: "ipv4", location, auto_delete: true, labels: labelsOf(spec.tags) },
  });
  return primary_ip.id;
}

async function ensureSshKey(api: CloudApi, spec: CiStartSpec): Promise<number> {
  const name = ciMachineName(spec);
  const { ssh_keys } = await api.get("/ssh_keys", { query: { name } });
  const found = ssh_keys[0];
  if (found) return found.id;
  const { ssh_key } = await api.post("/ssh_keys", {
    body: { name, public_key: await ciThrowawaySshKey(name), labels: labelsOf(spec.tags) },
  });
  return ssh_key.id;
}

async function quietly(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best effort: what is left is labelled, so the reaper finds it.
  }
}

/** The create body for a job. */
export function serverBody(spec: CiStartSpec, sshKey: number, primaryIp: number) {
  return {
    name: ciMachineName(spec),
    server_type: spec.machine ?? CI_DEFAULT_MACHINE,
    image: spec.image ?? CI_DEFAULT_IMAGE,
    location: spec.region ?? CI_DEFAULT_REGION,
    user_data: ciCloudInitScript(spec.bootstrap, spec.maxSeconds),
    labels: labelsOf(spec.tags),
    ssh_keys: [sshKey],
    public_net: { enable_ipv4: true, ipv4: primaryIp, enable_ipv6: false },
    start_after_create: true,
  };
}

export async function hetznerCiStart(api: CloudApi, spec: CiStartSpec): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu)
    throw new Error("Hetzner Cloud servers have no GPUs to attach; leave `cloud.gpu` out.");
  const location = spec.region ?? CI_DEFAULT_REGION;
  // The job's label makes a start idempotent: a retry finds what the first made.
  const found = await findServer(api, spec);
  if (found) {
    return serverHandle(
      found,
      locationOf(found, location),
      found.public_net?.ipv4?.id ?? undefined,
    );
  }
  const primaryIp = await ensurePrimaryIp(api, spec, location);
  const sshKey = await ensureSshKey(api, spec);
  try {
    const { server } = await api.post("/servers", { body: serverBody(spec, sshKey, primaryIp) });
    return serverHandle(server, locationOf(server, location), primaryIp);
  } catch (err) {
    if (ciHttpStatus(err) === 409) {
      const raced = await findServer(api, spec);
      if (raced) return serverHandle(raced, locationOf(raced, location), primaryIp);
    }
    await quietly(() => api.delete(`/primary_ips/${pathEncode(primaryIp)}`));
    throw err;
  } finally {
    // The server has its copy of the key; the project needs none.
    await quietly(() => api.delete(`/ssh_keys/${pathEncode(sshKey)}`));
  }
}

export async function hetznerCiStatus(api: CloudApi, handle: CiHandle): Promise<CiComputeStatus> {
  if (handle.data?.["kind"] === "primary-ip")
    return { state: "stopped", detail: "unassigned address" };
  let server: Server;
  try {
    ({ server } = await api.get(`/servers/${pathEncode(Number(handle.id))}`));
  } catch (err) {
    if (ciHttpStatus(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = server.status ?? "";
  const state: CiComputeStatus["state"] =
    status === "initializing" || status === "starting"
      ? "starting"
      : status === "running" || status === "migrating" || status === "rebuilding"
        ? "running"
        : status === "deleting"
          ? "gone"
          : "stopped";
  return { state, detail: status };
}

async function deleteIgnoringMissing(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

export async function hetznerCiTeardown(api: CloudApi, handle: CiHandle): Promise<void> {
  if (handle.data?.["kind"] === "primary-ip") {
    await deleteIgnoringMissing(() => api.delete(`/primary_ips/${pathEncode(Number(handle.id))}`));
    return;
  }
  await deleteIgnoringMissing(() => api.delete(`/servers/${pathEncode(Number(handle.id))}`));
  // `auto_delete` removes the address with the server; this covers one that
  // outlived a server some other way. While the delete is still running the
  // address is assigned and refuses, and `auto_delete` takes it then.
  const ip = handle.data?.["primaryIp"];
  if (ip) await quietly(() => api.delete(`/primary_ips/${pathEncode(Number(ip))}`));
}

/**
 * Every server labelled for CI, and every labelled address no server holds
 * (left by a start that failed between the two). Labels are project-wide, so
 * `regions` does not narrow it.
 */
export async function hetznerCiListTagged(
  api: CloudApi,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  const servers = (await api.getAll("/servers", "servers", {
    query: { label_selector: tagKey },
  })) as Server[];
  for (const server of servers) {
    const status = server.status ?? "";
    if (status === "deleting") continue;
    const location = locationOf(server, "");
    out.push({
      handle: serverHandle(server, location, server.public_net?.ipv4?.id ?? undefined),
      tags: tagsOf(server.labels, tagKey),
      ...(server.created ? { createdAt: server.created } : {}),
      live: status !== "off" && status !== "stopping",
    });
  }
  const ips = await api.getAll("/primary_ips", "primary_ips", {
    query: { label_selector: tagKey },
  });
  for (const ip of ips) {
    if (ip.assignee_id != null) continue;
    const location = ip.location?.name ?? "";
    out.push({
      handle: {
        id: String(ip.id),
        region: location,
        label: `hetzner primary ip ${ip.ip} (${location})`,
        data: { kind: "primary-ip" },
      },
      tags: tagsOf(ip.labels, tagKey),
      ...(ip.created ? { createdAt: ip.created } : {}),
      live: false,
    });
  }
  return out;
}
