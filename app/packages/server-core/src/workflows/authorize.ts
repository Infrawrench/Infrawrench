/**
 * Permission policy for what a workflow may do, and the gate that enforces it.
 *
 * The problem this closes
 * ----------------------
 * A workflow's host bridge reaches the org's real accounts: it can create and
 * delete resources, run SSH commands, execute SQL, and write to storage. Until
 * this module existed the only check on any of that was `workflows:write` — the
 * permission to *run a workflow at all* — which the built-in Member role holds.
 * The same operations through the HTTP API or the chat/MCP tool layer require
 * `resources:write`, `resources:delete`, `resources:execute`, `storage:write`.
 * So `infra.…delete()` was a supported way for a Member to do what
 * `delete_resource` refuses them, and cron made it durable.
 *
 * The fix is to run each workflow *as somebody*, and to check each operation
 * against that person's effective permissions — the same
 * `resolveEffectivePermissions` the API middleware and the tool layer use, so
 * the three surfaces cannot drift.
 *
 * Who a run acts as
 * -----------------
 * A manual run acts as the person who pressed the button. An automated run
 * (cron, git push, a budget crossing) has no such person, so it acts as the
 * workflow's **author** — `workflows.created_by_user_id`. That is the honest
 * answer: the author is who chose what the automation does, and it means a
 * workflow cannot gain authority by being put on a schedule. If the author has
 * since left the org their membership is gone, `resolveEffectivePermissions`
 * returns nothing, and the privileged operations start failing — which is the
 * correct outcome and a visible one, in the run's error, rather than a silent
 * continuation of a departed employee's access.
 *
 * @see file://../permissions/catalog.ts — the permission strings and matcher.
 * @see file://../../../workflow-runtime/src/host.ts — `dispatch`, which calls the gate.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { workflows } from "../db/schema";
import { hasPermission } from "../permissions/catalog";
import { resolveEffectivePermissions } from "../permissions";

/**
 * The permission each sandbox operation requires, or `null` where none does.
 *
 * Kept deliberately in step with the tool registry (`web/src/tools/*.ts`): a
 * workflow calling `infra.…delete()` and an agent calling `delete_resource`
 * are the same act against the same infrastructure, and a member who cannot do
 * it one way should not be able to do it the other. Where a mapping is not
 * obvious the tool it mirrors is named.
 *
 * `null` entries are the operations that touch nothing outside the run: its own
 * logs, output, metrics, prompts, and the notification helpers. `fetch` is
 * `null` because it leaves through the egress proxy, which refuses private
 * address space regardless of who is asking (see ./fetch.ts).
 *
 * Exhaustive over `dispatch`'s switch. An unlisted method is denied rather than
 * allowed — see {@link buildWorkflowAuthorizer}.
 */
export const WORKFLOW_OPERATION_PERMISSIONS: Readonly<Record<string, string | null>> = {
  // --- discovery + reads -------------------------------------------------
  "accounts.list": "accounts:read",
  "resource.list": "resources:read",
  "resource.get": "resources:read",
  "resource.regions": "resources:read",
  // Mirrors `get_resource_outputs`: an output can be a connection string or a
  // generated password, so reading one is a secret read, not a resource read.
  "resource.resolveOutput": "secrets:read",
  "resource.describe": "resources:read",
  "resource.logs": "resources:read",
  "resource.metrics": "resources:read",
  "resource.getManifest": "resources:read",

  // --- mutations ---------------------------------------------------------
  "resource.create": "resources:write",
  "resource.update": "resources:write",
  "resource.delete": "resources:delete",
  // Mirrors `apply_manifest`.
  "resource.applyManifest": "resources:write",
  "resource.publish": "resources:write",
  "account.importYaml": "resources:write",

  // --- execution against live infrastructure -----------------------------
  // All of these reach a running system and can change it, which is what
  // `resources:execute` means everywhere else (`ssh_exec`, `sql_execute`,
  // `kv_command`). The read/write split inside KV is not modelled for the same
  // reason `kv_command` doesn't model it: one connection, one permission.
  "resource.query": "resources:execute",
  "resource.nosql": "resources:execute",
  "kv.list": "resources:execute",
  "kv.get": "resources:execute",
  "kv.put": "resources:execute",
  "kv.delete": "resources:execute",
  "ssh.exec": "resources:execute",
  "ssh.streamStart": "resources:execute",
  "ssh.streamRead": "resources:execute",
  "ssh.streamClose": "resources:execute",
  "ssh.probe": "resources:execute",

  // --- object + file storage ---------------------------------------------
  "storage.list": "storage:read",
  "storage.get": "storage:read",
  "sftp.list": "storage:read",
  "sftp.get": "storage:read",
  "sftp.put": "storage:write",
  "sftp.mkdir": "storage:write",
  "sftp.delete": "storage:write",

  // --- cost data ---------------------------------------------------------
  "costs.write": "costs:write",
  // Reporting a business metric is the same class of act as reporting spend —
  // it writes a number the organization's unit costs and margins are computed
  // from — so it rides the same permission rather than earning its own.
  "businessMetrics.write": "costs:write",

  // --- Infrafile deploy stages -------------------------------------------
  // Unreachable through `runOrgWorkflow` today — deployments build their own
  // Infrafile host and gate at `deployment-ws.ts` — but mapped so that wiring
  // this gate into that path later is a one-line change rather than a policy
  // decision made under time pressure.
  "infrafile.plan": "deployments:plan",
  "infrafile.build": "deployments:write",
  "infrafile.push": "deployments:write",
  "infrafile.run": "deployments:write",
  "infrafile.copyTo": "deployments:write",
  "infrafile.envs": "deployments:read",
  "infrafile.dockerfile": "deployments:read",
  "infrafile.select": null,
  "infrafile.ask": null,
  "infrafile.note": null,

  // --- the run talking to itself -----------------------------------------
  fetch: null,
  // `null` like fetch: an AI call touches nothing in the org — the prompt is
  // all the model sees — and its spend is bounded by the org's monthly AI cap
  // (billing/ai-usage.ts), which is billing policy, not a role's permission.
  ai: null,
  prompt: null,
  line: null,
  log: null,
  output: null,
  "metric.get": null,
  "metric.set": null,
  page: null,
  "page.clear": null,
  "approval.wait": null,
};

/**
 * Thrown into the workflow when an operation exceeds the run's authority.
 *
 * The message names the missing permission because the author is the one who
 * has to act on it, and "forbidden" would leave them guessing which of a dozen
 * calls in the script was refused and what to ask their admin for.
 */
export class WorkflowPermissionError extends Error {
  constructor(
    readonly method: string,
    readonly permission: string,
  ) {
    super(
      `Not permitted: ${method} requires the "${permission}" permission. This run acts with ` +
        `the permissions of the user it runs on behalf of — whoever triggered it, or the ` +
        `workflow's author for scheduled and event-driven runs — and they do not hold it.`,
    );
    this.name = "WorkflowPermissionError";
  }
}

/** Thrown when `dispatch` grows an operation nobody added to the policy map. */
export class WorkflowUnmappedOperationError extends Error {
  constructor(readonly method: string) {
    super(
      `Not permitted: the operation "${method}" has no entry in the workflow permission ` +
        `policy, so it is refused. This is a bug in Infrawrench, not in your workflow — ` +
        `add it to WORKFLOW_OPERATION_PERMISSIONS.`,
    );
    this.name = "WorkflowUnmappedOperationError";
  }
}

/** Who a run acts as: an explicit user, or the workflow's author by default. */
export interface WorkflowPrincipal {
  /**
   * The user whose permissions bound the run. Manual runs pass the person who
   * triggered it; automated triggers leave it unset and the workflow's author
   * is used instead.
   */
  userId?: string | undefined;
}

/**
 * Resolve the effective permissions a run should execute under, then return the
 * synchronous gate `dispatch` calls per operation.
 *
 * Resolution happens once, here, rather than per operation: the gate runs on
 * every RPC — including the per-statement `line` hook on debug runs — so it
 * cannot be a database round trip. The cost is that a role change mid-run does
 * not take effect until the next run, which for a bounded run is the right
 * trade (the tool layer makes the opposite choice because a chat turn can stay
 * open across a human approval, which a workflow run cannot).
 */
export async function buildWorkflowAuthorizer(
  organizationId: string,
  workflowId: string,
  principal: WorkflowPrincipal = {},
): Promise<(method: string) => void> {
  let userId = principal.userId;
  if (!userId) {
    const [wf] = await db
      .select({ createdByUserId: workflows.createdByUserId })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);
    userId = wf?.createdByUserId ?? undefined;
  }

  // No resolvable principal means no authority. This is reachable — a workflow
  // whose author's row predates `created_by_user_id`, or whose author has been
  // removed from the org — and denying is the only safe reading: the
  // alternative is an automation running unbounded on behalf of nobody.
  const granted = userId
    ? (await resolveEffectivePermissions(organizationId, { kind: "user", userId })).permissions
    : [];

  return (method: string) => {
    const required = WORKFLOW_OPERATION_PERMISSIONS[method];
    // `undefined` means the method is absent from the map, not that it is
    // unrestricted — `null` is how a method says that. A new `case` in
    // `dispatch` therefore fails closed and loudly the first time it runs,
    // instead of quietly shipping an ungated capability.
    if (required === undefined) {
      throw new WorkflowUnmappedOperationError(method);
    }
    if (required === null) return;
    if (!hasPermission(granted, required)) {
      throw new WorkflowPermissionError(method, required);
    }
  };
}
