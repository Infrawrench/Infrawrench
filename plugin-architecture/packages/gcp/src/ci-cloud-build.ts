/**
 * CI jobs as Cloud Build builds: one regional build per job whose one step
 * runs the host's bootstrap as its script, with Docker available.
 *
 * **Wire shapes verified against the Cloud Build v1 Discovery document and
 * docs, November 2026:**
 * - `POST /v1/projects/{p}/locations/{l}/builds` (an Operation): `steps[]
 *   .{name, script}` (a script runs with its `#!` line and takes no
 *   substitutions, so the bootstrap goes in as it is), `timeout` (at most
 *   24 hours, as `"<n>s"`), `options.{machineType, logging}`, `tags`
 *   (letters, digits, `_`, and `.`/`-` after the first character),
 *   `substitutions` (user keys `_[A-Z0-9_]+`), `serviceAccount`
 *   (`projects/{p}/serviceAccounts/{email}`). A build naming its own service
 *   account must log to Cloud Logging only or not at all: it logs nothing
 *   (`NONE`), since the job's log goes to Infrawrench and the account has no
 *   roles to write logs with.
 * - `GET .../builds?filter=` (`tags="x"`, `status="WORKING"`),
 *   `GET .../builds/{id}` (`status`: PENDING, QUEUED, WORKING, SUCCESS,
 *   FAILURE, INTERNAL_ERROR, TIMEOUT, CANCELLED, EXPIRED; `createTime`),
 *   `POST .../builds/{id}:cancel`.
 *
 * There is no request id on `builds.create`, so a start first looks for a
 * build tagged with the job's key. Builds cannot carry key/value tags, so
 * the job's tags ride as JSON in the `_INFRAWRENCH_CI_TAGS` substitution.
 * Cloud Build hands a build step its service account's token, so the build
 * runs as `infrawrench-ci-runner`, which has no roles. The build's timeout
 * is the backstop.
 */
import {
  ciComputeKey,
  type CiComputeStatus,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import {
  ensureServiceAccount,
  errorText,
  isApiDisabled,
  missingOnProject,
  missingServiceAccountPermissions,
  parseTags,
  retryWhileAccountSettles,
  serviceAccountEmail,
  statusOf,
  type GcpCiCalls,
} from "./ci-shared.js";

export const BUILD_DEFAULT_MACHINE = "e2-standard-2";
/** Google's Docker builder: Ubuntu with the Docker CLI, curl and bash. */
export const BUILD_DEFAULT_IMAGE = "gcr.io/cloud-builders/docker";
const TAGS_SUBSTITUTION = "_INFRAWRENCH_CI_TAGS";
const MAX_TIMEOUT_SECONDS = 24 * 3600;
/** Cloud Build's machine types, as `options.machineType` names them. */
export const BUILD_MACHINES = [
  "e2-standard-2",
  "e2-medium",
  "e2-highcpu-8",
  "e2-highcpu-32",
  "n1-highcpu-8",
  "n1-highcpu-32",
] as const;

export const BUILD_PERMISSIONS = {
  create: { permission: "cloudbuild.builds.create", label: "Start the job's build" },
  get: { permission: "cloudbuild.builds.get", label: "Follow it" },
  list: { permission: "cloudbuild.builds.list", label: "Find leftovers" },
  cancel: { permission: "cloudbuild.builds.update", label: "Cancel it when the job ends" },
} as const satisfies Record<string, CiMissingPermission>;

/** `e2-highcpu-8` as `E2_HIGHCPU_8`, or an error naming the types. */
export function machineType(machine: string): string {
  const normal = machine.trim().toLowerCase().replace(/_/g, "-");
  if (!(BUILD_MACHINES as readonly string[]).includes(normal)) {
    throw new Error(`Cloud Build runs on ${BUILD_MACHINES.join(", ")}, not \`${machine}\`.`);
  }
  return normal.toUpperCase().replace(/-/g, "_");
}

/** A tag Cloud Build takes: letters, digits, `_`, `.` and `-`, not leading with `.` or `-`. */
export function buildTag(text: string): string {
  const safe = text.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128);
  return /^[A-Za-z0-9_]/.test(safe) ? safe : `_${safe}`.slice(0, 128);
}

function keyTag(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `iwci-${ciComputeKey(spec)}`;
}

function buildsUrl(project: string, region: string): string {
  return `https://cloudbuild.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/builds`;
}

export function buildBody(spec: CiStartSpec, project: string): Record<string, unknown> {
  return {
    steps: [{ name: spec.image ?? BUILD_DEFAULT_IMAGE, script: spec.bootstrap }],
    timeout: `${Math.min(MAX_TIMEOUT_SECONDS, Math.max(60, Math.ceil(spec.maxSeconds)))}s`,
    tags: [...new Set([...Object.keys(spec.tags).map(buildTag), keyTag(spec)])],
    substitutions: { [TAGS_SUBSTITUTION]: JSON.stringify(spec.tags) },
    serviceAccount: `projects/${project}/serviceAccounts/${serviceAccountEmail(project)}`,
    options: {
      machineType: machineType(spec.machine ?? BUILD_DEFAULT_MACHINE),
      logging: "NONE",
      // The tags substitution is read back, never used by a step.
      substitutionOption: "ALLOW_LOOSE",
    },
  };
}

function handleOf(id: string, region: string): CiHandle {
  return { id, region, label: `gcp cloud build ${id} (${region})`, data: { kind: "build" } };
}

const ACTIVE = new Set(["PENDING", "QUEUED", "WORKING", "STATUS_UNKNOWN"]);

interface Build {
  id?: string;
  status?: string;
  createTime?: string;
  substitutions?: Record<string, string>;
}

async function listBuilds(calls: GcpCiCalls, region: string, filter: string): Promise<Build[]> {
  const out: Build[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      filter,
      pageSize: "100",
      ...(pageToken ? { pageToken } : {}),
    });
    const page = await calls.call<{ builds?: Build[]; nextPageToken?: string }>(
      "GET",
      `${buildsUrl(calls.project, region)}?${params}`,
    );
    out.push(...(page.builds ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export async function buildPreflight(
  calls: GcpCiCalls,
  region: string,
): Promise<CiPreflightResult> {
  const missing = [
    ...(await missingOnProject(calls, Object.values(BUILD_PERMISSIONS))),
    ...(await missingServiceAccountPermissions(calls)),
  ];
  const problems: string[] = [];
  try {
    await calls.call("GET", `${buildsUrl(calls.project, region)}?pageSize=1`);
  } catch (err) {
    if (isApiDisabled(err)) problems.push(errorText(err));
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region };
}

export async function buildStart(
  calls: GcpCiCalls,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  if (spec.gpu) {
    throw new Error("Cloud Build has no GPUs: use the `vm` kind (Compute Engine) for a GPU job.");
  }
  const body = buildBody(spec, calls.project);
  // No request id: a build already tagged with the job's key is this start's.
  const earlier = await listBuilds(calls, region, `tags="${keyTag(spec)}"`);
  const found = earlier.find((b) => b.id);
  if (found?.id) return handleOf(found.id, region);
  const fresh = await ensureServiceAccount(calls);
  const op = await retryWhileAccountSettles(calls, fresh, () =>
    calls.call<{ metadata?: { build?: { id?: string } } }>(
      "POST",
      buildsUrl(calls.project, region),
      body,
    ),
  );
  const id = op.metadata?.build?.id;
  if (!id) throw new Error("Cloud Build started no build");
  return handleOf(id, region);
}

export async function buildStatus(calls: GcpCiCalls, handle: CiHandle): Promise<CiComputeStatus> {
  let build: Build;
  try {
    build = await calls.call(
      "GET",
      `${buildsUrl(calls.project, handle.region ?? "")}/${encodeURIComponent(handle.id)}`,
    );
  } catch (err) {
    if (statusOf(err) === 404) return { state: "gone" };
    throw err;
  }
  const status = build.status ?? "";
  if (status === "WORKING") return { state: "running", detail: status };
  if (ACTIVE.has(status)) return { state: "starting", detail: status };
  // A finished build keeps nothing running or billed.
  return { state: "gone", detail: status };
}

export async function buildTeardown(calls: GcpCiCalls, handle: CiHandle): Promise<void> {
  const url = `${buildsUrl(calls.project, handle.region ?? "")}/${encodeURIComponent(handle.id)}`;
  try {
    await calls.call("POST", `${url}:cancel`, {});
  } catch (err) {
    if (statusOf(err) === 404) return;
    // Cancelling a finished build is refused; it is already done.
    const { state } = await buildStatus(calls, handle);
    if (state === "gone") return;
    throw err;
  }
}

export async function buildListTagged(
  calls: GcpCiCalls,
  tagKey: string,
  regions: readonly string[],
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  const filter = `tags="${buildTag(tagKey)}" AND (status="PENDING" OR status="QUEUED" OR status="WORKING")`;
  for (const region of new Set(regions)) {
    let builds: Build[];
    try {
      builds = await listBuilds(calls, region, filter);
    } catch (err) {
      if (isApiDisabled(err)) continue;
      throw err;
    }
    for (const build of builds) {
      const tags = parseTags(build.substitutions?.[TAGS_SUBSTITUTION]);
      if (!build.id || !tags || !(tagKey in tags)) continue;
      out.push({
        handle: handleOf(build.id, region),
        tags,
        ...(build.createTime ? { createdAt: build.createTime } : {}),
        live: true,
      });
    }
  }
  return out;
}
