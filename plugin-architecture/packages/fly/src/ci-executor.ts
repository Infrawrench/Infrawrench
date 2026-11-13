/**
 * CI jobs on Fly.io: one Machine per job, in an app of its own, that destroys
 * itself when the job ends.
 *
 * **Kind.** A Machine is a Firecracker microVM, but what it boots is an OCI
 * image whose entrypoint Fly's init runs as the main process: no OS image, no
 * cloud-init, no package of its own to run. That is a container in the terms
 * of this contract (`cloud.image` is a container image), so the kind is
 * `container`, and the job's main process is `ciContainerCommand`'s watchdog
 * around the bootstrap.
 *
 * **One app per job, on its own network.** Every Machine lives in an app, and
 * the apps of an organization share a private network unless an app is
 * created with `network`, which "places the app on its own segmented network"
 * where its Machines cannot reach the organization's other apps. So each job
 * gets an app named `ciMachineName(spec)` (`iwci-` and the job's key; app names
 * are unique across Fly) on a network of the same name: the job reaches the
 * internet, not the organization's apps and not other jobs. Deleting the app
 * is the teardown's last step. An app costs nothing without Machines and gets
 * no public IP (none is allocated), so nothing reaches into the job.
 *
 * **Wire shapes verified against the Machines API reference
 * (docs.fly.io/machines/api, the `docs.machines.dev/openapi.json` document
 * `plugingen.json` names), November 2026:**
 * - `GET /v1/apps/{app}` (404 when absent), `POST /v1/apps` `{app_name,
 *   org_slug, network}` (201), `DELETE /v1/apps/{app}` (202), `GET
 *   /v1/apps?org_slug=&cursor=` answering `{apps, next_cursor}`.
 * - `POST /v1/apps/{app}/machines` `{name, region, config}`; `config` with
 *   `image`, `init.{entrypoint, cmd}`, `guest.{cpu_kind, cpus, memory_mb}`
 *   (shared CPUs take 256 MB steps, 256 MB to 2 GB per CPU; performance CPUs
 *   2048 MB steps, 2 to 8 GB per CPU), `auto_destroy` ("the Machine destroys
 *   itself once it's complete"), `restart.policy: "no"` and `metadata`.
 * - `GET /v1/apps/{app}/machines?include_deleted=true` and `GET`/`DELETE
 *   /v1/apps/{app}/machines/{id}` (`force=true` stops it first). States:
 *   `created`, `creating`, `starting`, `started`, `restarting`, `updating`,
 *   `replacing`, `stopping`, `stopped`, `suspending`, `suspended`,
 *   `archived`, `failed`, `launch_failed`, `destroying`, `destroyed`.
 * - Billing (docs.fly.io/about/pricing): "by the second while they're
 *   running", no minimum stated; a stopped Machine is billed for its root
 *   file system only.
 *
 * **No credentials on the Machine.** It gets no env, no secrets and no files
 * of ours: only what Fly sets on every Machine (`FLY_APP_NAME`,
 * `FLY_MACHINE_ID`, ...). The connection's token never leaves the host.
 *
 * **Backstop.** The watchdog ends the main process at the job's deadline, and
 * `auto_destroy` with `restart: no` destroys the Machine when it does, so a
 * job that the host loses still stops being billed at its deadline. The app
 * is left empty until the host's teardown or reaper deletes it.
 *
 * **GPUs.** Fly deprecated GPU Machines, unavailable after August 1, 2026
 * (docs.fly.io/gpus), so the kind declares none and refuses `cloud.gpu`.
 *
 * **Preflight.** A Fly token cannot say what it may do, so the check lists
 * the organization's apps, a harmless read that an app-scoped deploy token is
 * refused; whether it may create an app shows only at the first start.
 */
import {
  CI_JOB_TAG,
  ciBootstrapWithTools,
  ciContainerCommand,
  ciHttpStatus,
  ciMachineName,
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

import type { FlyApi, FlyMachine, FlyMachineConfig } from "./api.js";

export const CI_DEFAULT_MACHINE = "performance-2x";
/** Ubuntu 24.04 with curl and CA certificates: what the bootstrap needs. */
export const CI_DEFAULT_IMAGE = "docker.io/library/buildpack-deps:noble-curl";
export const CI_DEFAULT_REGION = "iad";
/** The metadata key that keeps the CI tags exactly as sent. */
export const CI_TAGS_METADATA = "infrawrench-ci-tags";

export const FLY_CI_EXECUTOR = {
  kinds: [
    {
      kind: "container",
      label: "Fly Machine",
      defaults: {
        machine: CI_DEFAULT_MACHINE,
        image: CI_DEFAULT_IMAGE,
        region: CI_DEFAULT_REGION,
      },
      // Creating the app and pulling the image; Fly documents no start time.
      typicalStartSeconds: 20,
      // Billed by the second while running, no minimum documented.
      machineSuggestions: [
        "shared-cpu-2x",
        "shared-cpu-4x",
        "shared-cpu-8x",
        "performance-1x",
        "performance-2x",
        "performance-4x",
        "performance-8x",
        "performance-4x-16gb",
        "performance-16x",
      ],
    },
  ],
  helpLink: {
    label: "Make an organization token with fly tokens create org",
    url: "https://docs.fly.io/security/tokens",
  },
} as const satisfies CiExecutorDeclaration;

export const CI_PERMISSIONS = {
  org: {
    permission: "Organization token",
    label: "Create, follow and delete the job's app and Machine (an app deploy token cannot)",
  },
} as const satisfies Record<string, CiMissingPermission>;

function requireContainer(kind: CiExecutorKind): void {
  if (kind !== "container") {
    throw new Error(`Fly.io runs CI jobs of kind \`container\`, not \`${kind}\`.`);
  }
}

/**
 * `cloud.machine` as a Machine's guest: a preset name (`shared-cpu-4x`,
 * `performance-2x`) with an optional memory (`performance-4x-16gb`). Without
 * one, shared CPUs get 1 GB each and performance CPUs 2 GB each.
 */
export function guestOf(machine: string): {
  cpu_kind: "shared" | "performance";
  cpus: number;
  memory_mb: number;
} {
  const match = /^(shared-cpu|performance)-(\d+)x(?:[-_/ ](\d+(?:\.\d+)?)\s*gi?b)?$/i.exec(
    machine.trim(),
  );
  const cpus = Number(match?.[2]);
  if (!match || ![1, 2, 4, 8, 16].includes(cpus)) {
    throw new Error(
      `\`cloud.machine\` for a Fly Machine is a size such as shared-cpu-4x, performance-2x or performance-4x-16gb, not ${machine}.`,
    );
  }
  const shared = match[1]!.toLowerCase() === "shared-cpu";
  const step = shared ? 256 : 2048;
  const [min, max] = shared ? [256 * cpus, 2048 * cpus] : [2048 * cpus, 8192 * cpus];
  const memory = match[3] ? Math.round(Number(match[3]) * 1024) : (shared ? 1024 : 2048) * cpus;
  if (memory % step !== 0 || memory < min || memory > max) {
    throw new Error(
      `A ${match[1]}-${cpus}x Fly Machine takes ${min / 1024} to ${max / 1024} GB in steps of ${step} MB, not ${machine}.`,
    );
  }
  return { cpu_kind: shared ? "shared" : "performance", cpus, memory_mb: memory };
}

/** The Machine's config for a job. */
export function machineConfig(spec: CiStartSpec): FlyMachineConfig {
  const command = ciContainerCommand(ciBootstrapWithTools(spec.bootstrap), spec.maxSeconds);
  return {
    image: spec.image ?? CI_DEFAULT_IMAGE,
    init: { entrypoint: command.slice(0, 2), cmd: command.slice(2) },
    guest: guestOf(spec.machine ?? CI_DEFAULT_MACHINE),
    auto_destroy: true,
    restart: { policy: "no" },
    metadata: { ...spec.tags, [CI_TAGS_METADATA]: JSON.stringify(spec.tags) },
  };
}

function handleOf(app: string, machine: Pick<FlyMachine, "id" | "region">): CiHandle {
  const region = machine.region ?? "";
  return {
    id: machine.id,
    ...(region ? { region } : {}),
    label: `fly machine ${machine.id} (${app}${region ? `, ${region}` : ""})`,
    data: { app },
  };
}

function appOf(handle: CiHandle): string {
  const app = handle.data?.["app"];
  if (!app) throw new Error(`Fly CI handle ${handle.id} names no app`);
  return app;
}

/** The tags as sent, from the metadata that keeps them; the CI keys alone without it. */
function tagsOf(metadata: Readonly<Record<string, string>> | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(metadata?.[CI_TAGS_METADATA] ?? "") as unknown;
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      );
    }
  } catch {
    // Fall through to the keys themselves.
  }
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => key.startsWith("infrawrench-ci") && key !== CI_TAGS_METADATA,
    ),
  );
}

function isGone(err: unknown): boolean {
  return ciHttpStatus(err) === 404;
}

export async function flyCiPreflight(
  api: FlyApi,
  orgSlug: string,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireContainer(kind);
  const where = region ?? CI_DEFAULT_REGION;
  const missing: CiMissingPermission[] = [];
  const problems: string[] = [];
  try {
    await api.get("/v1/apps", { query: { org_slug: orgSlug, limit: 1 } });
  } catch (err) {
    const status = ciHttpStatus(err);
    if (status === 401 || status === 403) missing.push(CI_PERMISSIONS.org);
    else if (status === 404) {
      problems.push(
        `Fly.io has no organization \`${orgSlug}\` for this token. Check the connection's organization slug.`,
      );
    } else {
      problems.push(`Fly.io refused a read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const { regions } = await api.get("/v1/platform/regions");
    if (regions && !regions.some((r) => r.code === where)) {
      problems.push(
        `Fly.io has no region \`${where}\`. Name one such as iad, ord, lhr, fra, nrt or syd.`,
      );
    }
  } catch {
    // Not being able to look is no reason to refuse: the start says so.
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

/** The job's app, made on its own network if it is not there yet. */
async function ensureApp(api: FlyApi, orgSlug: string, app: string): Promise<void> {
  try {
    const found = await api.get(`/v1/apps/${pathEncode(app)}`);
    const owner = found.organization?.slug;
    if (owner && owner !== orgSlug) {
      throw new Error(`A Fly app named ${app} already exists and is not this CI job's.`);
    }
    return;
  } catch (err) {
    if (!isGone(err)) throw err;
  }
  await api.post("/v1/apps", { body: { app_name: app, org_slug: orgSlug, network: app } });
}

async function machinesOf(api: FlyApi, app: string): Promise<FlyMachine[]> {
  const machines = await api.get(`/v1/apps/${pathEncode(app)}/machines`, {
    query: { include_deleted: true },
  });
  return Array.isArray(machines) ? machines : [];
}

const DONE = new Set(["destroying", "destroyed", "replaced", "migrated"]);

/** The job's Machine, if a first start made one: a live one first. */
function jobMachine(machines: FlyMachine[], name: string, job: string | undefined) {
  const mine = machines.filter(
    (m) => m.name === name && (!job || m.config?.metadata?.[CI_JOB_TAG] === job),
  );
  return mine.find((m) => !DONE.has(m.state ?? "")) ?? mine[0];
}

async function quietly(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best effort: the host's teardown or reaper tries again.
  }
}

export async function flyCiStart(
  api: FlyApi,
  orgSlug: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  requireContainer(spec.kind);
  if (spec.gpu) {
    throw new Error(
      "Fly.io no longer offers GPU Machines (unavailable after August 1, 2026); leave `cloud.gpu` out.",
    );
  }
  const config = machineConfig(spec);
  const app = ciMachineName(spec);
  await ensureApp(api, orgSlug, app);
  // The job's name makes a start idempotent: a retry finds what the first made,
  // even once it has run and destroyed itself.
  const found = jobMachine(await machinesOf(api, app), app, spec.tags[CI_JOB_TAG]);
  if (found) return handleOf(app, found);
  try {
    const machine = await api.post(`/v1/apps/${pathEncode(app)}/machines`, {
      body: { name: app, region: spec.region ?? CI_DEFAULT_REGION, config },
    });
    return handleOf(app, machine);
  } catch (err) {
    const raced = jobMachine(await machinesOf(api, app).catch(() => []), app, undefined);
    if (raced) return handleOf(app, raced);
    // Nothing runs in the app: give it back rather than leave it for nobody.
    await quietly(() => api.delete(`/v1/apps/${pathEncode(app)}`));
    throw err;
  }
}

export async function flyCiStatus(api: FlyApi, handle: CiHandle): Promise<CiComputeStatus> {
  let machine: FlyMachine;
  try {
    machine = await api.get(
      `/v1/apps/${pathEncode(appOf(handle))}/machines/${pathEncode(handle.id)}`,
    );
  } catch (err) {
    if (isGone(err)) return { state: "gone" };
    throw err;
  }
  const status = machine.state ?? "";
  const state: CiComputeStatus["state"] =
    status === "created" || status === "creating" || status === "starting"
      ? "starting"
      : status === "started" ||
          status === "restarting" ||
          status === "updating" ||
          status === "replacing"
        ? "running"
        : DONE.has(status)
          ? "gone"
          : "stopped";
  return status ? { state, detail: status } : { state };
}

export async function flyCiTeardown(api: FlyApi, handle: CiHandle): Promise<void> {
  const app = appOf(handle);
  try {
    await api.delete(`/v1/apps/${pathEncode(app)}/machines/${pathEncode(handle.id)}`, {
      query: { force: true },
    });
  } catch (err) {
    if (!isGone(err)) throw err;
  }
  // The app held only this job; with its Machine gone it can go too.
  try {
    await api.delete(`/v1/apps/${pathEncode(app)}`);
  } catch (err) {
    if (!isGone(err)) throw err;
  }
}

/**
 * Every CI app of the organization (`iwci-` apps whose Machine carries the
 * tag), one entry per job: its live Machine, or the last one it had once it
 * destroyed itself, so the reaper still finds the empty app. Apps are
 * organization-wide, so `regions` does not narrow it.
 */
export async function flyCiListTagged(
  api: FlyApi,
  orgSlug: string,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const apps: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const data = await api.get("/v1/apps", {
      query: { org_slug: orgSlug, ...(cursor ? { cursor } : {}) },
    });
    for (const app of data.apps ?? []) if (app.name.startsWith("iwci-")) apps.push(app.name);
    cursor = data.next_cursor || undefined;
    if (!cursor) break;
  }
  const out: CiTaggedCompute[] = [];
  for (const app of apps) {
    let machines: FlyMachine[];
    try {
      machines = await machinesOf(api, app);
    } catch (err) {
      if (isGone(err)) continue;
      throw err;
    }
    const tagged = machines.filter((m) => m.config?.metadata?.[tagKey] !== undefined);
    const machine = tagged.find((m) => !DONE.has(m.state ?? "")) ?? tagged[0];
    if (!machine) continue;
    const state = machine.state ?? "";
    out.push({
      handle: handleOf(app, machine),
      tags: tagsOf(machine.config?.metadata),
      ...(machine.created_at ? { createdAt: machine.created_at } : {}),
      live: !DONE.has(state) && state !== "stopped" && state !== "failed",
    });
  }
  return out;
}
