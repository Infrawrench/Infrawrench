/**
 * Desktop renderer-side cloud WorkflowClient.
 *
 * With an org selected, workflows come from the org rather than local SQLite:
 * the same swap accounts, dashboards, and costs already make. The isolate runs
 * server-side, so unlike `./workflow-client` there is no host to build here:
 * CRUD, typings, runs, and metrics are plain HTTP (typed calls to the
 * contract's `workflows`, `workflowSecrets` and `workflowApprovals` domains
 * over the cloud transport; the calls whose answer the contract leaves
 * undocumented, and the GitHub reads, still go through the
 * `cloud_*_workflow*` / `cloud_github_*` IPC), and a manual run opens the
 * cloud websocket so the
 * editor keeps its breakpoints, stepping, live logs, and `infra.prompt`: the
 * browser's `lib/workflow-client.ts` drives the identical `workflow:*` frames.
 *
 * The one desktop difference is the prompt: Electron's `window.prompt` is a
 * no-op, so prompts go through the same modal local runs use.
 */
import type { PromptSpec } from "@infrawrench/workflow-runtime/client";
import type { GitRepoOption } from "@infrawrench/ui/workflows";
import type {
  ApprovalsClient,
  DebugSession,
  WorkflowApprovalRow,
  WorkflowApprovalStatus,
  WorkflowClient,
  WorkflowMetricRow,
  WorkflowRunResult,
  WorkflowRunRow,
  WorkflowSaveBody,
  WorkflowSecretSummary,
  WorkflowSummary,
} from "@infrawrench/ui/workflows";

import { Effect, Schema } from "effect";
import { cloudClient } from "./cloud-client";
import { invoke } from "./invoke";
import { runRpc } from "./rpc/client";
import { getCloudWsToken } from "./cloud-auth";
import { getCloudWsUrl } from "./cloud-ws";
import { requestWorkflowPrompt } from "@infrawrench/ui/workflows/prompt-bridge";

const workflows = () => cloudClient("workflows").workflows;
const workflowSecrets = () => cloudClient("workflowSecrets").workflowSecrets;
const workflowApprovals = () => cloudClient("workflowApprovals").workflowApprovals;

export async function listCloudWorkflows(orgId: string): Promise<WorkflowSummary[]> {
  return invoke("cloud_list_workflows", { orgId });
}

export async function pinCloudWorkflow(
  orgId: string,
  dashboardId: string,
  workflowId: string,
): Promise<void> {
  await runRpc(
    cloudClient("dashboards").dashboardPins.pinWorkflow({
      params: { orgId },
      payload: { dashboardId, workflowId },
    }),
  );
}

export async function unpinCloudWorkflow(
  orgId: string,
  dashboardId: string,
  workflowId: string,
): Promise<void> {
  await runRpc(
    cloudClient("dashboards").dashboardPins.unpinWorkflow({
      params: { orgId },
      payload: { dashboardId, workflowId },
    }),
  );
}

/** The approval requests, newest first; `workflowId` narrows them to one workflow's runs. */
function listCloudWorkflowApprovals(
  orgId: string,
  query: { status?: WorkflowApprovalStatus; workflowId?: string },
): Promise<WorkflowApprovalRow[]> {
  return runRpc(
    workflowApprovals().list({
      params: { orgId },
      query: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.workflowId ? { workflowId: query.workflowId } : {}),
      },
    }),
  );
}

function decideCloudWorkflowApproval(
  orgId: string,
  approvalId: string,
  decision: "approve" | "deny",
): Promise<WorkflowApprovalRow> {
  const request = { params: { orgId, id: approvalId } };
  return runRpc(
    decision === "deny" ? workflowApprovals().deny(request) : workflowApprovals().approve(request),
  );
}

/** The secret was saved but its answer named no id, so its value cannot be written. */
class WorkflowSecretSaveError extends Schema.TaggedError<WorkflowSecretSaveError>()(
  "WorkflowSecretSaveError",
  { message: Schema.String },
) {}

/**
 * Create the secret (or rename it, with `id`), then write its value: two
 * calls, since the value has its own write-only endpoint.
 */
function upsertCloudWorkflowSecret(
  orgId: string,
  input: { id?: string; name: string; value: string },
): Promise<WorkflowSecretSummary> {
  return runRpc(
    Effect.gen(function* () {
      const { id, name, value } = input;
      const secret = id
        ? yield* workflowSecrets().update({ params: { orgId, id }, payload: { name } })
        : yield* workflowSecrets().create({ params: { orgId }, payload: { name } });
      if (!secret.id) {
        return yield* new WorkflowSecretSaveError({
          message: "Workflow secret save returned no id",
        });
      }
      return yield* workflowSecrets().writeValue({
        params: { orgId, id: secret.id },
        payload: { value },
      });
    }),
  );
}

/** GitHub App connection state for the git-trigger picker. */
export async function getCloudGithubStatus(orgId: string): Promise<{ configured: boolean }> {
  return invoke("cloud_github_status", { orgId });
}

export async function listCloudGithubRepos(orgId: string): Promise<GitRepoOption[]> {
  return invoke("cloud_github_repos", { orgId });
}

/**
 * `returnTo` is where the GitHub App install flow sends the user back to:
 * "workflows" for git triggers, "agents" for the session repo picker.
 */
export async function getCloudGithubInstallUrl(
  orgId: string,
  returnTo: "workflows" | "agents" = "workflows",
): Promise<string | null> {
  return invoke("cloud_github_install_url", { orgId, returnTo });
}

/**
 * Debug run over the cloud websocket: this side owns breakpoints and stepping,
 * the server blocks before each instrumented line and resumes on
 * `workflow:continue`.
 */
async function runDebug(
  orgId: string,
  id: string,
  debug: DebugSession,
): Promise<{ runId: string; result: WorkflowRunResult }> {
  const token = await getCloudWsToken(orgId);
  if (!token) throw new Error("Not authenticated to Infrawrench Cloud");
  const wsUrl = await getCloudWsUrl();
  const ws = new WebSocket(`${wsUrl}/api/ws?token=${encodeURIComponent(token)}`);

  let stepping = false;
  let settled = false;
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      try {
        ws.close();
      } catch {
        // already closing
      }
    };
    const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

    debug.resume = () => {
      debug.onResumed?.();
      send({ type: "workflow:continue" });
    };
    debug.step = () => {
      stepping = true;
      debug.onResumed?.();
      send({ type: "workflow:continue" });
    };
    debug.stop = () => send({ type: "workflow:stop" });

    ws.addEventListener("open", () => send({ type: "workflow:run", workflowId: id }));
    ws.addEventListener("error", () =>
      finish(() => reject(new Error("Workflow connection failed"))),
    );
    ws.addEventListener("close", () =>
      finish(() => reject(new Error("Workflow connection closed"))),
    );
    ws.addEventListener("message", (ev) => {
      let m: {
        type: string;
        line?: number;
        entry?: unknown;
        spec?: PromptSpec;
        runId?: string;
        result?: unknown;
        message?: string;
      };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (m.type) {
        case "workflow:line": {
          const line = m.line ?? 0;
          debug.onLine?.(line);
          if (debug.breakpoints.has(line) || stepping) {
            stepping = false;
            debug.onPaused?.(line); // user drives resume/step/stop -> continue
          } else {
            send({ type: "workflow:continue" });
          }
          break;
        }
        case "workflow:log":
          debug.onLog?.(m.entry as Parameters<NonNullable<DebugSession["onLog"]>>[0]);
          break;
        case "workflow:prompt":
          void requestWorkflowPrompt(m.spec ?? { message: "Input" }).then((value) =>
            send({ type: "workflow:prompt:response", value }),
          );
          break;
        case "workflow:result":
          finish(() => resolve({ runId: m.runId ?? "", result: m.result as WorkflowRunResult }));
          break;
        case "workflow:error":
          finish(() => reject(new Error(m.message ?? "Workflow run failed")));
          break;
      }
    });
  });
}

/**
 * Org-wide approvals inbox transport. Same routes the browser hits, over the
 * cloud transport. Cloud-only: a local
 * workflow runs in this renderer and has no suspended server-side run to
 * approve, so local mode never constructs one.
 */
export function createCloudApprovalsClient(orgId: string): ApprovalsClient {
  return {
    list: (status?: WorkflowApprovalStatus) =>
      listCloudWorkflowApprovals(orgId, status ? { status } : {}),
    decide: (approvalId: string, decision: "approve" | "deny") =>
      decideCloudWorkflowApproval(orgId, approvalId, decision),
  };
}

export function createCloudWorkflowClient(orgId: string): WorkflowClient {
  const workflowBody = (body: WorkflowSaveBody) => {
    const { assignedSecretIds, ...rest } = body;
    return assignedSecretIds === undefined ? rest : { ...rest, secretIds: assignedSecretIds };
  };
  return {
    list: () => listCloudWorkflows(orgId),
    create: (body: WorkflowSaveBody) =>
      invoke<WorkflowSummary>("cloud_create_workflow", { orgId, body: workflowBody(body) }),
    update: (id: string, body: WorkflowSaveBody) =>
      invoke<WorkflowSummary>("cloud_update_workflow", { orgId, id, body: workflowBody(body) }),
    remove: async (id: string) => {
      await runRpc(workflows().delete({ params: { orgId, id } }));
    },
    getTypings: async (id: string, opts?: { enrich?: boolean }) => {
      const res = await runRpc(
        workflows().typings({
          params: { orgId, id },
          query: opts?.enrich === true ? { enrich: "1" } : {},
        }),
      );
      return res.dts;
    },
    listRuns: (id: string) => invoke<WorkflowRunRow[]>("cloud_workflow_runs", { orgId, id }),
    listMetrics: (id: string) =>
      invoke<WorkflowMetricRow[]>("cloud_workflow_metrics", { orgId, id }),
    getAssignedSecrets: async (id: string) => {
      const { secretIds, secrets }: { secretIds: string[]; secrets: WorkflowSecretSummary[] } =
        await runRpc(workflows().getSecrets({ params: { orgId, id } }));
      return { assignedSecretIds: secretIds, secrets };
    },
    listSecrets: (): Promise<WorkflowSecretSummary[]> =>
      runRpc(workflowSecrets().list({ params: { orgId } })),
    upsertSecret: ({ id, name, value }) =>
      upsertCloudWorkflowSecret(orgId, { ...(id ? { id } : {}), name, value }),
    deleteSecret: async (id: string) => {
      await runRpc(workflowSecrets().delete({ params: { orgId, id } }));
    },
    run: (id: string, debug?: DebugSession) =>
      debug
        ? runDebug(orgId, id, debug)
        : invoke<{ runId: string; result: WorkflowRunResult }>("cloud_run_workflow", { orgId, id }),
    listPendingApprovals: (workflowId: string) =>
      listCloudWorkflowApprovals(orgId, { status: "pending", workflowId }),
    decideApproval: (approvalId: string, decision: "approve" | "deny") =>
      decideCloudWorkflowApproval(orgId, approvalId, decision),
  };
}
