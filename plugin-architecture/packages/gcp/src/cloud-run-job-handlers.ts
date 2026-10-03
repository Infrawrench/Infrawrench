import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpClientContext } from "./shared.js";
import { formatGcpError } from "./utils.js";

/**
 * Cloud Run jobs (run.googleapis.com/v2) and Memorystore for Valkey
 * (memorystore.googleapis.com/v1) operations beyond list/create/delete:
 * running and cancelling job executions, the recent-executions table, and
 * the edit paths for both types.
 */

const RUN_API = "https://run.googleapis.com/v2";
const MEMORYSTORE_API = "https://memorystore.googleapis.com/v1";

export interface CloudRunJobExecutionSummary {
  name: string;
  status: string;
  createTime: string;
  completionTime: string;
  tasks: string;
  logUri: string;
}

async function post(ctx: GcpClientContext, url: string, action: string): Promise<void> {
  const tok = await ctx.token();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(await formatGcpError(action, res));
}

/** Start a new execution of the job with its configured template. */
export async function runCloudRunJob(
  ctx: GcpClientContext,
  resource: ResourceInstance,
): Promise<void> {
  const fullName = resource.externalId ?? "";
  if (!fullName) throw new Error("Cannot determine the Cloud Run job name");
  await post(ctx, `${RUN_API}/${fullName}:run`, "Run Cloud Run job");
}

/** Cancel the job's most recent execution (the one the lister reports). */
export async function cancelLatestCloudRunJobExecution(
  ctx: GcpClientContext,
  resource: ResourceInstance,
): Promise<void> {
  const fullName = resource.externalId ?? "";
  const execution = String(resource.fields["lastExecution"] ?? "");
  if (!fullName || !execution) throw new Error("This job has no execution to cancel");
  await post(
    ctx,
    `${RUN_API}/${fullName}/executions/${execution}:cancel`,
    "Cancel Cloud Run job execution",
  );
}

/** Derive a single status label from an Execution's task counters. */
function executionStatus(e: Record<string, unknown>): string {
  const failed = Number(e["failedCount"] ?? 0);
  const cancelled = Number(e["cancelledCount"] ?? 0);
  if (!e["completionTime"]) return Number(e["runningCount"] ?? 0) > 0 ? "Running" : "Pending";
  if (cancelled > 0) return "Cancelled";
  if (failed > 0) return "Failed";
  return "Succeeded";
}

/** The newest executions of a job, for the detail view's history table. */
export async function listCloudRunJobExecutions(
  ctx: GcpClientContext,
  resource: ResourceInstance,
  limit = 20,
): Promise<CloudRunJobExecutionSummary[]> {
  const fullName = resource.externalId ?? "";
  if (!fullName) return [];
  const data = await ctx.get<{ executions?: Array<Record<string, unknown>> }>(
    `${RUN_API}/${fullName}/executions?pageSize=${limit}`,
  );
  return (data.executions ?? []).slice(0, limit).map((e) => {
    const taskCount = Number(e["taskCount"] ?? 0);
    const succeeded = Number(e["succeededCount"] ?? 0);
    return {
      name:
        String(e["name"] ?? "")
          .split("/")
          .pop() ?? "",
      status: executionStatus(e),
      createTime: String(e["createTime"] ?? ""),
      completionTime: String(e["completionTime"] ?? ""),
      tasks: `${succeeded}/${taskCount}`,
      logUri: String(e["logUri"] ?? ""),
    };
  });
}

function intField(fields: Record<string, string>, key: string): number | undefined {
  const raw = fields[key];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a whole number`);
  return n;
}

/**
 * Edit a job. jobs.patch takes the whole Job (there is no updateMask), so
 * read the live job, change only the edited template values and send it back
 * with its etag, which makes a concurrent change elsewhere fail instead of
 * being silently overwritten.
 */
export async function updateCloudRunJob(
  ctx: GcpClientContext,
  resource: ResourceInstance,
  fields: Record<string, string>,
): Promise<void> {
  const fullName = resource.externalId ?? "";
  if (!fullName) throw new Error("Cannot determine the Cloud Run job name");
  const job = await ctx.get<Record<string, unknown>>(`${RUN_API}/${fullName}`);
  const execTemplate = (job["template"] as Record<string, unknown> | undefined) ?? {};
  const taskTemplate = (execTemplate["template"] as Record<string, unknown> | undefined) ?? {};
  const containers =
    (taskTemplate["containers"] as Array<Record<string, unknown>> | undefined) ?? [];

  const image = fields["image"]?.trim();
  if (image) {
    if (containers.length === 0) containers.push({ image });
    else containers[0] = { ...containers[0], image };
  }
  const taskCount = intField(fields, "taskCount");
  if (taskCount !== undefined) {
    if (taskCount < 1) throw new Error("A job needs at least one task");
    execTemplate["taskCount"] = taskCount;
  }
  const parallelism = intField(fields, "parallelism");
  if (parallelism !== undefined) execTemplate["parallelism"] = parallelism;
  const maxRetries = intField(fields, "maxRetries");
  if (maxRetries !== undefined) taskTemplate["maxRetries"] = maxRetries;
  const timeoutSeconds = intField(fields, "timeoutSeconds");
  if (timeoutSeconds !== undefined && timeoutSeconds > 0)
    taskTemplate["timeout"] = `${timeoutSeconds}s`;

  taskTemplate["containers"] = containers;
  execTemplate["template"] = taskTemplate;
  job["template"] = execTemplate;

  const tok = await ctx.token();
  const res = await fetch(`${RUN_API}/${fullName}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(job),
  });
  if (!res.ok) throw new Error(await formatGcpError("Update Cloud Run job", res));
}

/**
 * Edit a Valkey instance through instances.patch, sending only the fields
 * that actually changed so the updateMask never names an untouched one (a
 * no-op mask entry still starts a long-running update).
 */
export async function updateMemorystoreValkey(
  ctx: GcpClientContext,
  resource: ResourceInstance,
  fields: Record<string, string>,
): Promise<void> {
  const fullName = resource.externalId ?? "";
  if (!fullName) throw new Error("Cannot determine the Valkey instance name");
  const current = resource.fields;
  const body: Record<string, unknown> = {};
  const mask: string[] = [];

  for (const key of ["nodeType", "engineVersion"] as const) {
    const next = fields[key]?.trim();
    if (next && next !== String(current[key] ?? "")) {
      body[key] = next;
      mask.push(key === "nodeType" ? "node_type" : "engine_version");
    }
  }
  const shardCount = intField(fields, "shardCount");
  if (shardCount !== undefined && shardCount !== Number(current["shardCount"] ?? 0)) {
    if (String(current["mode"] ?? "") === "CLUSTER_DISABLED") {
      throw new Error("Cluster-mode-disabled Valkey instances always have exactly one shard");
    }
    if (shardCount < 1) throw new Error("A Valkey instance needs at least one shard");
    body["shardCount"] = shardCount;
    mask.push("shard_count");
  }
  const replicaCount = intField(fields, "replicaCount");
  if (replicaCount !== undefined && replicaCount !== Number(current["replicaCount"] ?? 0)) {
    if (replicaCount > 5) throw new Error("Valkey supports at most 5 replicas per shard");
    body["replicaCount"] = replicaCount;
    mask.push("replica_count");
  }
  const protection = fields["deletionProtectionEnabled"];
  if (protection !== undefined && protection !== "") {
    const next = protection === "true";
    if (next !== (current["deletionProtectionEnabled"] === true)) {
      body["deletionProtectionEnabled"] = next;
      mask.push("deletion_protection_enabled");
    }
  }
  if (mask.length === 0) return;

  const tok = await ctx.token();
  const res = await fetch(`${MEMORYSTORE_API}/${fullName}?updateMask=${mask.join(",")}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await formatGcpError("Update Memorystore Valkey instance", res));
}
