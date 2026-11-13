/**
 * CI jobs on Northflank: one manual job per CI job, run once, deleted when
 * the job ends.
 *
 * Jobs live in a project of their own per region, `infrawrench-ci-<region>`,
 * made the first time a job runs there and kept (it costs nothing, like the
 * standing CI networks other plugins make; it is not tagged, so the reaper
 * never touches it). A project's region cannot change, which is why there is
 * one per region.
 *
 * **Wire shapes verified against the Northflank API reference, November
 * 2026** (team routes take an optional `/v1/teams/{teamId}` prefix, which
 * `nfFetch` adds for an organisation token):
 * - `GET /v1/auth` (`entityType`, `projectRestrictions.enabled`); there is
 *   no documented list of the permission strings a role carries.
 * - `GET /v1/projects/{id}`, `POST /v1/projects` (`name` 3 to 39 characters,
 *   `description`, `region`), `GET /v1/projects` (`projects[]`).
 * - `PUT /v1/projects/{p}/jobs` creates or updates a job: `name` (3 to 52
 *   characters, the id is its slug), `description` (at most 200 characters
 *   of `[A-Za-z0-9.,?\s\\/'"()[\];`%^&*\-_:!]`), `billing.deploymentPlan`,
 *   `deployment.external.imagePath`, `deployment.docker.{configType:
 *   customEntrypointCustomCommand, customEntrypoint, customCommand}`,
 *   `runtimeFiles` (`{path: {data: <base64>, encoding}}`), `settings.
 *   {backoffLimit, runOnSourceChange, activeDeadlineSeconds}`. A job is
 *   manual unless `settings.cron` is set.
 * - `POST .../jobs/{j}/runs` answers `data.id`; `GET .../runs[/{r}]` reads
 *   `active`, `concluded`, `status` (`SUCCESS`, `RUNNING`, `FAILED`);
 *   `DELETE .../runs/{r}` aborts a run; `DELETE .../jobs/{j}` deletes the
 *   job; `GET .../jobs` lists them.
 *
 * The backstop is the job's `activeDeadlineSeconds`, after which Northflank
 * fails the run. Northflank templates `${NAME}` in runtime variables, so the
 * script goes in as a base64 runtime file that a tiny launcher with no `$`
 * in it decodes and runs. Jobs have no key/value tags (a job's `tags` are
 * team-level names), so the tags ride in the job's description, escaped to
 * the characters it allows. A job gets no Northflank token: workload
 * identity is opt-in per cloud account and none is configured here.
 */
import {
  CI_JOB_TAG,
  ciBootstrapWithTools,
  ciComputeKey,
  type CiComputeStatus,
  type CiExecutorDeclaration,
  type CiExecutorKind,
  type CiHandle,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";
import { nfFetch, nfList, statusOf, type NorthflankContext } from "./api.js";

export const CI_DEFAULT_PLAN = "nf-compute-200";
/** Docker's official image: Ubuntu 24.04 with curl. */
export const CI_DEFAULT_IMAGE = "buildpack-deps:noble-curl";
export const CI_DEFAULT_REGION = "europe-west";
const PROJECT_PREFIX = "infrawrench-ci-";
const JOB_PREFIX = "iwci-";
const TAGS_PREFIX = "iwci;";
const DESCRIPTION_MAX = 200;
/** The launcher: no `$` in it, so Northflank's templating leaves it alone. */
export const LAUNCHER = [
  "#!/bin/sh",
  "# Infrawrench CI: decode the job's script and run it.",
  'base64 -d /iwci/job.b64 > /tmp/iwci-job.sh || { echo "Infrawrench CI: the image needs base64 (coreutils or busybox)" >&2; exit 127; }',
  "exec /bin/sh /tmp/iwci-job.sh",
  "",
].join("\n");

export const NORTHFLANK_CI_EXECUTOR = {
  kinds: [
    {
      kind: "container",
      label: "Northflank job run",
      defaults: { machine: CI_DEFAULT_PLAN, image: CI_DEFAULT_IMAGE, region: CI_DEFAULT_REGION },
      // Not documented; a job run schedules a container on a shared cluster.
      typicalStartSeconds: 20,
      machineSuggestions: [
        "nf-compute-50",
        "nf-compute-100-2",
        "nf-compute-200",
        "nf-compute-200-8",
        "nf-compute-400",
        "nf-compute-400-16",
        "nf-compute-800-16",
        "nf-compute-1600-32",
      ],
    },
  ],
  helpLink: {
    label: "Give the token's API role Create, Run, Update and Delete on jobs and projects",
    url: "https://northflank.com/docs/v1/application/secure/grant-api-access",
  },
} as const satisfies CiExecutorDeclaration;

function requireKind(kind: CiExecutorKind): void {
  if (kind !== "container") {
    throw new Error(`Northflank runs CI jobs of kind \`container\` (a job run), not \`${kind}\`.`);
  }
}

/** The region's CI project, as its name and id. */
export function projectName(region: string): string {
  return `${PROJECT_PREFIX}${region}`;
}

/** The job's name and id: the same job, the same name. */
export function jobName(spec: Pick<CiStartSpec, "tags" | "name">): string {
  return `${JOB_PREFIX}${ciComputeKey(spec)}`;
}

function escape(text: string): string {
  return [...new TextEncoder().encode(text)]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9._-]/.test(c) ? c : `%${b.toString(16).padStart(2, "0")}`;
    })
    .join("");
}

function unescape(text: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "%" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The tags as a job description: `iwci;key:value;...`, escaped to what one may hold. */
export function tagsDescription(tags: Readonly<Record<string, string>>): string {
  const text =
    TAGS_PREFIX +
    Object.entries(tags)
      .map(([k, v]) => `${escape(k)}:${escape(v)}`)
      .join(";");
  if (text.length > DESCRIPTION_MAX) {
    throw new Error(
      `The CI job's tags take ${text.length} characters, and a Northflank job's description holds ${DESCRIPTION_MAX}.`,
    );
  }
  return text;
}

/** The tags back from a description, or null when it is not one of ours. */
export function parseTagsDescription(text: string | undefined): Record<string, string> | null {
  if (!text?.startsWith(TAGS_PREFIX)) return null;
  const tags: Record<string, string> = {};
  for (const pair of text.slice(TAGS_PREFIX.length).split(";")) {
    const at = pair.indexOf(":");
    if (at <= 0) return null;
    tags[unescape(pair.slice(0, at))] = unescape(pair.slice(at + 1));
  }
  return tags;
}

const base64 = (text: string) => {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return btoa(binary);
};

/** The `PUT /v1/projects/{p}/jobs` body for a job. */
export function jobBody(spec: CiStartSpec): Record<string, unknown> {
  const script = ciBootstrapWithTools(spec.bootstrap);
  return {
    name: jobName(spec),
    description: tagsDescription(spec.tags),
    billing: { deploymentPlan: spec.machine ?? CI_DEFAULT_PLAN },
    deployment: {
      external: { imagePath: spec.image ?? CI_DEFAULT_IMAGE },
      docker: {
        configType: "customEntrypointCustomCommand",
        customEntrypoint: "/bin/sh",
        customCommand: "/iwci/run.sh",
      },
    },
    runtimeFiles: {
      "/iwci/run.sh": { data: base64(LAUNCHER), encoding: "utf-8" },
      // Base64 twice: the file's own encoding, then the text the launcher decodes.
      "/iwci/job.b64": { data: base64(base64(script)), encoding: "utf-8" },
    },
    settings: {
      backoffLimit: 0,
      runOnSourceChange: "never",
      // The backstop: Northflank fails the run once the job's time is up.
      activeDeadlineSeconds: Math.max(60, Math.ceil(spec.maxSeconds)),
    },
  };
}

interface NfCiProject {
  id?: string;
  name?: string;
}
interface NfCiJob {
  id?: string;
  name?: string;
  description?: string;
  createdAt?: string;
}
interface NfCiRun {
  id?: string;
  active?: number;
  concluded?: boolean;
  status?: string;
  failed?: number;
}

function jobPath(project: string, job: string, rest = ""): string {
  return `/v1/projects/${encodeURIComponent(project)}/jobs/${encodeURIComponent(job)}${rest}`;
}

function handleOf(project: string, job: string, region: string, run?: string): CiHandle {
  return {
    id: run ?? job,
    region,
    label: `northflank job ${job}${run ? ` run ${run.slice(0, 8)}` : ""} (${project})`,
    data: { project, job, ...(run ? { run } : {}) },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function northflankCiPreflight(
  ctx: NorthflankContext,
  kind: CiExecutorKind,
  region?: string,
): Promise<CiPreflightResult> {
  requireKind(kind);
  const where = region ?? CI_DEFAULT_REGION;
  const problems: string[] = [];
  const missing: CiPreflightResult["missing"] = [];
  // `/v1/auth` names the role but not, in any documented form, what it
  // allows; so these are reads, and a permission is only named when one is
  // refused. A role that can read but not create fails at start.
  try {
    const auth = await nfFetch<{
      data?: { entityType?: string; projectRestrictions?: { enabled?: boolean } };
    }>(ctx, "GET", "/v1/auth", { teamScoped: false });
    if (auth?.data?.entityType === "org" && !ctx.teamId) {
      problems.push(
        "This is an organisation token with no team picked. Pick the team on the connection, so jobs run in it.",
      );
    }
    if (auth?.data?.projectRestrictions?.enabled) {
      problems.push(
        `The token's API role is restricted to some projects. CI jobs run in a project named ${projectName(where)}, which Infrawrench makes; lift the restriction or let the role reach that project.`,
      );
    }
  } catch (err) {
    problems.push(`Infrawrench could not read the token: ${errorText(err)}`);
  }
  try {
    await nfFetch(ctx, "GET", "/v1/projects", { query: { per_page: 1 } });
  } catch (err) {
    if (statusOf(err) === 403) {
      missing.push({
        permission: "Project > Projects > Manage > Read",
        label: "Find the CI project",
      });
    } else problems.push(`Infrawrench could not list projects: ${errorText(err)}`);
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: where };
}

/** The region's CI project, made when it is not there yet. */
async function ensureProject(ctx: NorthflankContext, region: string): Promise<string> {
  const name = projectName(region);
  try {
    const found = await nfFetch<{ data?: NfCiProject }>(
      ctx,
      "GET",
      `/v1/projects/${encodeURIComponent(name)}`,
    );
    if (found?.data?.id) return found.data.id;
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }
  try {
    const made = await nfFetch<{ data?: NfCiProject }>(ctx, "POST", "/v1/projects", {
      body: { name, description: "Infrawrench CI jobs", region },
    });
    if (made?.data?.id) return made.data.id;
  } catch (err) {
    // Another job made it first.
    if (statusOf(err) !== 409) throw err;
  }
  return name;
}

export async function northflankCiStart(
  ctx: NorthflankContext,
  spec: CiStartSpec,
): Promise<CiHandle> {
  requireKind(spec.kind);
  if (spec.gpu) {
    throw new Error("Northflank CI jobs here have no GPUs: use another provider for a GPU job.");
  }
  const region = spec.region ?? CI_DEFAULT_REGION;
  const body = jobBody(spec);
  const project = await ensureProject(ctx, region);
  const name = jobName(spec);
  // A job of this name that another CI job owns is never taken over.
  try {
    const existing = await nfFetch<{ data?: NfCiJob }>(ctx, "GET", jobPath(project, name));
    const tags = parseTagsDescription(existing?.data?.description);
    if (!tags || tags[CI_JOB_TAG] !== spec.tags[CI_JOB_TAG]) {
      throw new Error(`A Northflank job named ${name} already exists and is not this CI job's.`);
    }
    // A retry after a lost answer: the run it started is the job's.
    const runs = await nfList<NfCiRun>(ctx, jobPath(project, name, "/runs"), "runs", {
      maxPages: 1,
      partial: true,
    });
    const run = runs[0]?.id;
    if (run) return handleOf(project, name, region, run);
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }
  const job = await nfFetch<{ data?: NfCiJob }>(
    ctx,
    "PUT",
    `/v1/projects/${encodeURIComponent(project)}/jobs`,
    { body },
  );
  const jobId = job?.data?.id ?? name;
  const run = await nfFetch<{ data?: { id?: string } }>(
    ctx,
    "POST",
    jobPath(project, jobId, "/runs"),
    {
      body: {},
    },
  );
  if (!run?.data?.id) throw new Error("Northflank did not return the job run's id.");
  return handleOf(project, jobId, region, run.data.id);
}

export async function northflankCiStatus(
  ctx: NorthflankContext,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  const project = handle.data?.["project"] ?? "";
  const job = handle.data?.["job"] ?? handle.id;
  const runId = handle.data?.["run"];
  if (runId) {
    try {
      const run = await nfFetch<{ data?: NfCiRun }>(
        ctx,
        "GET",
        jobPath(project, job, `/runs/${encodeURIComponent(runId)}`),
      );
      const r = run?.data ?? {};
      if (r.concluded)
        return { state: "stopped", detail: `The run ended: ${r.status ?? "concluded"}.` };
      return r.active ? { state: "running" } : { state: "starting" };
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }
  try {
    await nfFetch(ctx, "GET", jobPath(project, job));
    return { state: "stopped" };
  } catch (err) {
    if (statusOf(err) === 404) return { state: "gone" };
    throw err;
  }
}

export async function northflankCiTeardown(
  ctx: NorthflankContext,
  handle: CiHandle,
): Promise<void> {
  const project = handle.data?.["project"] ?? "";
  const job = handle.data?.["job"] ?? handle.id;
  const runId = handle.data?.["run"];
  // Abort the run first: deleting a job is not documented to stop its runs.
  if (runId) {
    try {
      await nfFetch(ctx, "DELETE", jobPath(project, job, `/runs/${encodeURIComponent(runId)}`));
    } catch (err) {
      const status = statusOf(err);
      if (status !== 404 && status !== 409 && status !== 400) throw err;
    }
  }
  try {
    await nfFetch(ctx, "DELETE", jobPath(project, job));
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }
}

export async function northflankCiListTagged(
  ctx: NorthflankContext,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const projects = await nfList<NfCiProject>(ctx, "/v1/projects", "projects");
  const out: CiTaggedCompute[] = [];
  for (const project of projects) {
    const id = project.id ?? "";
    if (!id.startsWith(PROJECT_PREFIX)) continue;
    const region = id.slice(PROJECT_PREFIX.length);
    const jobs = await nfList<NfCiJob>(ctx, `/v1/projects/${encodeURIComponent(id)}/jobs`, "jobs");
    for (const job of jobs) {
      const jobId = job.id ?? "";
      if (!jobId.startsWith(JOB_PREFIX)) continue;
      const tags = parseTagsDescription(job.description);
      if (!tags || !(tagKey in tags)) continue;
      let runs: NfCiRun[] = [];
      try {
        runs = await nfList<NfCiRun>(ctx, jobPath(id, jobId, "/runs"), "runs", {
          maxPages: 1,
          partial: true,
        });
      } catch (err) {
        if (statusOf(err) === 404) continue;
        throw err;
      }
      const run = runs[0];
      out.push({
        handle: handleOf(id, jobId, region, run?.id),
        tags,
        ...(job.createdAt ? { createdAt: job.createdAt } : {}),
        live: runs.some((r) => !r.concluded),
      });
    }
  }
  return out;
}
