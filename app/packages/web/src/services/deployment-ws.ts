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
 * Unlike a workflow run there is no line debugger — an Infrafile is a
 * deployment, not something you single-step through.
 */
import type { WebSocket } from "ws";
import type { MetricValue, PromptSpec } from "@infrawrench/workflow-runtime";

import { runDeployment } from "./deployments";

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

export function handleDeploymentSession(
  ws: WebSocket,
  organizationId: string,
  start: {
    repo: string;
    branch: string;
    env?: string;
    planOnly?: boolean;
    answers?: Record<string, string>;
    userId?: string;
  },
): void {
  const abort = new AbortController();
  let resolvePrompt: ((v: MetricValue) => void) | null = null;

  const onMessage = (data: unknown): void => {
    let msg: DeployMessage;
    try {
      msg = JSON.parse(String(data)) as DeployMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "deploy:stop":
        abort.abort();
        // A pending prompt would otherwise hold the run open forever; resolving
        // it null lets the isolate unwind and the abort take effect.
        {
          const p = resolvePrompt;
          resolvePrompt = null;
          p?.(null);
        }
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

  void runDeployment({
    organizationId,
    ...(start.userId ? { userId: start.userId } : {}),
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
  })
    .then(({ runId, result }) => send(ws, { type: "deploy:result", runId, result }))
    .catch((e: unknown) =>
      // A PlanRequiredError arrives here too (the gate lives in the service, so
      // both transports get it); its message already says what to do.
      send(ws, { type: "deploy:error", message: e instanceof Error ? e.message : String(e) }),
    )
    .finally(() => ws.off("message", onMessage));
}
