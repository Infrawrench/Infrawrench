/**
 * CI jobs on UpCloud: one fresh Cloud Server per job, cloned from the Ubuntu
 * 24.04 cloud-init template with the host's bootstrap as its user data, and
 * deleted with its disk when the job ends.
 *
 * **Wire shapes verified against UpCloud's API 1.3 reference
 * (`developers.upcloud.com/1.3`) and docs, November 2026:**
 * - `POST /1.3/server` `{server: {...}}`: `zone`, `title`, `hostname`,
 *   `plan`, `metadata: "yes"` (a cloud-init template refuses `no`),
 *   `user_data` (a shell script, plain text), `login_user.ssh_keys` (a
 *   cloud-init template needs at least one key and takes no password),
 *   `password_delivery: "none"`, `simple_backup: "no"`, `labels.label[]`
 *   (`key` 2 to 32 printable ASCII, not starting with `_`; `value` up to
 *   255), `storage_devices.storage_device[]` (`action: "clone"`, `storage`:
 *   a template's UUID, `size`, `title`), `networking.interfaces.interface[]`.
 * - `GET /1.3/storage/template`: templates with `title` and `template_type`
 *   (`cloud-init`).
 * - `GET /1.3/server?label=key%3Dvalue` and `GET /1.3/server/{uuid}`;
 *   `state` is `started`, `stopped`, `maintenance` or `error`. Neither
 *   answer has a creation time, so the start writes one in a label.
 * - A server is stopped before it is deleted: `POST
 *   /1.3/server/{uuid}/stop` `{stop_server: {stop_type: "hard"}}`, then
 *   `DELETE /1.3/server/{uuid}?storages=1&backups=delete`, which takes its
 *   disks and their backups. `404 SERVER_NOT_FOUND` once it is gone.
 * - API tokens carry no permissions of their own; a sub-account's come from
 *   the main account. Neither can be read back in a form that says whether
 *   a server may be created, so the preflight reads the account, the
 *   servers and the zone.
 * - Billing: by the hour (capped at 672 hours a month). Cloud Native plans
 *   bill compute only while the server is started; Starter and Premium bill
 *   while it is stopped too. Storage is billed until it is deleted.
 *
 * **No credentials on the machine.** The server gets user data and a
 * throwaway SSH key whose private half is never kept; no token or account
 * password, and no password is delivered.
 *
 * **Backstop.** The user data powers the server off at the job's deadline.
 * On the default Cloud Native plan that stops the compute bill; the disk
 * (and a Starter or Premium plan's compute) is billed until the host tears
 * it down or its reaper finds it by label. The machine holds nothing that
 * could delete itself.
 */
import {
  CI_JOB_TAG,
  ciCloudInitScript,
  ciHttpStatus,
  ciMachineName,
  ciThrowawaySshKey,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { unwrap, unwrapList, type UpCloudApi } from "./api.js";

export const CI_DEFAULT_MACHINE = "CLOUDNATIVE-2xCPU-4GB";
export const CI_DEFAULT_IMAGE = "Ubuntu Server 24.04 LTS";
export const CI_DEFAULT_REGION = "de-fra1";
const DISK_GB = 30;
/** When the start made it, since UpCloud keeps no creation time. Not one of the job's tags. */
const CREATED_LABEL = "iwci-created";

export const UPCLOUD_CI_EXECUTOR = {
  kinds: [
    {
      kind: "vm",
      label: "Cloud Server",
      defaults: { machine: CI_DEFAULT_MACHINE, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      typicalStartSeconds: 60,
      // Billed by the hour.
      minimumBillingSeconds: 3600,
      machineSuggestions: [
        "CLOUDNATIVE-1xCPU-4GB",
        "CLOUDNATIVE-2xCPU-4GB",
        "CLOUDNATIVE-2xCPU-8GB",
        "CLOUDNATIVE-4xCPU-8GB",
        "CLOUDNATIVE-4xCPU-16GB",
        "STARTER-2xCPU-4GB",
        "PREMIUM-2xCPU-4GB",
        "PREMIUM-4xCPU-8GB",
      ],
    },
  ],
  helpLink: {
    label: "Check the API user's permissions",
    url: "https://hub.upcloud.com/people",
  },
} as const satisfies CiExecutorDeclaration;

type Json = Record<string, unknown>;

interface Label {
  key?: string;
  value?: string;
}

interface Server {
  uuid?: string;
  state?: string;
  zone?: string;
  title?: string;
  hostname?: string;
  labels?: { label?: Label[] | null } | null;
}

function requireVm(kind: CiExecutorKind): void {
  if (kind !== "vm") throw new Error(`UpCloud runs CI jobs of kind \`vm\`, not \`${kind}\`.`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface UpCloudCiOptions {
  /** Waits between polls while a server stops; a test passes one that does not. */
  sleep?(ms: number): Promise<void>;
  now?(): Date;
}

export async function upcloudCiPreflight(
  api: UpCloudApi,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireVm(kind);
  const where = region ?? CI_DEFAULT_REGION;
  const problems: string[] = [];
  const say = (err: unknown) => (err instanceof Error ? err.message : String(err));
  try {
    await api.get("/account");
  } catch (err) {
    problems.push(`UpCloud refused a read of the account: ${say(err)}`);
  }
  try {
    await api.get("/server");
  } catch (err) {
    problems.push(`UpCloud refused a list of servers: ${say(err)}`);
  }
  try {
    const zones = unwrap<Json>(await api.get("/zone"), "zones", "zone");
    if (zones.length > 0 && !zones.some((z) => z["id"] === where)) {
      problems.push(
        `UpCloud has no zone \`${where}\`. Name one such as de-fra1, fi-hel1 or us-nyc1.`,
      );
    }
  } catch {
    // Not being able to look is no reason to refuse: the start says so.
  }
  try {
    if (!(await template(api, CI_DEFAULT_IMAGE))) {
      problems.push(`UpCloud offers no ${CI_DEFAULT_IMAGE} cloud-init template to this account.`);
    }
  } catch {
    // The start says so.
  }
  return { ok: problems.length === 0, missing: [], problems, region: where };
}

/** A template's UUID: the image itself when it is one, else the cloud-init template whose title starts with it. */
async function template(api: UpCloudApi, image: string): Promise<string | undefined> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(image)) return image;
  const templates = unwrap<Json>(await api.get("/storage/template"), "storages", "storage");
  const found = templates.find(
    (t) =>
      typeof t["title"] === "string" &&
      t["title"].toLowerCase().startsWith(image.toLowerCase()) &&
      (t["template_type"] === undefined || t["template_type"] === "cloud-init"),
  );
  return typeof found?.["uuid"] === "string" ? found["uuid"] : undefined;
}

function labelList(tags: Readonly<Record<string, string>>, created: string): Label[] {
  return [
    ...Object.entries(tags).map(([key, value]) => ({ key, value: value.slice(0, 255) })),
    { key: CREATED_LABEL, value: created },
  ];
}

function labelsOf(server: Server): Record<string, string> {
  const out: Record<string, string> = {};
  for (const label of server.labels?.label ?? []) {
    if (label.key) out[label.key] = label.value ?? "";
  }
  return out;
}

/** The create body for a job, given the template's UUID. */
export async function serverBody(spec: CiStartSpec, templateUuid: string, created: string) {
  const name = ciMachineName(spec);
  return {
    server: {
      zone: spec.region ?? CI_DEFAULT_REGION,
      title: spec.name.slice(0, 255),
      hostname: name,
      plan: spec.machine ?? CI_DEFAULT_MACHINE,
      metadata: "yes",
      user_data: ciCloudInitScript(spec.bootstrap, spec.maxSeconds),
      login_user: {
        username: "root",
        ssh_keys: { ssh_key: [await ciThrowawaySshKey(name)] },
      },
      password_delivery: "none",
      simple_backup: "no",
      labels: { label: labelList(spec.tags, created) },
      storage_devices: {
        storage_device: [
          {
            action: "clone",
            storage: templateUuid,
            title: `${name}-disk`,
            size: DISK_GB,
          },
        ],
      },
      networking: {
        interfaces: {
          interface: [
            { type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
            { type: "utility", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
          ],
        },
      },
    },
  };
}

function handleOf(server: Server, zone: string): CiHandle {
  const id = server.uuid ?? "";
  return { id, region: zone, label: `upcloud server ${id} (${zone})` };
}

/** Servers carrying `key=value`, or every server (a key alone is not a documented filter). */
async function serversLabelled(api: UpCloudApi, key?: string, value?: string): Promise<Server[]> {
  const path =
    key === undefined ? "/server" : `/server?label=${encodeURIComponent(`${key}=${value ?? ""}`)}`;
  return unwrapList<Server>(await api.get(path), "servers", "server", "/server");
}

export async function upcloudCiStart(
  api: UpCloudApi,
  spec: CiStartSpec,
  options: UpCloudCiOptions = {},
): Promise<CiHandle> {
  requireVm(spec.kind);
  if (spec.gpu) {
    throw new Error(
      "On UpCloud a GPU comes with the plan: name a GPU plan in `cloud.machine` and leave `cloud.gpu` out.",
    );
  }
  const zone = spec.region ?? CI_DEFAULT_REGION;
  const name = ciMachineName(spec);
  // The job's label makes a start idempotent: a retry finds the first start's server.
  const job = spec.tags[CI_JOB_TAG];
  const found = (job ? await serversLabelled(api, CI_JOB_TAG, job) : []).find(
    (s) => labelsOf(s)[CI_JOB_TAG] === job || s.hostname === name,
  );
  if (found?.uuid) return handleOf(found, found.zone ?? zone);
  const uuid = await template(api, spec.image ?? CI_DEFAULT_IMAGE);
  if (!uuid)
    throw new Error(`UpCloud has no cloud-init template \`${spec.image ?? CI_DEFAULT_IMAGE}\`.`);
  const created = (options.now?.() ?? new Date()).toISOString();
  const { server } = await api.send<{ server?: Server }>(
    "POST",
    "/server",
    await serverBody(spec, uuid, created),
  );
  if (!server?.uuid) throw new Error("UpCloud created no server");
  return handleOf(server, server.zone ?? zone);
}

async function getServer(api: UpCloudApi, uuid: string): Promise<Server | undefined> {
  try {
    const { server } = await api.get<{ server?: Server }>(`/server/${encodeURIComponent(uuid)}`);
    return server;
  } catch (err) {
    if (ciHttpStatus(err) === 404) return undefined;
    throw err;
  }
}

export async function upcloudCiStatus(api: UpCloudApi, handle: CiHandle): Promise<CiComputeStatus> {
  const server = await getServer(api, handle.id);
  if (!server) return { state: "gone" };
  const status = server.state ?? "";
  const state: CiComputeStatus["state"] =
    status === "maintenance" ? "starting" : status === "stopped" ? "stopped" : "running";
  return { state, detail: status };
}

export async function upcloudCiTeardown(
  api: UpCloudApi,
  handle: CiHandle,
  options: UpCloudCiOptions = {},
): Promise<void> {
  const wait = options.sleep ?? sleep;
  const path = `/server/${encodeURIComponent(handle.id)}`;
  let server = await getServer(api, handle.id);
  if (!server) return;
  if (server.state === "started" || server.state === "error") {
    try {
      await api.send("POST", `${path}/stop`, { stop_server: { stop_type: "hard" } });
    } catch (err) {
      if (ciHttpStatus(err) === 404) return;
      // Already stopping: the poll below waits for it.
      if (ciHttpStatus(err) !== 409) throw err;
    }
  }
  // A hard stop takes seconds. A server still being made (`maintenance`)
  // cannot be stopped yet; the host retries the teardown on its next pass.
  for (let attempt = 0; attempt < 12 && server?.state !== "stopped"; attempt++) {
    await wait(5_000);
    server = await getServer(api, handle.id);
    if (!server) return;
  }
  if (server?.state !== "stopped") {
    throw new Error(
      `UpCloud server ${handle.id} is ${server?.state ?? "busy"}; it is removed once it stops.`,
    );
  }
  try {
    await api.send("DELETE", `${path}?storages=1&backups=delete`);
  } catch (err) {
    if (ciHttpStatus(err) !== 404) throw err;
  }
}

/** Every server labelled for CI. Servers are listed account-wide, so `regions` does not narrow it. */
export async function upcloudCiListTagged(
  api: UpCloudApi,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  for (const server of await serversLabelled(api)) {
    const labels = labelsOf(server);
    if (!(tagKey in labels) || !server.uuid) continue;
    const created = labels[CREATED_LABEL];
    delete labels[CREATED_LABEL];
    out.push({
      handle: handleOf(server, server.zone ?? ""),
      tags: labels,
      ...(created ? { createdAt: created } : {}),
      live: server.state !== "stopped",
    });
  }
  return out;
}
