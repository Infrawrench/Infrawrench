/**
 * CI jobs as one-off ECS tasks on Fargate: a task definition per job (the
 * image and the size), one `RunTask` with the host's bootstrap as the
 * container's command, and both removed when the job ends.
 *
 * **Wire shapes verified against the Amazon ECS API Reference, November
 * 2026** (JSON 1.1, target prefix `AmazonEC2ContainerServiceV20141113`,
 * through `jsonCall`; request bodies are typed by the SDK's own models):
 * - `RunTask`: `cluster`, `taskDefinition`, `launchType: FARGATE`, `count`,
 *   `clientToken` (idempotency, up to 64 characters),
 *   `networkConfiguration.awsvpcConfiguration.{subnets, assignPublicIp}`,
 *   `tags[].{key,value}`, `enableECSManagedTags`, `startedBy` (up to 128).
 *   Answers `tasks[]` and `failures[].{arn, reason, detail}`.
 * - `RegisterTaskDefinition`: `family`, `requiresCompatibilities: [FARGATE]`,
 *   `networkMode: awsvpc`, task-level `cpu`/`memory` (CPU units and MiB, as
 *   strings, from Fargate's table of pairs), `runtimePlatform`,
 *   `containerDefinitions[].{name, image, essential, entryPoint, command}`,
 *   `tags`. No `taskRoleArn` and no `executionRoleArn`: a public image with no
 *   log driver needs neither, and the job holds no AWS credentials.
 * - `DescribeTaskDefinition` (`include: [TAGS]`), `DeregisterTaskDefinition`
 *   and `DeleteTaskDefinitions` (an `INACTIVE` revision only).
 * - `DescribeTasks` (`include: [TAGS]`): `tasks[].{taskArn, lastStatus,
 *   stoppedReason, createdAt (epoch seconds), tags, taskDefinitionArn}`,
 *   `failures[].reason` `MISSING` for a task ECS no longer knows.
 * - `ListTasks` (`cluster`, `desiredStatus`, `nextToken`), `StopTask`
 *   (`cluster`, `task`, `reason`), `CreateCluster`, `DescribeClusters`.
 * - EC2 `DescribeSubnets` with `Filter.1.Name=default-for-az`: Fargate needs
 *   subnets, and the default VPC's default subnets reach the internet through
 *   its internet gateway when the task has a public IP.
 *
 * Fargate has no maximum run time of its own, so the container's command is
 * {@link ciContainerCommand}'s watchdog: the task stops when the job ends or
 * its time is up, whatever happens to the host.
 */
import type {
  CreateClusterRequest,
  DeleteTaskDefinitionsRequest,
  DeregisterTaskDefinitionRequest,
  DescribeClustersRequest,
  DescribeTaskDefinitionRequest,
  DescribeTasksRequest,
  ListTaskDefinitionsRequest,
  ListTasksRequest,
  RegisterTaskDefinitionRequest,
  RunTaskRequest,
  StopTaskRequest,
} from "@aws-sdk/client-ecs";
import {
  ciComputeKey,
  ciContainerCommand,
  parseCiContainerSize,
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

/** The cluster every CI task runs in, made on first use. It costs nothing. */
export const CI_CLUSTER = "infrawrench-ci";
/** Task definition families are `infrawrench-ci-<job key>`. */
const FAMILY_PREFIX = "infrawrench-ci-";
const TARGET = "AmazonEC2ContainerServiceV20141113";

export const ECS_DEFAULT_MACHINE = "2vcpu-4gb";
/** Docker's official `buildpack-deps:noble-curl` (Ubuntu 24.04 with curl), from ECR Public's mirror. */
export const ECS_DEFAULT_IMAGE = "public.ecr.aws/docker/library/buildpack-deps:noble-curl";

/** Every permission a CI job on Fargate needs, with what it is for. */
export const ECS_PERMISSIONS = {
  cluster: { permission: "ecs:CreateCluster", label: "Make the CI cluster on first use" },
  describeCluster: { permission: "ecs:DescribeClusters", label: "Find the CI cluster" },
  register: { permission: "ecs:RegisterTaskDefinition", label: "Describe the job's container" },
  describeDefinition: {
    permission: "ecs:DescribeTaskDefinition",
    label: "Reuse it when a start is retried",
  },
  listDefinitions: {
    permission: "ecs:ListTaskDefinitions",
    label: "Find leftover task definitions",
  },
  deregister: { permission: "ecs:DeregisterTaskDefinition", label: "Retire it when the job ends" },
  delete: { permission: "ecs:DeleteTaskDefinitions", label: "Delete it when the job ends" },
  run: { permission: "ecs:RunTask", label: "Start the job's task" },
  tag: { permission: "ecs:TagResource", label: "Tag it as a CI job's" },
  describe: { permission: "ecs:DescribeTasks", label: "Follow it" },
  list: { permission: "ecs:ListTasks", label: "Find leftovers" },
  stop: { permission: "ecs:StopTask", label: "Stop it when the job ends" },
  subnets: { permission: "ec2:DescribeSubnets", label: "Find the default VPC's subnets" },
} as const satisfies Record<string, CiMissingPermission>;

/**
 * Fargate's CPU and memory pairs (Linux): vCPUs to the memory range in GiB
 * and its step. From the "Task CPU and memory" table of the ECS guide.
 */
const FARGATE_SIZES: ReadonlyArray<{ vcpus: number; min: number; max: number; step: number }> = [
  { vcpus: 0.25, min: 0.5, max: 2, step: 0.5 },
  { vcpus: 0.5, min: 1, max: 4, step: 1 },
  { vcpus: 1, min: 2, max: 8, step: 1 },
  { vcpus: 2, min: 4, max: 16, step: 1 },
  { vcpus: 4, min: 8, max: 30, step: 1 },
  { vcpus: 8, min: 16, max: 60, step: 4 },
  { vcpus: 16, min: 32, max: 120, step: 8 },
];

/** Task-level `cpu` and `memory` for a `<n>vcpu-<m>gb` machine, or an error naming the pairs. */
export function fargateSize(machine: string): { cpu: string; memory: string } {
  const size = parseCiContainerSize(machine);
  const row = size ? FARGATE_SIZES.find((r) => r.vcpus === size.vcpus) : undefined;
  if (size && row) {
    const steps = (size.memoryGb - row.min) / row.step;
    // 0.25 vCPU also takes 0.5 GiB, the one pair off its step.
    const fits =
      size.memoryGb >= row.min &&
      size.memoryGb <= row.max &&
      (Number.isInteger(steps) || (row.vcpus === 0.25 && size.memoryGb === 1));
    if (fits) {
      return {
        cpu: String(Math.round(size.vcpus * 1024)),
        memory: String(Math.round(size.memoryGb * 1024)),
      };
    }
  }
  throw new Error(
    `Fargate sizes a task by vCPUs and memory, as \`<vCPUs>vcpu-<GiB>gb\` from its table of pairs (e.g. ${ECS_DEFAULT_MACHINE}, 4vcpu-8gb, 8vcpu-16gb), not \`${machine}\`.`,
  );
}

function code(err: unknown): string | undefined {
  return err instanceof AwsRequestError ? err.code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUnauthorized(err: unknown): boolean {
  const c = code(err);
  return c === "AccessDeniedException" || c === "AccessDenied" || c === "UnauthorizedOperation";
}

/** ECS's "no such thing" answers: a cluster, a task or a task definition. */
function isNotFound(err: unknown): boolean {
  const c = code(err);
  return (
    c === "ClusterNotFoundException" ||
    c === "ResourceNotFoundException" ||
    ((c === "InvalidParameterException" || c === "ClientException") &&
      /not found|does not exist|cannot be found|unable to describe task definition/i.test(
        errorText(err),
      ))
  );
}

function ecsTags(tags: Readonly<Record<string, string>>): Array<{ key: string; value: string }> {
  // ECS tag values are at most 256 characters, keys at most 128.
  return Object.entries(tags).map(([key, value]) => ({
    key: key.slice(0, 128),
    value: value.slice(0, 256),
  }));
}

function tagsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of ensureArray(raw) as Array<{ key?: unknown; value?: unknown }>) {
    if (typeof tag.key === "string") out[tag.key] = typeof tag.value === "string" ? tag.value : "";
  }
  return out;
}

/** ECS answers timestamps as epoch seconds. */
function isoOf(raw: unknown): string | undefined {
  if (typeof raw === "number") return new Date(raw * 1000).toISOString();
  return typeof raw === "string" ? raw : undefined;
}

function taskId(arn: string): string {
  return arn.split("/").pop() ?? arn;
}

function handleOf(arn: string, region: string, taskDefinition: string): CiHandle {
  const isTask = arn.includes(":task/");
  return {
    id: arn,
    region,
    label: isTask
      ? `aws ecs task ${taskId(arn)} (${region})`
      : `aws ecs task definition ${arn.split("/").pop() ?? arn} (${region})`,
    data: { kind: "container", cluster: CI_CLUSTER, taskDefinition },
  };
}

/** The task definition for a job, as RegisterTaskDefinition takes it. */
export function taskDefinitionRequest(spec: CiStartSpec): RegisterTaskDefinitionRequest {
  const { cpu, memory } = fargateSize(spec.machine ?? ECS_DEFAULT_MACHINE);
  const argv = ciContainerCommand(spec.bootstrap, spec.maxSeconds);
  return {
    family: `${FAMILY_PREFIX}${ciComputeKey(spec)}`,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu,
    memory,
    runtimePlatform: { operatingSystemFamily: "LINUX", cpuArchitecture: "X86_64" },
    containerDefinitions: [
      {
        name: "job",
        image: spec.image ?? ECS_DEFAULT_IMAGE,
        essential: true,
        // The entry point replaces the image's own, so any image with a
        // POSIX shell runs the bootstrap.
        entryPoint: argv.slice(0, 2),
        command: argv.slice(2),
      },
    ],
    tags: ecsTags({ ...spec.tags, Name: spec.name }),
  };
}

async function ensureCluster(calls: AwsCiCalls, region: string): Promise<void> {
  const described = await calls.json<{ clusters?: Array<{ status?: string }> }>(
    region,
    "ecs",
    `${TARGET}.DescribeClusters`,
    { clusters: [CI_CLUSTER] } satisfies DescribeClustersRequest,
  );
  if (ensureArray(described.clusters).some((c) => c.status === "ACTIVE")) return;
  try {
    await calls.json(region, "ecs", `${TARGET}.CreateCluster`, {
      clusterName: CI_CLUSTER,
    } satisfies CreateClusterRequest);
  } catch (err) {
    // Made by a start running at the same time.
    const again = await calls.json<{ clusters?: Array<{ status?: string }> }>(
      region,
      "ecs",
      `${TARGET}.DescribeClusters`,
      { clusters: [CI_CLUSTER] } satisfies DescribeClustersRequest,
    );
    if (!ensureArray(again.clusters).some((c) => c.status === "ACTIVE")) throw err;
  }
}

async function defaultSubnets(calls: AwsCiCalls, region: string): Promise<string[]> {
  const data = await calls.ec2<Record<string, unknown>>(region, "DescribeSubnets", {
    "Filter.1.Name": "default-for-az",
    "Filter.1.Value.1": "true",
  });
  const set = data["subnetSet"] as Record<string, unknown> | undefined;
  return (ensureArray(set?.["item"]) as Array<{ subnetId?: unknown }>)
    .flatMap((s) => (typeof s.subnetId === "string" ? [s.subnetId] : []))
    .slice(0, 16);
}

/** The job's task definition: the one a retried start registered, or a new one. */
async function taskDefinitionFor(
  calls: AwsCiCalls,
  region: string,
  spec: CiStartSpec,
): Promise<string> {
  const request = taskDefinitionRequest(spec);
  try {
    const found = await calls.json<{
      taskDefinition?: { taskDefinitionArn?: string; status?: string };
    }>(region, "ecs", `${TARGET}.DescribeTaskDefinition`, {
      taskDefinition: request.family,
    } satisfies DescribeTaskDefinitionRequest);
    const arn = found.taskDefinition?.taskDefinitionArn;
    if (arn && found.taskDefinition?.status === "ACTIVE") return arn;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  const registered = await calls.json<{ taskDefinition?: { taskDefinitionArn?: string } }>(
    region,
    "ecs",
    `${TARGET}.RegisterTaskDefinition`,
    request,
  );
  const arn = registered.taskDefinition?.taskDefinitionArn;
  if (!arn) throw new Error("ECS registered no task definition");
  return arn;
}

export async function ecsPreflight(calls: AwsCiCalls, region: string): Promise<CiPreflightResult> {
  const { missing, problems } = await awsCiPermissionCheck(calls, Object.values(ECS_PERMISSIONS));
  try {
    if ((await defaultSubnets(calls, region)).length === 0) {
      problems.push(
        `There is no default VPC in ${region}, whose subnets a CI task starts in. Create one in the VPC console (Actions, Create default VPC), or use another region.`,
      );
    }
  } catch (err) {
    if (!isUnauthorized(err)) {
      problems.push(`EC2 did not list the subnets in ${region}: ${errorText(err)}`);
    }
  }
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region };
}

export async function ecsStart(
  calls: AwsCiCalls,
  region: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  if (spec.gpu) {
    throw new Error("Fargate tasks have no GPUs: use the `vm` kind (EC2) for a GPU job.");
  }
  const subnets = await defaultSubnets(calls, region);
  if (subnets.length === 0) {
    throw new Error(
      `There is no default VPC in ${region}, whose subnets a CI task starts in. Create one in the VPC console, or use another region.`,
    );
  }
  await ensureCluster(calls, region);
  const taskDefinition = await taskDefinitionFor(calls, region, spec);
  const body = {
    cluster: CI_CLUSTER,
    taskDefinition,
    launchType: "FARGATE",
    count: 1,
    // The job's key makes the start idempotent: a retry after a lost
    // answer gets the same task rather than a second one.
    clientToken: ciComputeKey(spec),
    startedBy: "infrawrench-ci",
    networkConfiguration: {
      // A public IP is how a task in a default subnet reaches the internet
      // (the image registry and the host); nothing listens on it.
      awsvpcConfiguration: { subnets, assignPublicIp: "ENABLED" },
    },
    tags: ecsTags({ ...spec.tags, Name: spec.name }),
    enableECSManagedTags: true,
  } satisfies RunTaskRequest;
  const data = await calls.json<{
    tasks?: Array<{ taskArn?: string }>;
    failures?: Array<{ reason?: string; detail?: string }>;
  }>(region, "ecs", `${TARGET}.RunTask`, body);
  const arn = ensureArray(data.tasks)[0]?.taskArn;
  if (!arn) {
    const failure = ensureArray(data.failures)[0];
    // The task never started, so its definition has nothing to wait for.
    await removeTaskDefinition(calls, region, taskDefinition).catch(() => {});
    throw new Error(
      `ECS started no task${failure ? `: ${[failure.reason, failure.detail].filter(Boolean).join(", ")}` : ""}`,
    );
  }
  return handleOf(arn, region, taskDefinition);
}

interface EcsTask {
  taskArn?: string;
  taskDefinitionArn?: string;
  lastStatus?: string;
  stoppedReason?: string;
  createdAt?: unknown;
  tags?: unknown;
}

async function describeTasks(
  calls: AwsCiCalls,
  region: string,
  arns: readonly string[],
): Promise<{ tasks: EcsTask[]; missing: string[] }> {
  const data = await calls.json<{
    tasks?: EcsTask[];
    failures?: Array<{ arn?: string; reason?: string }>;
  }>(region, "ecs", `${TARGET}.DescribeTasks`, {
    cluster: CI_CLUSTER,
    tasks: [...arns],
    include: ["TAGS"],
  } satisfies DescribeTasksRequest);
  return {
    tasks: ensureArray(data.tasks),
    missing: ensureArray(data.failures).flatMap((f) =>
      f.reason === "MISSING" && f.arn ? [f.arn] : [],
    ),
  };
}

export async function ecsStatus(
  calls: AwsCiCalls,
  region: string,
  handle: CiHandle,
): Promise<CiComputeStatus> {
  if (!handle.id.includes(":task/")) return { state: "gone" };
  let task: EcsTask | undefined;
  try {
    task = (await describeTasks(calls, region, [handle.id])).tasks[0];
  } catch (err) {
    if (isNotFound(err)) return { state: "gone" };
    throw err;
  }
  if (!task) return { state: "gone" };
  const status = task.lastStatus ?? "";
  const state: CiComputeStatus["state"] =
    status === "PROVISIONING" || status === "PENDING" || status === "ACTIVATING"
      ? "starting"
      : status === "RUNNING"
        ? "running"
        : // A stopped Fargate task keeps nothing running or billed.
          status === "STOPPED" || status === "DELETED"
          ? "gone"
          : "stopped";
  return task.stoppedReason ? { state, detail: task.stoppedReason } : { state };
}

/** Retire a task definition and delete it. Both succeed when it is already gone. */
async function removeTaskDefinition(
  calls: AwsCiCalls,
  region: string,
  taskDefinition: string,
): Promise<void> {
  try {
    await calls.json(region, "ecs", `${TARGET}.DeregisterTaskDefinition`, {
      taskDefinition,
    } satisfies DeregisterTaskDefinitionRequest);
  } catch (err) {
    if (!isNotFound(err) && !/INACTIVE|already/i.test(errorText(err))) throw err;
  }
  try {
    // Answers per-definition `failures` rather than throwing for one it
    // cannot delete (already deleted, or still in use).
    await calls.json(region, "ecs", `${TARGET}.DeleteTaskDefinitions`, {
      taskDefinitions: [taskDefinition],
    } satisfies DeleteTaskDefinitionsRequest);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

export async function ecsTeardown(
  calls: AwsCiCalls,
  region: string,
  handle: CiHandle,
): Promise<void> {
  if (handle.id.includes(":task/")) {
    try {
      await calls.json(region, "ecs", `${TARGET}.StopTask`, {
        cluster: handle.data?.["cluster"] ?? CI_CLUSTER,
        task: handle.id,
        reason: "Infrawrench CI: the job ended",
      } satisfies StopTaskRequest);
    } catch (err) {
      // A task that has already stopped, or that ECS has forgotten, is done.
      if (!isNotFound(err) && !/stopped|STOPPED/.test(errorText(err))) throw err;
    }
  }
  const taskDefinition = handle.data?.["taskDefinition"];
  if (taskDefinition) await removeTaskDefinition(calls, region, taskDefinition);
}

export async function ecsListTagged(
  calls: AwsCiCalls,
  region: string,
  tagKey: string,
): Promise<CiTaggedCompute[]> {
  const out: CiTaggedCompute[] = [];
  const running = new Set<string>();
  const arns: string[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const page: { taskArns?: string[]; nextToken?: string } = await calls.json(
        region,
        "ecs",
        `${TARGET}.ListTasks`,
        {
          cluster: CI_CLUSTER,
          desiredStatus: "RUNNING",
          maxResults: 100,
          ...(nextToken ? { nextToken } : {}),
        } satisfies ListTasksRequest,
      );
      arns.push(...ensureArray(page.taskArns));
      nextToken = page.nextToken;
    } while (nextToken);
  } catch (err) {
    // No cluster yet: nothing has run here.
    if (!isNotFound(err)) throw err;
  }
  for (let i = 0; i < arns.length; i += 100) {
    const { tasks } = await describeTasks(calls, region, arns.slice(i, i + 100));
    for (const task of tasks) {
      const tags = tagsOf(task.tags);
      if (!task.taskArn || !(tagKey in tags)) continue;
      if (task.taskDefinitionArn) running.add(task.taskDefinitionArn);
      delete tags["Name"];
      const createdAt = isoOf(task.createdAt);
      out.push({
        handle: handleOf(task.taskArn, region, task.taskDefinitionArn ?? ""),
        tags,
        ...(createdAt ? { createdAt } : {}),
        live: task.lastStatus !== "STOPPED" && task.lastStatus !== "DELETED",
      });
    }
  }
  // Task definitions whose task has stopped and that nothing retired: what a
  // lost teardown leaves.
  nextToken = undefined;
  do {
    const page: { taskDefinitionArns?: string[]; nextToken?: string } = await calls.json(
      region,
      "ecs",
      `${TARGET}.ListTaskDefinitions`,
      {
        familyPrefix: FAMILY_PREFIX,
        status: "ACTIVE",
        maxResults: 100,
        ...(nextToken ? { nextToken } : {}),
      } satisfies ListTaskDefinitionsRequest,
    );
    for (const arn of ensureArray(page.taskDefinitionArns)) {
      if (running.has(arn)) continue;
      const found = await calls.json<{
        taskDefinition?: { registeredAt?: unknown };
        tags?: unknown;
      }>(region, "ecs", `${TARGET}.DescribeTaskDefinition`, {
        taskDefinition: arn,
        include: ["TAGS"],
      } satisfies DescribeTaskDefinitionRequest);
      const tags = tagsOf(found.tags);
      if (!(tagKey in tags)) continue;
      delete tags["Name"];
      const createdAt = isoOf(found.taskDefinition?.registeredAt);
      out.push({
        handle: handleOf(arn, region, arn),
        tags,
        ...(createdAt ? { createdAt } : {}),
        live: false,
      });
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return out;
}
