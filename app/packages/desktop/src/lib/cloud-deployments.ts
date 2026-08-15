/**
 * Desktop renderer-side cloud DeploymentClient.
 *
 * With an org selected, the Deploy tab is the web app's Deploy screen: the
 * repositories come from the org's GitHub App, the build runs on a hosted
 * worker, and deploy-on-push triggers live server-side. Without an org there is
 * nothing here to talk to — see `LocalDeploymentsPanel`, which reads what
 * `infrawrench deploy` did on this machine instead.
 *
 * Same split as workflows: one-shot calls are proxied HTTP over IPC, and the
 * interactive deploy opens the cloud websocket so `select(...)` can prompt and
 * the build streams. The browser's `lib/deployment-client.ts` drives the
 * identical `deploy:*` frames.
 */
import { useUIStore } from "@infrawrench/ui";
import type { DeploymentCostImpact } from "@infrawrench/client-core";
import type {
  DeployEnvs,
  DeployRepo,
  DeployRunResult,
  DeploySession,
  DeployStage,
  DeployStartOptions,
  DeploymentClient,
  DeploymentRunRow,
  DeployTrigger,
  DeployTriggerInput,
} from "@infrawrench/ui";
import type { PromptSpec } from "@infrawrench/workflow-runtime/client";
import { requestWorkflowPrompt } from "@infrawrench/ui/workflows/prompt-bridge";

import { invoke } from "./invoke";
import { getCloudWsUrl } from "./cloud-ws";

/**
 * Resolved per call rather than closed over: the org can change under a mounted
 * panel when the user switches org, exactly as it can for costs.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) {
    throw new Error("Deploying from the app needs an organization — sign in to Infrawrench Cloud.");
  }
  return orgId;
}

/** Full interactive deploy over the cloud websocket. */
async function deploy(
  opts: DeployStartOptions,
  session: DeploySession,
): Promise<{ runId: string; result: DeployRunResult }> {
  const orgId = requireOrgId();
  const token = await invoke<string | null>("cloud_auth_get_ws_token", { orgId });
  if (!token) throw new Error("Not authenticated to Infrawrench Cloud");
  const wsUrl = await getCloudWsUrl();
  const ws = new WebSocket(`${wsUrl}/api/ws?token=${encodeURIComponent(token)}`);

  let settled = false;
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      session.stopper.finish();
      fn();
      try {
        ws.close();
      } catch {
        // already closing
      }
    };
    const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

    ws.addEventListener("open", () => {
      send({
        type: "deploy:run",
        repo: opts.repo,
        branch: opts.branch,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.planOnly ? { planOnly: true } : {}),
      });
      // After deploy:run, never before: the server routes deploy:stop to the
      // session that frame creates. Arming here flushes a stop the user asked
      // for while the socket was still connecting.
      session.stopper.arm(() => send({ type: "deploy:stop" }));
    });
    ws.addEventListener("error", () => finish(() => reject(new Error("Deploy connection failed"))));
    ws.addEventListener("close", () => finish(() => reject(new Error("Deploy connection closed"))));
    ws.addEventListener("message", (ev) => {
      let m: {
        type: string;
        entry?: Parameters<NonNullable<DeploySession["onLog"]>>[0];
        stage?: DeployStage;
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
        case "deploy:log":
          if (m.entry) session.onLog?.(m.entry);
          break;
        case "deploy:stage":
          if (m.stage) session.onStage?.(m.stage);
          break;
        case "deploy:prompt":
          // Electron's window.prompt is a no-op, and a select() should be a
          // dropdown anyway — route it to PromptHost at the app root.
          void requestWorkflowPrompt(m.spec ?? { message: "Input" }).then((value) => {
            send({ type: "deploy:prompt:response", value });
          });
          break;
        case "deploy:result":
          finish(() => resolve({ runId: m.runId ?? "", result: m.result as DeployRunResult }));
          break;
        case "deploy:error":
          finish(() => reject(new Error(m.message ?? "Deploy failed")));
          break;
      }
    });
  });
}

export function createDesktopDeploymentClient(): DeploymentClient {
  return {
    listRepos: () => invoke<DeployRepo[]>("cloud_deploy_repos", { orgId: requireOrgId() }),
    listEnvs: (repo, branch) =>
      invoke<DeployEnvs>("cloud_deploy_envs", { orgId: requireOrgId(), repo, branch }),
    plan: (opts) =>
      invoke<{ runId: string; result: DeployRunResult }>("cloud_deploy_plan", {
        orgId: requireOrgId(),
        opts,
      }),
    deploy,
    listRuns: (env) =>
      invoke<DeploymentRunRow[]>("cloud_deploy_runs", {
        orgId: requireOrgId(),
        ...(env ? { env } : {}),
      }),
    costImpact: (runId) =>
      invoke<DeploymentCostImpact | null>("cloud_deploy_cost_impact", {
        orgId: requireOrgId(),
        runId,
      }),
    annotateCostImpact: async (runId) => {
      await invoke("cloud_cost_impact_annotate", {
        orgId: requireOrgId(),
        subjectKind: "deployment",
        subjectId: runId,
      });
    },
    rollback: (runId) =>
      invoke<{ runId: string; result: DeployRunResult }>("cloud_deploy_rollback", {
        orgId: requireOrgId(),
        runId,
      }),
    listTriggers: () => invoke<DeployTrigger[]>("cloud_deploy_triggers", { orgId: requireOrgId() }),
    createTrigger: (input: DeployTriggerInput) =>
      invoke<DeployTrigger>("cloud_deploy_create_trigger", { orgId: requireOrgId(), input }),
    updateTrigger: (id: string, input: { enabled: boolean }) =>
      invoke<DeployTrigger>("cloud_deploy_update_trigger", { orgId: requireOrgId(), id, input }),
    deleteTrigger: async (id: string) => {
      await invoke("cloud_deploy_delete_trigger", { orgId: requireOrgId(), id });
    },
  };
}
