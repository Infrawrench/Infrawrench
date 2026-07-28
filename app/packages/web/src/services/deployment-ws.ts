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
import { effectivePermissions } from "../auth/effective-permissions";
import { hasPermission } from "@infrawrench/server-core/permissions";

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
 * on `/api/ws` shares. Starting a real deploy is a `deployments:write` action —
 * the HTTP routes enforce that, and without this check the websocket would be a
 * way around them.
 */
async function requireDeployPermission(organizationId: string, userId?: string): Promise<void> {
  // No identified user means nothing to resolve a role against — deny rather
  // than fall through to an unchecked deploy.
  if (!userId) throw new Error("You do not have permission to deploy in this organization.");
  const granted = await effectivePermissions({ organizationId, userId });
  if (!hasPermission(granted, "deployments:write")) {
    throw new Error("You do not have permission to deploy in this organization.");
  }
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

  /**
   * Unwind everything in flight. A pending `select(...)` holds the isolate open,
   * so it has to be resolved before the abort can take effect — otherwise the
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
  // deploy running with nobody watching — and a prompt outstanding at that
  // moment would otherwise never settle.
  ws.on("close", unwind);
  ws.on("error", unwind);

  void requireDeployPermission(organizationId, start.userId)
    .then(() =>
      runDeployment({
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
