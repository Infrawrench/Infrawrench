/**
 * Renderer-side bridge for `infra.prompt()` in desktop workflows.
 *
 * Electron's `window.prompt` is a no-op, so the workflow host can't use it.
 * Instead, the host's `prompt` calls {@link requestWorkflowPrompt}, which
 * surfaces a real modal (mounted once via `WorkflowPromptHost`) and resolves
 * with the user's answer. Everything stays in the renderer — the host already
 * runs here during a run (the sandbox bridges prompt calls back from main).
 */
import type { MetricValue, PromptSpec } from "@infrawrench/workflow-runtime/client";

export interface WorkflowPromptRequest {
  id: string;
  spec: PromptSpec;
}

export const WORKFLOW_PROMPT_EVENT = "iw:workflow-prompt";

const resolvers = new Map<string, (value: MetricValue) => void>();

/** Raise a prompt and resolve once the user answers (or `null` if canceled). */
export function requestWorkflowPrompt(spec: PromptSpec): Promise<MetricValue> {
  const id = crypto.randomUUID();
  return new Promise<MetricValue>((resolve) => {
    resolvers.set(id, resolve);
    window.dispatchEvent(
      new CustomEvent<WorkflowPromptRequest>(WORKFLOW_PROMPT_EVENT, { detail: { id, spec } }),
    );
  });
}

/** Called by the prompt host when the user submits or dismisses a prompt. */
export function resolveWorkflowPrompt(id: string, value: MetricValue): void {
  const resolve = resolvers.get(id);
  if (!resolve) return;
  resolvers.delete(id);
  resolve(value);
}
