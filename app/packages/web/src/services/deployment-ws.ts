/**
 * Websocket handler for an interactive deploy.
 *
 * A deploy has to be a socket rather than a request: `select(...)` needs a live
 * round trip to the operator, and a build streams output for minutes. The frame
 * names mirror the workflow protocol so the two read the same way.
 *
 *   client → server: deploy:run {repo, branch, env?, planOnly?, answers?} ·
 *                    deploy:stop · deploy:prompt:response {value}
 *   server → client: deploy:stage {stage} · deploy:log {entry} ·
 *                    deploy:prompt {spec} · deploy:result {runId, result} ·
 *                    deploy:error {message}
 *
 * Unlike a workflow run there is no line debugger; an Infrafile is a
 * deployment, not something you single-step through.
 */
import type { WebSocket } from "ws";
import type { MetricValue, PromptSpec } from "@infrawrench/workflow-runtime";

import { runDeployment } from "./deployments";
import { wsPrincipalCan, type WsPrincipal } from "./ws-auth";

interface DeployMessage {
  type: string;
  repo?: string;
  branch?: string;
  env?: string;
  planOnly?: boolean;
  answers?: Record<string, string>;
  value?: unknown;
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * The socket upgrade only established `resources:execute`, which every channel
 * on `/api/ws` shares. Without a per-frame check the websocket would be a way
 * around what the HTTP routes enforce.
 *
 * The frame carries `planOnly`, so it needs the same split those routes use: a
 * preview is `deployments:plan`, an actual deploy is `deployments:write`.
 */
async function requireDeployPermission(principal: WsPrincipal, planOnly: boolean): Promise<void> {
  const required = planOnly ? "deployments:plan" : "deployments:write";
  const verb = planOnly ? "preview a deploy" : "deploy";
  // The whole principal, key scopes and agent ceiling included: resolving from
  // `userId` alone would hand a narrowly scoped key its owner's full role.
  if (!(await wsPrincipalCan(principal, required))) {
    throw new Error(`You do not have permission to ${verb} in this organization.`);
  }
}

export function handleDeploymentSession(
  ws: WebSocket,
  principal: WsPrincipal,
  start: {
    repo: string;
    branch: string;
    env?: string;
    planOnly?: boolean;
    answers?: Record<string, string>;
  },
): void {
  const { organizationId, userId } = principal;
  const abort = new AbortController();
  let resolvePrompt: ((v: MetricValue) => void) | null = null;

  /**
   * Unwind everything in flight. A pending `select(...)` holds the isolate open,
   * so it has to be resolved before the abort can take effect, otherwise the
   * run (and its SSH workspace) sits there until the execution budget expires.
   */
  const unwind = (): void => {
    abort.abort();
    const p = resolvePrompt;
    resolvePrompt = null;
    p?.(null);
  };

  const onMessage = (data: unknown): void => {
    let msg: DeployMessage;
    try {
      msg = JSON.parse(String(data)) as DeployMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "deploy:stop":
        unwind();
        break;
      case "deploy:prompt:response": {
        const p = resolvePrompt;
        resolvePrompt = null;
        p?.((msg.value ?? null) as MetricValue);
        break;
      }
    }
  };
  ws.on("message", onMessage);
  // A browser that navigates away or drops its connection must not leave the
  // deploy running with nobody watching, and a prompt outstanding at that
  // moment would otherwise never settle.
  ws.on("close", unwind);
  ws.on("error", unwind);

  void requireDeployPermission(principal, Boolean(start.planOnly))
    .then(() =>
      runDeployment({
        organizationId,
        userId,
        repo: start.repo,
        branch: start.branch,
        ...(start.env ? { env: start.env } : {}),
        ...(start.planOnly ? { planOnly: true } : {}),
        ...(start.answers ? { answers: start.answers } : {}),
        interactive: true,
        signal: abort.signal,
        onLog: (entry) => send(ws, { type: "deploy:log", entry }),
        onStage: (stage) => send(ws, { type: "deploy:stage", stage }),
        prompt: (spec: PromptSpec) =>
          new Promise<MetricValue>((resolve) => {
            resolvePrompt = resolve;
            send(ws, { type: "deploy:prompt", spec });
          }),
      }),
    )
    .then(({ runId, result }) => send(ws, { type: "deploy:result", runId, result }))
    .catch((e: unknown) =>
      // A PlanRequiredError arrives here too (the gate lives in the service, so
      // both transports get it); its message already says what to do.
      send(ws, { type: "deploy:error", message: e instanceof Error ? e.message : String(e) }),
    )
    .finally(() => ws.off("message", onMessage));
}
