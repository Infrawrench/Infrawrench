/**
 * Desktop renderer-side cloud WorkflowClient.
 *
 * With an org selected, workflows come from the org rather than local SQLite —
 * the same swap accounts, dashboards, and costs already make. The isolate runs
 * server-side, so unlike `./workflow-client` there is no host to build here:
 * CRUD, typings, runs, and metrics are plain proxied HTTP (via the
 * `cloud_*_workflow*` IPC), and a manual run opens the cloud websocket so the
 * editor keeps its breakpoints, stepping, live logs, and `infra.prompt` — the
 * browser's `lib/workflow-client.ts` drives the identical `workflow:*` frames.
 *
 * The one desktop difference is the prompt: Electron's `window.prompt` is a
 * no-op, so prompts go through the same modal local runs use.
 */
import type { PromptSpec } from "@infrawrench/workflow-runtime/client";
import type { GitRepoOption } from "@infrawrench/ui/workflows";
import type {
  DebugSession,
  WorkflowClient,
  WorkflowMetricRow,
  WorkflowRunResult,
  WorkflowRunRow,
  WorkflowSaveBody,
  WorkflowSummary,
} from "@infrawrench/ui/workflows";

import { invoke } from "./invoke";
import { getCloudWsUrl } from "./cloud-ws";
import { requestWorkflowPrompt } from "./workflow-prompt";

export async function listCloudWorkflows(orgId: string): Promise<WorkflowSummary[]> {
  return invoke("cloud_list_workflows", { orgId });
}

export async function pinCloudWorkflow(
  orgId: string,
  dashboardId: string,
  workflowId: string,
): Promise<void> {
  await invoke("cloud_pin_workflow", { orgId, dashboardId, workflowId });
}

export async function unpinCloudWorkflow(
  orgId: string,
  dashboardId: string,
  workflowId: string,
): Promise<void> {
  await invoke("cloud_unpin_workflow", { orgId, dashboardId, workflowId });
}

/** GitHub App connection state for the git-trigger picker. */
export async function getCloudGithubStatus(orgId: string): Promise<{ configured: boolean }> {
  return invoke("cloud_github_status", { orgId });
}

export async function listCloudGithubRepos(orgId: string): Promise<GitRepoOption[]> {
  return invoke("cloud_github_repos", { orgId });
}

export async function getCloudGithubInstallUrl(orgId: string): Promise<string | null> {
  return invoke("cloud_github_install_url", { orgId, returnTo: "workflows" });
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
  const token = await invoke<string | null>("cloud_auth_get_ws_token", { orgId });
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

export function createCloudWorkflowClient(orgId: string): WorkflowClient {
  return {
    list: () => listCloudWorkflows(orgId),
    create: (body: WorkflowSaveBody) =>
      invoke<WorkflowSummary>("cloud_create_workflow", { orgId, body }),
    update: (id: string, body: WorkflowSaveBody) =>
      invoke<WorkflowSummary>("cloud_update_workflow", { orgId, id, body }),
    remove: async (id: string) => {
      await invoke("cloud_delete_workflow", { orgId, id });
    },
    getTypings: (id: string) => invoke<string>("cloud_workflow_typings", { orgId, id }),
    listRuns: (id: string) => invoke<WorkflowRunRow[]>("cloud_workflow_runs", { orgId, id }),
    listMetrics: (id: string) =>
      invoke<WorkflowMetricRow[]>("cloud_workflow_metrics", { orgId, id }),
    run: (id: string, debug?: DebugSession) =>
      debug
        ? runDebug(orgId, id, debug)
        : invoke<{ runId: string; result: WorkflowRunResult }>("cloud_run_workflow", { orgId, id }),
  };
}
