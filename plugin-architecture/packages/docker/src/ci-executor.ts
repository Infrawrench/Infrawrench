/**
 * CI jobs on a Docker daemon: one container per job.
 *
 * - `container` runs the job in the image the pipeline names (Ubuntu 24.04
 *   with curl by default), with no mounts, not privileged, and none of the
 *   daemon's own access: the job cannot reach the daemon it runs on.
 * - `build` runs the job in Docker's own `docker:dind` image with a Docker
 *   daemon of its own inside the container, so `docker build` and `docker
 *   push` work without lending the job the host's daemon. A daemon inside a
 *   container needs it privileged, which is as good as root on the daemon's
 *   machine; that is why it is a kind of its own, opted in to separately.
 *
 * **Wire shapes verified against the Docker Engine API reference (v1.56),
 * November 2026,** through dockerode in this plugin's driver:
 * - `POST /containers/create?name=` with `Image`, `Entrypoint`, `Cmd`,
 *   `Labels`, `StopTimeout`, `HostConfig.{AutoRemove, Init, NanoCpus,
 *   Memory, DeviceRequests, Privileged}`; a name in use answers 409, so the
 *   CI job's id as the name makes a retry find the container it made.
 * - `GET /containers/json?all=true&filters={"label":["<key>"]}` lists what
 *   carries the CI label (labels hold the tags exactly as sent);
 *   `GET /containers/{id}/json` reads `State.Status`, 404 when it is gone.
 * - `DELETE /containers/{id}?force=true&v=true` kills and removes it with
 *   its anonymous volumes; 404 is "already gone".
 *
 * The daemon has no time limit for a container, so the backstop is the
 * container's own command: the bootstrap runs under `ciContainerCommand`'s watchdog as
 * its main process, and `AutoRemove` removes the container once that ends.
 * `StopTimeout` keeps a teardown's stop short.
 */
import {
  CI_JOB_TAG,
  ciBootstrapWithTools,
  ciComputeKey,
  ciContainerCommand,
  parseCiContainerSize,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

/** One driver operation (`services.docker.command`). */
export type DockerCommand = (op: string, params?: Record<string, unknown>) => Promise<unknown>;

const DEFAULT_MACHINE = "2vcpu-4gb";
/** Ubuntu 24.04 with curl and CA certificates: what the bootstrap needs. */
const DEFAULT_IMAGE = "buildpack-deps:noble-curl";
/** Docker's official image with a daemon in it. */
const DEFAULT_BUILD_IMAGE = "docker:29-dind";
/**
 * The label that keeps the CI tags as sent: a container also carries its
 * image's labels, which are not tags.
 */
export const TAGS_LABEL = "com.infrawrench.ci.tags";
/** Seconds a teardown's stop waits before it kills. */
const STOP_TIMEOUT = 10;

const MACHINES = ["1vcpu-2gb", "2vcpu-4gb", "4vcpu-8gb", "8vcpu-16gb"];

export const DOCKER_CI_EXECUTOR = {
  kinds: [
    {
      kind: "container",
      label: "Container on the daemon",
      defaults: { machine: DEFAULT_MACHINE, image: DEFAULT_IMAGE },
      typicalStartSeconds: 5,
      gpus: true,
      machineSuggestions: MACHINES,
    },
    {
      kind: "build",
      label: "Docker build container (privileged)",
      defaults: { machine: DEFAULT_MACHINE, image: DEFAULT_BUILD_IMAGE },
      typicalStartSeconds: 15,
      machineSuggestions: MACHINES,
    },
  ],
  helpLink: {
    label: "Connect a Docker daemon Infrawrench can reach",
    url: "https://docs.docker.com/engine/daemon/remote-access/",
  },
} as const satisfies CiExecutorDeclaration;

function requireKind(kind: CiExecutorKind): "container" | "build" {
  if (kind !== "container" && kind !== "build") {
    throw new Error(`Docker runs CI jobs of kind \`container\` or \`build\`, not \`${kind}\`.`);
  }
  return kind;
}

/** `2vcpu-4gb` and the like as CPUs and bytes; null when it is not that shape. */
export function parseMachine(machine: string): { nanoCpus: number; memory: number } | null {
  const size = parseCiContainerSize(machine);
  if (!size) return null;
  return {
    nanoCpus: Math.round(size.vcpus * 1e9),
    memory: Math.round(size.memoryGb * 1024 * 1024 * 1024),
  };
}

/** `cloud.gpu` (`type[:count]`) as a device request for the NVIDIA runtime. */
export function gpuRequest(gpu: string): Record<string, unknown> {
  const [, count = "1"] = gpu.split(":");
  if (!/^\d+$/.test(count) || count === "0") {
    throw new Error(`\`cloud.gpu\` wants a GPU count after the colon, not ${count}.`);
  }
  return { Driver: "nvidia", Count: Number(count), Capabilities: [["gpu"]] };
}

/** The container's name, from the CI job's id: the same id, the same name. */
export function containerName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

/**
 * The script a `build` container runs: its own Docker daemon on a unix
 * socket only (nothing listens on the network), then the job once it answers.
 */
export function buildScript(bootstrap: string): string {
  return [
    "#!/bin/sh",
    "# Infrawrench CI: a Docker daemon of the job's own, on a unix socket only.",
    "export DOCKER_TLS_CERTDIR=",
    "dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock >/var/log/iwci-dockerd.log 2>&1 &",
    "i=0",
    'until docker info >/dev/null 2>&1; do i=$((i + 1)); if [ "$i" -gt 60 ]; then echo "Infrawrench CI: the job\'s Docker daemon did not start" >&2; tail -n 20 /var/log/iwci-dockerd.log >&2; exit 1; fi; sleep 1; done',
    ciBootstrapWithTools(bootstrap).replace(/^#![^\n]*\n/, ""),
  ].join("\n");
}

/** The `POST /containers/create` body for a job (the name goes in the query). */
export function createBody(spec: CiStartSpec): Record<string, unknown> {
  const kind = requireKind(spec.kind);
  const machine = spec.machine ?? DEFAULT_MACHINE;
  const size = parseMachine(machine);
  if (!size) {
    throw new Error(
      `\`cloud.machine\` for a Docker job is CPUs and memory, like ${DEFAULT_MACHINE}, not ${machine}.`,
    );
  }
  if (spec.gpu && kind === "build") {
    throw new Error("A Docker `build` job has no GPUs; use kind `container` for a GPU job.");
  }
  const seconds = Math.max(60, Math.ceil(spec.maxSeconds));
  const image = spec.image ?? (kind === "build" ? DEFAULT_BUILD_IMAGE : DEFAULT_IMAGE);
  const command = ciContainerCommand(
    kind === "build" ? buildScript(spec.bootstrap) : ciBootstrapWithTools(spec.bootstrap),
    seconds,
  );
  return {
    Image: image,
    Entrypoint: command.slice(0, 2),
    Cmd: command.slice(2),
    Labels: {
      ...spec.tags,
      [TAGS_LABEL]: JSON.stringify(spec.tags),
      "com.infrawrench.ci.name": spec.name,
    },
    StopTimeout: STOP_TIMEOUT,
    HostConfig: {
      AutoRemove: true,
      Init: true,
      NanoCpus: size.nanoCpus,
      Memory: size.memory,
      ...(kind === "build" ? { Privileged: true } : {}),
      ...(spec.gpu ? { DeviceRequests: [gpuRequest(spec.gpu)] } : {}),
    },
  };
}

/** What the driver's `ciInspect` answers: the parts of `GET /containers/{id}/json` used here. */
export interface CiContainer {
  Id?: string;
  Name?: string;
  Created?: string;
  Config?: { Labels?: Record<string, string> };
  State?: { Status?: string; ExitCode?: number; Error?: string; OOMKilled?: boolean };
}

/** What the driver's `ciList` answers: the parts of `GET /containers/json` used here. */
export interface CiContainerSummary {
  Id?: string;
  Names?: string[];
  Labels?: Record<string, string>;
  State?: string;
  Created?: number;
}

function handleOf(id: string, name: string): CiHandle {
  return { id, label: `docker container ${name} (${id.slice(0, 12)})`, data: { name } };
}

export async function ciPreflight(
  command: DockerCommand,
  kind: CiExecutorKind,
): Promise<CiPreflightResult> {
  requireKind(kind);
  const problems: string[] = [];
  try {
    const info = (await command("ciInfo")) as { OSType?: string };
    if (info.OSType && info.OSType !== "linux") {
      problems.push(
        `This Docker daemon runs ${info.OSType} containers, and a CI job needs a Linux one. Switch it to Linux containers or connect another daemon.`,
      );
    }
  } catch (err) {
    problems.push(
      `Infrawrench could not reach this Docker daemon: ${err instanceof Error ? err.message : String(err)}. A daemon on a local socket is only reachable from the desktop app; connect one over TCP or an SSH tunnel to run CI jobs from the cloud.`,
    );
  }
  // A daemon's access is all or nothing: there are no permissions to name.
  return { ok: problems.length === 0, missing: [], problems };
}

export async function ciStart(command: DockerCommand, spec: CiStartSpec): Promise<CiHandle> {
  const body = createBody(spec);
  const name = containerName(spec);
  const created = (await command("ciRun", { name, image: body["Image"], body })) as
    { id: string } | { conflict: true };
  if ("id" in created) return handleOf(created.id, name);
  // The name is taken: a retry after a lost answer, or someone else's container.
  const existing = (await command("ciInspect", { id: name })) as CiContainer | null;
  const mine = existing?.Config?.Labels?.[CI_JOB_TAG];
  if (!existing?.Id || !mine || mine !== spec.tags[CI_JOB_TAG]) {
    throw new Error(`A container named ${name} already exists and is not this CI job's.`);
  }
  if (existing.State?.Status === "created") await command("ciStartContainer", { id: existing.Id });
  return handleOf(existing.Id, name);
}

export async function ciStatus(command: DockerCommand, handle: CiHandle): Promise<CiComputeStatus> {
  const container = (await command("ciInspect", { id: handle.id })) as CiContainer | null;
  if (!container) return { state: "gone" };
  const status = container.State?.Status ?? "";
  if (status === "created") return { state: "starting" };
  if (status === "running" || status === "paused" || status === "restarting") {
    return { state: "running" };
  }
  const code = container.State?.ExitCode;
  const detail = container.State?.OOMKilled
    ? "out of memory"
    : container.State?.Error || (code !== undefined ? `exit code ${code}` : "");
  return detail ? { state: "stopped", detail } : { state: "stopped" };
}

export async function ciTeardown(command: DockerCommand, handle: CiHandle): Promise<void> {
  await command("ciRemove", { id: handle.id });
}

/** The tags as sent, from the label that keeps them; the CI label alone without it. */
function tagsOf(labels: Record<string, string>, tagKey: string): Record<string, string> {
  try {
    const parsed = JSON.parse(labels[TAGS_LABEL] ?? "") as unknown;
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      );
    }
  } catch {
    // Fall through to the label itself.
  }
  const value = labels[tagKey];
  return value === undefined ? {} : { [tagKey]: value };
}

export async function ciListTagged(
  command: DockerCommand,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const containers = (await command("ciList", { label: tagKey })) as CiContainerSummary[];
  return containers.flatMap((c) => {
    if (!c.Id) return [];
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
    const tags = tagsOf(c.Labels ?? {}, tagKey);
    return [
      {
        handle: handleOf(c.Id, name),
        tags,
        ...(c.Created ? { createdAt: new Date(c.Created * 1000).toISOString() } : {}),
        live:
          c.State === "created" ||
          c.State === "running" ||
          c.State === "restarting" ||
          c.State === "paused",
      },
    ];
  });
}
