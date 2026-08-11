/**
 * Browser-side DeploymentClient — org-scoped `/api/org/:orgId/deployments`.
 *
 * Everything that answers in one shot goes over fetch. The full deploy goes
 * over the websocket, because `select(...)` needs a live round trip and a build
 * streams output for minutes; that is the same split interactive workflow runs
 * use.
 */
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
  PromptSpec,
} from "@infrawrench/ui";
import { requestWorkflowPrompt } from "@infrawrench/ui/workflows/prompt-bridge";
import { jsonInit, jsonOrThrow } from "./cookie-json";

export function createWebDeploymentClient(orgId: string): DeploymentClient {
  const base = `/api/org/${orgId}/deployments`;

  async function deploy(
    opts: DeployStartOptions,
    session: DeploySession,
  ): Promise<{ runId: string; result: DeployRunResult }> {
    const { token } = await fetch(`/api/org/${orgId}/ws-token`, jsonInit("POST")).then((r) =>
      jsonOrThrow<{ token: string }>(r),
    );
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${wsProtocol}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`,
    );

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

      // Exposed to the panel so its Stop button can reach the running deploy.
      session.stop = () => send({ type: "deploy:stop" });

      ws.onopen = () =>
        send({
          type: "deploy:run",
          repo: opts.repo,
          branch: opts.branch,
          ...(opts.env ? { env: opts.env } : {}),
          ...(opts.planOnly ? { planOnly: true } : {}),
        });
      ws.onerror = () => finish(() => reject(new Error("Deploy connection failed")));
      ws.onclose = () => finish(() => reject(new Error("Deploy connection closed")));
      ws.onmessage = (ev) => {
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
            // A real modal (PromptHost at the app root), so a select() renders
            // as a dropdown rather than a free-text box.
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
      };
    });
  }

  return {
    listRepos: () =>
      fetch(`${base}/repos`, jsonInit("GET")).then((r) => jsonOrThrow<DeployRepo[]>(r)),
    listEnvs: (repo, branch) =>
      fetch(`${base}/envs`, jsonInit("POST", { repo, branch })).then((r) =>
        jsonOrThrow<DeployEnvs>(r),
      ),
    plan: (opts) =>
      fetch(`${base}/plan`, jsonInit("POST", opts)).then((r) =>
        jsonOrThrow<{ runId: string; result: DeployRunResult }>(r),
      ),
    deploy,
    rollback: (runId) =>
      fetch(`${base}/runs/${runId}/rollback`, jsonInit("POST")).then((r) =>
        jsonOrThrow<{ runId: string; result: DeployRunResult }>(r),
      ),
    listTriggers: () =>
      fetch(`${base}/triggers`, jsonInit("GET")).then((r) => jsonOrThrow<DeployTrigger[]>(r)),
    createTrigger: (input: DeployTriggerInput) =>
      fetch(`${base}/triggers`, jsonInit("POST", input)).then((r) => jsonOrThrow<DeployTrigger>(r)),
    updateTrigger: (id: string, input: { enabled: boolean }) =>
      fetch(`${base}/triggers/${encodeURIComponent(id)}`, jsonInit("PATCH", input)).then((r) =>
        jsonOrThrow<DeployTrigger>(r),
      ),
    deleteTrigger: (id: string) =>
      fetch(`${base}/triggers/${encodeURIComponent(id)}`, jsonInit("DELETE"))
        .then((r) => jsonOrThrow<{ ok: boolean }>(r))
        .then(() => undefined),
    listRuns: (env) =>
      fetch(`${base}/runs${env ? `?env=${encodeURIComponent(env)}` : ""}`, jsonInit("GET")).then(
        (r) => jsonOrThrow<DeploymentRunRow[]>(r),
      ),
    costImpact: (runId) =>
      fetch(`${base}/runs/${encodeURIComponent(runId)}/cost-impact`, jsonInit("GET")).then((r) =>
        jsonOrThrow<DeploymentCostImpact>(r),
      ),
    annotateCostImpact: async (runId) => {
      await fetch(`/api/org/${orgId}/cost-annotations/change-impact`, {
        ...jsonInit("POST"),
        body: JSON.stringify({ subjectKind: "deployment", subjectId: runId }),
      }).then((r) => jsonOrThrow<unknown>(r));
    },
  };
}
