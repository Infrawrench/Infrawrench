/**
 * CI jobs as CodeBuild builds: one shared project per region, and one
 * `StartBuild` per job whose inline buildspec runs the host's bootstrap in a
 * privileged build container (Docker available).
 *
 * **Wire shapes verified against the AWS CodeBuild API Reference, November
 * 2026** (JSON 1.1, target prefix `CodeBuild_20161006`, through `jsonCall`;
 * request bodies are typed by the SDK's own models):
 * - `CreateProject`: `name`, `source.{type: NO_SOURCE, buildspec}`,
 *   `artifacts.type: NO_ARTIFACTS`, `environment.{type, image, computeType,
 *   privilegedMode}`, `serviceRole` (required), `timeoutInMinutes`,
 *   `logsConfig`. A taken name answers `ResourceAlreadyExistsException`.
 * - `StartBuild`: `projectName`, `idempotencyToken`, `sourceTypeOverride`,
 *   `buildspecOverride` (inline YAML), `imageOverride`,
 *   `environmentTypeOverride`, `computeTypeOverride`,
 *   `privilegedModeOverride`, `timeoutInMinutesOverride` (5 to 2160),
 *   `queuedTimeoutInMinutesOverride`, `environmentVariablesOverride[]
 *   .{name, value, type: PLAINTEXT}`, `logsConfigOverride`.
 * - `BatchGetBuilds` (`ids`, up to 100): `builds[].{id, buildStatus,
 *   currentPhase, buildComplete, startTime (epoch seconds),
 *   environment.environmentVariables}`, `buildsNotFound[]`.
 * - `ListBuildsForProject` (`projectName`, `nextToken`; newest first) and
 *   `StopBuild` (`id`).
 * - IAM `GetRole` / `CreateRole` (Query API, 2010-05-08).
 *
 * **What the build holds.** CodeBuild always runs a build as a service role
 * and hands the build container that role's credentials. The project's role
 * is one this module makes, `infrawrench-ci-codebuild`, trusted by CodeBuild
 * and given no permissions at all, so what the job can reach with those
 * credentials is nothing. Logs are off (the job's log goes to Infrawrench),
 * so the role needs no CloudWatch Logs access either.
 *
 * Builds cannot be tagged, so the job's tags ride in a plain-text
 * environment variable of the build, `INFRAWRENCH_CI_TAGS`, which
 * `BatchGetBuilds` gives back. The build's own timeout is the backstop.
 */
import type {
  BatchGetBuildsInput,
  BatchGetProjectsInput,
  CreateProjectInput,
  ListBuildsForProjectInput,
  StartBuildInput,
  StopBuildInput,
} from "@aws-sdk/client-codebuild";
import {
  ciComputeKey,
  type CiComputeStatus,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
  type CiTaggedCompute,
} from "@infrawrench/plugin-base";

import { AwsRequestError } from "./aws-errors.js";
import { awsCiPermissionCheck, type AwsCiCalls } from "./ci-calls.js";
import { ensureArray } from "./xml.js";

export const CI_PROJECT = "infrawrench-ci";
export const CI_ROLE = "infrawrench-ci-codebuild";
const TARGET = "CodeBuild_20161006";
const IAM_VERSION = "2010-05-08";
/** The plain-text environment variable that carries a build's tags. */
export const TAGS_VARIABLE = "INFRAWRENCH_CI_TAGS";

export const CODEBUILD_DEFAULT_MACHINE = "BUILD_GENERAL1_MEDIUM";
/** CodeBuild's curated Ubuntu 24.04 image: Docker, curl, bash and git included. */
export const CODEBUILD_DEFAULT_IMAGE = "aws/codebuild/standard:8.0";
const CODEBUILD_ARM_IMAGE = "aws/codebuild/amazonlinux-aarch64-standard:3.0";
/** The longest a build may run, in minutes. */
const MAX_TIMEOUT_MINUTES = 2160;

/** Every permission a CI job on CodeBuild needs, with what it is for. */
export const CODEBUILD_PERMISSIONS = {
  getProject: { permission: "codebuild:BatchGetProjects", label: "Find the CI project" },
  createProject: {
    permission: "codebuild:CreateProject",
    label: "Make the CI project on first use",
  },
  start: { permission: "codebuild:StartBuild", label: "Start the job's build" },
  get: { permission: "codebuild:BatchGetBuilds", label: "Follow it and find leftovers" },
  list: { permission: "codebuild:ListBuildsForProject", label: "Find leftovers" },
  stop: { permission: "codebuild:StopBuild", label: "Stop it when the job ends" },
  getRole: { permission: "iam:GetRole", label: "Find the build's role" },
  createRole: {
    permission: "iam:CreateRole",
    label: "Make the build's role, which has no permissions, on first use",
  },
  passRole: { permission: "iam:PassRole", label: "Give that role to the CI project" },
} as const satisfies Record<string, CiMissingPermission>;

/** CodeBuild's Linux compute types the UI suggests. */
export const CODEBUILD_MACHINES = [
  "BUILD_GENERAL1_SMALL",
  "BUILD_GENERAL1_MEDIUM",
  "BUILD_GENERAL1_LARGE",
  "BUILD_GENERAL1_XLARGE",
  "BUILD_GENERAL1_2XLARGE",
] as const;

function code(err: unknown): string | undefined {
  return err instanceof AwsRequestError ? err.code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  const c = code(err);
  return c === "ResourceNotFoundException" || c === "NoSuchEntity";
}

/** The trust policy of the build's role: CodeBuild may assume it, and nothing else. */
export const ROLE_TRUST_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "codebuild.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

/** The build's inline buildspec: the bootstrap, decoded from base64 and run. */
export function buildspec(bootstrap: string): string {
  const encoded = Buffer.from(bootstrap, "utf8").toString("base64");
  return [
    "version: 0.2",
    "phases:",
    "  build:",
    "    commands:",
    // Base64 has no character YAML or the shell reads specially.
    `      - 'echo ${encoded} | base64 -d > /tmp/iwci-bootstrap.sh && sh /tmp/iwci-bootstrap.sh'`,
    "",
  ].join("\n");
}

/** Whole minutes for the build's timeout, within CodeBuild's range. */
export function timeoutMinutes(maxSeconds: number): number {
  return Math.min(MAX_TIMEOUT_MINUTES, Math.max(5, Math.ceil(maxSeconds / 60)));
}

/** StartBuild's body for a job. */
export function startBuildRequest(spec: CiStartSpec): StartBuildInput {
  const machine = spec.machine ?? CODEBUILD_DEFAULT_MACHINE;
  const arm = /^ARM_|^BUILD_GENERAL1_.*_ARM|aarch64|arm64/i.test(machine);
  const image = spec.image ?? (arm ? CODEBUILD_ARM_IMAGE : CODEBUILD_DEFAULT_IMAGE);
  return {
    projectName: CI_PROJECT,
    // A retry after a lost answer gets the same build rather than a second.
    idempotencyToken: ciComputeKey(spec),
    sourceTypeOverride: "NO_SOURCE",
    buildspecOverride: buildspec(spec.bootstrap),
    imageOverride: image,
    environmentTypeOverride:
      arm || /aarch64|arm64/i.test(image) ? "ARM_CONTAINER" : "LINUX_CONTAINER",
    computeTypeOverride: machine as StartBuildInput["computeTypeOverride"],
    privilegedModeOverride: true,
    // A custom image is pulled with CodeBuild's own service credentials
    // only for its curated images; anything else is public.
    imagePullCredentialsTypeOverride: image.startsWith("aws/codebuild/")
      ? "CODEBUILD"
      : "SERVICE_ROLE",
    timeoutInMinutesOverride: timeoutMinutes(spec.maxSeconds),
    queuedTimeoutInMinutesOverride: 60,
    environmentVariablesOverride: [
      { name: TAGS_VARIABLE, value: JSON.stringify(spec.tags), type: "PLAINTEXT" },
    ],
    logsConfigOverride: {
      cloudWatchLogs: { status: "DISABLED" },
      s3Logs: { status: "DISABLED" },
    },
  };
}

async function roleArn(calls: AwsCiCalls): Promise<string> {
  const arnOf = (data: Record<string, unknown>): string | undefined => {
    const result = (data["GetRoleResult"] ?? data["CreateRoleResult"] ?? data) as Record<
      string,
      unknown
    >;
    const role = result["Role"] as Record<string, unknown> | undefined;
    return typeof role?.["Arn"] === "string" ? role["Arn"] : undefined;
  };
  try {
    const found = arnOf(
      await calls.query<Record<string, unknown>>("iam", "GetRole", IAM_VERSION, {
        RoleName: CI_ROLE,
      }),
    );
    if (found) return found;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    const made = arnOf(
      await calls.query<Record<string, unknown>>("iam", "CreateRole", IAM_VERSION, {
        RoleName: CI_ROLE,
        AssumeRolePolicyDocument: ROLE_TRUST_POLICY,
        Description:
          "Infrawrench CI builds run as this role. It has no permissions, so a build holds no useful AWS credentials.",
      }),
    );
    if (made) return made;
  } catch (err) {
    if (code(err) !== "EntityAlreadyExists") throw err;
  }
  // Made by a start running at the same time.
  const again = arnOf(
    await calls.query<Record<string, unknown>>("iam", "GetRole", IAM_VERSION, {
      RoleName: CI_ROLE,
    }),
  );
  if (!again) throw new Error(`IAM did not answer the role ${CI_ROLE}`);
  return again;
}

async function ensureProject(calls: AwsCiCalls, region: string): Promise<void> {
  const found = await calls.json<{ projects?: unknown[] }>(
    region,
    "codebuild",
    `${TARGET}.BatchGetProjects`,
    { names: [CI_PROJECT] } satisfies BatchGetProjectsInput,
  );
  if (ensureArray(found.projects).length > 0) return;
  const serviceRole = await roleArn(calls);
  const body = {
    name: CI_PROJECT,
    description:
      "Infrawrench CI cloud jobs. Each build is one job; the job's script comes with it.",
    source: { type: "NO_SOURCE", buildspec: buildspec("true\n") },
    artifacts: { type: "NO_ARTIFACTS" },
    environment: {
      type: "LINUX_CONTAINER",
      image: CODEBUILD_DEFAULT_IMAGE,
      computeType: CODEBUILD_DEFAULT_MACHINE,
      privilegedMode: true,
    },
    serviceRole,
    timeoutInMinutes: 60,
    logsConfig: { cloudWatchLogs: { status: "DISABLED" }, s3Logs: { status: "DISABLED" } },
  } satisfies CreateProjectInput;
  // A new role takes a few seconds to be assumable everywhere in IAM.
  for (let attempt = 0; ; attempt++) {
    try {
      await calls.json(region, "codebuild", `${TARGET}.CreateProject`, body);
      return;
    } catch (err) {
      if (code(err) === "ResourceAlreadyExistsException") return;
      const roleNotReady =
        code(err) === "InvalidInputException" && /role|assume/i.test(errorText(err));
      if (!roleNotReady || attempt >= 5) throw err;
      await (calls.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(5000);
    }
  }
}

export async function codebuildPreflight(
  calls: AwsCiCalls,
  region: string,
): Promise<CiPreflightResult> {
  const { passRole, ...rest } = CODEBUILD_PERMISSIONS;
  const { missing, problems } = await awsCiPermissionCheck(calls, Object.values(rest));
  // A policy may give PassRole on the one role only, so ask about that role.
  const pass = await awsCiPermissionCheck(
    calls,
    [passRole],
    (account) => `arn:aws:iam::${account}:role/${CI_ROLE}`,
  );
  missing.push(...pass.missing.filter((p) => !missing.includes(p)));
  problems.push(...pass.problems.filter((p) => !problems.includes(p)));
  // Once the role is there, making it is no longer needed.
  if (missing.some((p) => p.permission === "iam:CreateRole")) {
    try {
      await roleArn({ ...calls, query: refuseCreate(calls) });
      missing.splice(
        missing.findIndex((p) => p.permission === "iam:CreateRole"),
        1,
      );
    } catch {
      // Not there, or not readable: it still has to be made.
    }
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region };
}

/** A query call that only reads, for checking without making anything. */
function refuseCreate(calls: AwsCiCalls): AwsCiCalls["query"] {
  return (service, action, version, params) => {
    if (action !== "GetRole") return Promise.reject(new Error("read only"));
    return calls.query(service, action, version, params);
  };
}

function handleOf(id: string, region: string): CiHandle {
  return {
    id,
    region,
    label: `aws codebuild ${id.split(":").pop() ?? id} (${region})`,
    data: { kind: "build" },
  };
}

export async function codebuildStart(
  calls: AwsCiCalls,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  if (spec.gpu) {
    throw new Error("CodeBuild has no GPU builds here: use the `vm` kind (EC2) for a GPU job.");
  }
  await ensureProject(calls, region);
  const data = await calls.json<{ build?: { id?: string } }>(
    region,
    "codebuild",
    `${TARGET}.StartBuild`,
    startBuildRequest(spec),
  );
  const id = data.build?.id;
  if (!id) throw new Error("CodeBuild started no build");
  return handleOf(id, region);
}

interface Build {
  id?: string;
  buildStatus?: string;
  currentPhase?: string;
  buildComplete?: boolean;
  startTime?: unknown;
  environment?: { environmentVariables?: Array<{ name?: string; value?: string }> };
}

async function getBuilds(
  calls: AwsCiCalls,
  region: string,
  ids: readonly string[],
): Promise<{ builds: Build[]; notFound: string[] }> {
  const data = await calls.json<{ builds?: Build[]; buildsNotFound?: string[] }>(
    region,
    "codebuild",
    `${TARGET}.BatchGetBuilds`,
    { ids: [...ids] } satisfies BatchGetBuildsInput,
  );
  return { builds: ensureArray(data.builds), notFound: ensureArray(data.buildsNotFound) };
}

const STARTING_PHASES = new Set(["SUBMITTED", "QUEUED", "PROVISIONING"]);

export async function codebuildStatus(
  calls: AwsCiCalls,
  region: string,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  let build: Build | undefined;
  try {
    build = (await getBuilds(calls, region, [handle.id])).builds[0];
  } catch (err) {
    if (isNotFound(err)) return { state: "gone" };
    throw err;
  }
  if (!build) return { state: "gone" };
  const detail = build.buildStatus;
  if (build.buildComplete || (build.buildStatus && build.buildStatus !== "IN_PROGRESS")) {
    // A finished build keeps nothing running or billed.
    return detail ? { state: "gone", detail } : { state: "gone" };
  }
  const state = STARTING_PHASES.has(build.currentPhase ?? "") ? "starting" : "running";
  return build.currentPhase ? { state, detail: build.currentPhase } : { state };
}

export async function codebuildTeardown(
  calls: AwsCiCalls,
  region: string,
  handle: CiHandle,
): Promise<void> {
  try {
    await calls.json(region, "codebuild", `${TARGET}.StopBuild`, {
      id: handle.id,
    } satisfies StopBuildInput);
  } catch (err) {
    if (isNotFound(err)) return;
    // Stopping a build that has finished is refused; it is already done.
    if (code(err) === "InvalidInputException") {
      const { builds } = await getBuilds(calls, region, [handle.id]);
      if (!builds[0] || builds[0].buildComplete) return;
    }
    throw err;
  }
}

function tagsOf(build: Build): Record<string, string> | null {
  const raw = build.environment?.environmentVariables?.find((v) => v.name === TAGS_VARIABLE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return null;
  }
}

function isoOf(raw: unknown): string | undefined {
  if (typeof raw === "number") return new Date(raw * 1000).toISOString();
  return typeof raw === "string" ? raw : undefined;
}

/** Builds still running; stops paging past the longest a build can run. */
export async function codebuildListTagged(
  calls: AwsCiCalls,
  region: string,
  tagKey: string,
  now: number = Date.now(),
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  // A build ends within its queue time (60 minutes here) and its timeout.
  const oldest = now - (MAX_TIMEOUT_MINUTES + 60 + 60) * 60_000;
  let nextToken: string | undefined;
  try {
    do {
      const page: { ids?: string[]; nextToken?: string } = await calls.json(
        region,
        "codebuild",
        `${TARGET}.ListBuildsForProject`,
        // Newest first is the default; naming a sort order is refused once
        // the project has more than 100 builds.
        {
          projectName: CI_PROJECT,
          ...(nextToken ? { nextToken } : {}),
        } satisfies ListBuildsForProjectInput,
      );
      const ids = ensureArray(page.ids);
      let older = ids.length === 0;
      for (let i = 0; i < ids.length; i += 100) {
        const { builds } = await getBuilds(calls, region, ids.slice(i, i + 100));
        for (const build of builds) {
          const started = isoOf(build.startTime);
          if (started && Date.parse(started) < oldest) older = true;
          if (!build.id || build.buildComplete) continue;
          const tags = tagsOf(build);
          if (!tags || !(tagKey in tags)) continue;
          out.push({
            handle: handleOf(build.id, region),
            tags,
            ...(started ? { createdAt: started } : {}),
            live: true,
          });
        }
      }
      nextToken = older ? undefined : page.nextToken;
    } while (nextToken);
  } catch (err) {
    // No CI project here yet: nothing has run.
    if (isNotFound(err)) return [];
    throw err;
  }
  return out;
}
