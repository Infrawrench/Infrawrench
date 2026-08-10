/**
 * Cloud implementation of `infra.ai(...)` — one prompt in, one reply out.
 *
 * Talks to Anthropic the way the digest narrative does (../digest/narrative.ts):
 * a one-shot, non-streaming completion with a short timeout and one retry. It
 * differs in what a failure means — the narrative swallows every error because
 * it is decoration, but a workflow author branches on the answer, so here an
 * error (unconfigured deployment, spend cap reached, model refusal, provider
 * outage) throws into the run where it can be seen and caught.
 *
 * Billing rides the same rails as AI chat: every call writes a
 * `workflow_ai_usage` row priced with the chat markup, reports to the chat
 * Stripe meter, and is refused once the org's monthly AI spend cap is reached
 * (chat and workflow spend share one pool — see ../billing/ai-usage.ts).
 * Both surfaces reserve estimated spend under the same org lock before the
 * provider call so concurrent consumers cannot all clear the same below-cap
 * check.
 *
 * The spec arriving here is already validated by the runtime's `dispatch`
 * (model allowlist, prompt/system bounds, clamped maxTokens).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { WorkflowAiResult, WorkflowAiSpec } from "@infrawrench/workflow-runtime";

import {
  AiSpendCapExceededError,
  estimateTokensFromChars,
  recordWorkflowAiUsage,
  releaseAiSpendReservation,
  reserveAiSpend,
} from "../billing/ai-usage";
import { computeCostMicros } from "../billing/ai-pricing";

/**
 * Model calls one run may make. `infra.ai` is a step in an automation, not a
 * batch inference API — and because AI calls are excluded from the run's
 * execution budget (they are a paused method, see the runtime's isolate), this
 * cap is what keeps an `infra.ai` loop bounded.
 */
export const MAX_AI_CALLS_PER_RUN = 20;

/**
 * Per-call wall clock. Generous enough for a frontier model to produce the
 * 8k-token ceiling, short enough that a hung call doesn't hold a poller slot
 * for long — and it bounds the pause the isolate grants the call.
 */
const AI_TIMEOUT_MS = 120_000;

/** Whether this deployment can serve `infra.ai()` at all. */
export function isWorkflowAiConfigured(): boolean {
  return Boolean(process.env["ANTHROPIC_API_KEY"]);
}

export interface WorkflowAiContext {
  organizationId: string;
  workflowId: string;
  /** The run making the calls, for usage attribution. */
  runId?: string;
  /** Abort the run (Stop) — cancels an in-flight Anthropic request. */
  signal?: AbortSignal;
}

/** Upper-bound cost for a reservation: prompt estimate + full maxTokens output. */
function estimateCallCostMicros(spec: WorkflowAiSpec): number {
  const inputChars = spec.prompt.length + (spec.system?.length ?? 0);
  return computeCostMicros(spec.model, {
    inputTokens: estimateTokensFromChars(inputChars),
    outputTokens: spec.maxTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

function stoppedError(): Error {
  return new Error("Workflow stopped.");
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  return name === "AbortError" || name === "APIUserAbortError";
}

/** Make one already-validated `infra.ai(...)` call and record its usage. */
export async function aiFromWorkflow(
  ctx: WorkflowAiContext,
  spec: WorkflowAiSpec,
): Promise<WorkflowAiResult> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "infra.ai() is not available: this deployment has no ANTHROPIC_API_KEY configured.",
    );
  }

  if (ctx.signal?.aborted) throw stoppedError();

  // Reserve estimated spend under the shared org lock before the provider call
  // so concurrent chat turns and workflow runs see each other. One call that
  // started under the cap can still settle past the line — the cap is a
  // monthly budget, not a hard wire, and the overshoot is at most one call.
  let reservationId: string;
  try {
    reservationId = await reserveAiSpend(ctx.organizationId, estimateCallCostMicros(spec));
  } catch (err) {
    if (err instanceof AiSpendCapExceededError) {
      throw new Error(
        "infra.ai() is unavailable: this organization has reached its monthly AI spend cap. " +
          "An admin can raise it under Settings → AI Chat, or it resets when the month rolls over.",
      );
    }
    throw err;
  }

  try {
    if (ctx.signal?.aborted) throw stoppedError();

    const client = new Anthropic({ apiKey, timeout: AI_TIMEOUT_MS, maxRetries: 1 });
    const response = await client.messages.create(
      {
        model: spec.model,
        max_tokens: spec.maxTokens,
        ...(spec.system ? { system: spec.system } : {}),
        messages: [{ role: "user", content: spec.prompt }],
      },
      ctx.signal ? { signal: ctx.signal } : undefined,
    );

    // Stop after the provider returned: drop the reservation and do not bill.
    // The platform may still owe Anthropic for a completed response; the org
    // should not, once they asked the run to stop.
    if (ctx.signal?.aborted) throw stoppedError();

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    // Record real usage before releasing the hold so the brief overlap is a
    // conservative double-count rather than a gap concurrent callers could use.
    const costMicros = await recordWorkflowAiUsage({
      organizationId: ctx.organizationId,
      workflowId: ctx.workflowId,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      model: response.model || spec.model,
      usage,
    });
    await releaseAiSpendReservation(reservationId);

    // Safety classifiers answer 200 with `stop_reason: "refusal"` and no
    // content. An empty string would be a confusing non-answer to branch on, so
    // refuse loudly; the author can catch it like any other error.
    if (response.stop_reason === "refusal") {
      throw new Error("infra.ai(): the model declined to answer this prompt.");
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    return {
      text,
      model: response.model || spec.model,
      stopReason: response.stop_reason === "max_tokens" ? "max_tokens" : "end",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicros,
    };
  } catch (err) {
    await releaseAiSpendReservation(reservationId).catch((releaseErr) => {
      console.error("[workflows/ai] failed to release AI spend reservation:", releaseErr);
    });
    if (ctx.signal?.aborted || isAbortError(err)) throw stoppedError();
    throw err;
  }
}

/**
 * A per-run `ai` for {@link file://./runner.ts}: the same call, with the run's
 * call budget closed over so the cap applies across the whole run rather than
 * per call — the same arrangement as `buildWorkflowFetch`.
 */
export function buildWorkflowAi(
  ctx: WorkflowAiContext,
): (spec: WorkflowAiSpec) => Promise<WorkflowAiResult> {
  let used = 0;
  return (spec) => {
    used += 1;
    if (used > MAX_AI_CALLS_PER_RUN) {
      return Promise.reject(
        new Error(`This run has made its maximum of ${MAX_AI_CALLS_PER_RUN} infra.ai() calls.`),
      );
    }
    return aiFromWorkflow(ctx, spec);
  };
}
