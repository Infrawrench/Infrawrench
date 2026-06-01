/**
 * Websocket handler for an interactive / debug workflow run.
 *
 * The browser owns the breakpoints and step state; the server simply blocks
 * before each instrumented line (`line`) and resumes when the client sends
 * `workflow:continue`. `infra.prompt` and live logs flow over the same socket.
 *
 *   client → server: workflow:run {workflowId} · workflow:continue ·
 *                    workflow:stop · workflow:prompt:response {value}
 *   server → client: workflow:line {line} · workflow:log {entry} ·
 *                    workflow:prompt {spec} · workflow:result {runId,result} ·
 *                    workflow:error {message}
 */
import type { WebSocket } from "ws";
import type { MetricValue, PromptSpec } from "@infrawrench/workflow-runtime";

import { runWorkflowById } from "./workflow-runner";

interface WorkflowRunMessage {
  type: string;
  workflowId?: string;
  value?: unknown;
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function handleWorkflowSession(
  ws: WebSocket,
  organizationId: string,
  workflowId: string,
): void {
  const abort = new AbortController();
  let stopRequested = false;
  // Exactly one of these is pending at a time (lines/prompts are sequential).
  let resumeLine: (() => void) | null = null;
  let rejectLine: ((e: Error) => void) | null = null;
  let resolvePrompt: ((v: MetricValue) => void) | null = null;

  const onMessage = (data: unknown): void => {
    let msg: WorkflowRunMessage;
    try {
      msg = JSON.parse(String(data)) as WorkflowRunMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "workflow:continue": {
        const r = resumeLine;
        resumeLine = null;
        r?.();
        break;
      }
      case "workflow:stop": {
        stopRequested = true;
        abort.abort();
        const j = rejectLine;
        rejectLine = null;
        j?.(new Error("Workflow stopped"));
        break;
      }
      case "workflow:prompt:response": {
        const p = resolvePrompt;
        resolvePrompt = null;
        p?.((msg.value ?? null) as MetricValue);
        break;
      }
    }
  };
  ws.on("message", onMessage);

  void runWorkflowById({
    organizationId,
    workflowId,
    triggerSource: "manual",
    interactive: true,
    debug: true,
    signal: abort.signal,
    onLog: (entry) => send(ws, { type: "workflow:log", entry }),
    prompt: (spec: PromptSpec) =>
      new Promise<MetricValue>((resolve) => {
        resolvePrompt = resolve;
        send(ws, { type: "workflow:prompt", spec });
      }),
    line: (line: number) =>
      new Promise<void>((resolve, reject) => {
        // Unwind at the next line after Stop.
        if (stopRequested) {
          reject(new Error("Workflow stopped"));
          return;
        }
        resumeLine = resolve;
        rejectLine = reject;
        send(ws, { type: "workflow:line", line });
      }),
  })
    .then(({ runId, result }) => send(ws, { type: "workflow:result", runId, result }))
    .catch((e: unknown) =>
      send(ws, { type: "workflow:error", message: e instanceof Error ? e.message : String(e) }),
    )
    .finally(() => ws.off("message", onMessage));
}
