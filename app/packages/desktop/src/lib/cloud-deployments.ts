/**
 * Desktop renderer-side cloud DeploymentClient.
 *
 * With an org selected, the Deploy tab is the web app's Deploy screen: the
 * repositories come from the org's GitHub App, the build runs on a hosted
 * worker, and deploy-on-push triggers live server-side. Without an org there is
 * nothing here to talk to: see `LocalDeploymentsPanel`, which reads what
 * `infrawrench deploy` did on this machine instead.
 *
 * Same split as workflows: one-shot calls are typed calls to the contract's
 * `deployments` domain over the cloud transport (`./cloud-client.ts`), and the
 * interactive deploy opens the cloud websocket so `select(...)` can prompt and
 * the build streams. The browser's `lib/deployment-client.ts` drives the
 * identical `deploy:*` frames.
 */
import { useUIStore } from "@infrawrench/ui";
import type {
  DeployRunResult,
  DeploySession,
  DeployStage,
  DeployStartOptions,
  DeploymentClient,
  DeployTriggerInput,
} from "@infrawrench/ui";
import type { PromptSpec } from "@infrawrench/workflow-runtime/client";
import { requestWorkflowPrompt } from "@infrawrench/ui/workflows/prompt-bridge";

import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";
import { getCloudWsToken } from "./cloud-auth";
import { getCloudWsUrl } from "./cloud-ws";

/**
 * Resolved per call rather than closed over: the org can change under a mounted
 * panel when the user switches org, exactly as it can for costs.
 */
const deployments = () => cloudClient("deployments").deployments;

function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) {
    throw new Error("Deploying from the app needs an organization: sign in to Infrawrench Cloud.");
  }
  return orgId;
}

/** Full interactive deploy over the cloud websocket. */
async function deploy(
  opts: DeployStartOptions,
  session: DeploySession,
): Promise<{ runId: string; result: DeployRunResult }> {
  const orgId = requireOrgId();
  const token = await getCloudWsToken(orgId);
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
          // dropdown anyway: route it to PromptHost at the app root.
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
    listRepos: () => runRpc(deployments().repos({ params: { orgId: requireOrgId() } })),
    listEnvs: (repo, branch) =>
      runRpc(deployments().envs({ params: { orgId: requireOrgId() }, payload: { repo, branch } })),
    plan: (opts) =>
      runRpc(deployments().plan({ params: { orgId: requireOrgId() }, payload: opts })),
    deploy,
    listRuns: (env) =>
      runRpc(deployments().runs({ params: { orgId: requireOrgId() }, query: env ? { env } : {} })),
    costImpact: (runId) =>
      runRpc(deployments().costImpact({ params: { orgId: requireOrgId(), id: runId }, query: {} })),
    annotateCostImpact: async (runId) => {
      await runRpc(
        cloudClient("costAnnotations").changeImpactAnnotations.pin({
          params: { orgId: requireOrgId() },
          payload: { subjectKind: "deployment", subjectId: runId },
        }),
      );
    },
    // The route takes an optional `deleteCreated`; the Deploy tab never sets it.
    rollback: (runId) =>
      runRpc(deployments().rollback({ params: { orgId: requireOrgId(), id: runId }, payload: {} })),
    listTriggers: () => runRpc(deployments().triggers({ params: { orgId: requireOrgId() } })),
    createTrigger: (input: DeployTriggerInput) =>
      runRpc(deployments().upsertTrigger({ params: { orgId: requireOrgId() }, payload: input })),
    updateTrigger: (id: string, input: { enabled: boolean }) =>
      runRpc(
        deployments().setTriggerEnabled({ params: { orgId: requireOrgId(), id }, payload: input }),
      ),
    deleteTrigger: async (id: string) => {
      await runRpc(deployments().deleteTrigger({ params: { orgId: requireOrgId(), id } }));
    },
  };
}
