import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";

/**
 * Cloudflare Workflows (`/accounts/{id}/workflows`): durable multi-step
 * executions declared by a Worker. A workflow is created by deploying the
 * Worker that exports it, so the plugin lists, inspects and deletes
 * workflows, and drives their instances (trigger, pause, resume, terminate,
 * restart) rather than offering a create form.
 *
 * The REST `PUT /workflows/{name}` that would edit one is the deploy path
 * wrangler uses; it takes `class_name`, `script_name` and `limits`, and the
 * GET response does not return `limits`, so a round-trip edit would silently
 * reset the step limit. Editing is therefore left to a redeploy.
 */

/** Instance states, as returned by the instance list and status endpoints. */
export type WorkflowInstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waitingForPause"
  | "waiting"
  | "rollingBack";

/** Lifecycle changes `PATCH .../instances/{id}/status` accepts. */
export type WorkflowInstanceAction = "pause" | "resume" | "terminate" | "restart";

export const WORKFLOW_INSTANCE_ACTIONS: readonly WorkflowInstanceAction[] = [
  "pause",
  "resume",
  "terminate",
  "restart",
];

export interface WorkflowInstanceSummary {
  id: string;
  status: string;
  triggerSource: string;
  createdOn: string;
  startedOn: string;
  endedOn: string;
  versionId: string;
}

/** How many recent instances the detail page shows. */
export const WORKFLOW_INSTANCE_PAGE = 25;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function mapWorkflow(w: Record<string, unknown>, accountId: string): ResourceInstance {
  const name = str(w["name"]);
  const counts = (w["instances"] as Record<string, unknown> | undefined) ?? {};
  const schedules = Array.isArray(w["schedules"])
    ? (w["schedules"] as Array<Record<string, unknown>>)
    : [];
  const nextRuns = schedules
    .map((s) => str(s["next_instance"]))
    .filter(Boolean)
    .sort();
  return {
    id: `${accountId}:workflow:${name}`,
    pluginId: "cloudflare",
    resourceTypeId: "workflow",
    accountId,
    displayName: name,
    fields: {
      name,
      className: str(w["class_name"]),
      scriptName: str(w["script_name"]),
      running: num(counts["running"]),
      queued: num(counts["queued"]),
      waiting: num(counts["waiting"]) + num(counts["waitingForPause"]),
      paused: num(counts["paused"]),
      errored: num(counts["errored"]),
      complete: num(counts["complete"]),
      terminated: num(counts["terminated"]),
      schedules: schedules
        .map((s) => str(s["cron"]))
        .filter(Boolean)
        .join(", "),
      nextScheduledRun: nextRuns[0] ?? "",
      lastTriggered: str(w["triggered_on"]),
      workflowId: str(w["id"]),
    },
    resolvedOutputs: { workflowName: name },
    secretStates: [],
    externalId: name,
    createdAt: str(w["created_on"]) || new Date().toISOString(),
    updatedAt: str(w["modified_on"]) || new Date().toISOString(),
  };
}

export async function listWorkflows(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const results: ResourceInstance[] = [];
      for await (const w of api.cf.workflows.list({ account_id })) {
        results.push(mapWorkflow(asRecord(w), accountId));
      }
      return results;
    },
    "Workflows",
    "Account · Workers Scripts:Read",
  );
}

export async function getWorkflow(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const w = await api.cf.workflows.get(externalId, { account_id });
  return mapWorkflow(asRecord(w), accountId);
}

export async function deleteWorkflow(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.workflows.delete(externalId, { account_id });
}

/**
 * The most recent instances, newest first. The SDK iterator auto-paginates,
 * so we stop after one page's worth rather than walking the whole history.
 */
export async function listRecentInstances(
  api: CloudflareApi,
  workflowName: string,
  limit = WORKFLOW_INSTANCE_PAGE,
): Promise<{ instances: WorkflowInstanceSummary[]; truncated: boolean }> {
  const account_id = await api.getAccountId();
  const instances: WorkflowInstanceSummary[] = [];
  let truncated = false;
  for await (const raw of api.cf.workflows.instances.list(workflowName, {
    account_id,
    per_page: limit,
    direction: "desc",
  })) {
    if (instances.length >= limit) {
      truncated = true;
      break;
    }
    const i = asRecord(raw);
    instances.push({
      id: str(i["id"]),
      status: str(i["status"]),
      triggerSource: str(i["trigger_source"]),
      createdOn: str(i["created_on"]),
      startedOn: str(i["started_on"]),
      endedOn: str(i["ended_on"]),
      versionId: str(i["version_id"]),
    });
  }
  return { instances, truncated };
}

/** Start a new instance with no params (`POST .../instances`). */
export async function triggerInstance(api: CloudflareApi, workflowName: string): Promise<string> {
  const account_id = await api.getAccountId();
  const res = await api.cf.workflows.instances.create(workflowName, { account_id });
  return str(asRecord(res)["id"]);
}

/** Pause, resume, terminate or restart one instance (`PATCH .../status`). */
export async function changeInstanceStatus(
  api: CloudflareApi,
  workflowName: string,
  instanceId: string,
  action: WorkflowInstanceAction,
): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.workflows.instances.status.edit(workflowName, instanceId, {
    account_id,
    status: action,
  });
}

/**
 * Which lifecycle actions make sense for an instance in a given state.
 * Cloudflare rejects, for instance, resuming a running instance; offering only
 * the valid transitions keeps the row buttons from leading to an error toast.
 */
export function actionsForStatus(status: string): WorkflowInstanceAction[] {
  switch (status) {
    case "queued":
    case "running":
    case "waiting":
      return ["pause", "terminate", "restart"];
    case "paused":
    case "waitingForPause":
      return ["resume", "terminate", "restart"];
    case "errored":
    case "terminated":
    case "complete":
      return ["restart"];
    default:
      return [];
  }
}
