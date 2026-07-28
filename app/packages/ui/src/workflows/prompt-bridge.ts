/**
 * Browser-side bridge for `infra.prompt()` — and for an Infrafile's
 * `select(...)`, which routes through the same host method.
 *
 * A running workflow's host needs an answer from a human. On the desktop the
 * host runs in the renderer and calls {@link requestWorkflowPrompt} directly;
 * on the web the request arrives over the workflow WebSocket and the transport
 * calls it. Either way a single modal ({@link PromptHost}, mounted once at the
 * app root) renders the prompt and resolves the waiting promise.
 *
 * This lives in `@infrawrench/ui` rather than in either app because both need
 * it: `window.prompt` is a no-op in Electron *and* is a single-line string box
 * in the browser, which silently drops the `kind` and `options` a select needs.
 */
import type { MetricValue, PromptSpec } from "./types.js";

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
