/**
 * One reviewer's conversation with the model over one version: ask, run the
 * tools it calls, hand back what they answered, until it has nothing more to
 * do or a limit stops it.
 *
 * It ends one of three ways. `complete`: the model finished. `stopped`: a
 * limit ended it (turns, the reviewer's budget, the run's deadline, an
 * answer cut off); what it had recorded by then stands. `failed`: the model
 * could not be asked, or declined. Findings are written as the model reports
 * them, so nothing is lost with the conversation, and whatever was spent is
 * in `usage` however it ended.
 *
 * The conversation is append-only and replayed whole each turn, thinking
 * blocks included, with the system prompt and the growing history cached.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { type TokenUsage, computeCostMicros } from "@infrawrench/server-core/billing/ai-pricing";
import { type ReviewModel, describeModelError } from "./model";
import { REVIEWER_EFFORT, REVIEWER_MODELS } from "./policy";
import { type ReviewBriefInput, reviewBrief, systemPrompt } from "./prompts";
import { REVIEW_TOOLS, type ReviewerContext, type ReviewerState, runTool } from "./tools";

export interface ReviewerResult {
  readonly outcome: "complete" | "stopped" | "failed";
  /** Why it stopped or failed, for the run's readers. Null when complete. */
  readonly reason: string | null;
  readonly model: string;
  readonly usage: TokenUsage;
  /** As billed (`ai-pricing.ts`), in millionths of a dollar. */
  readonly costMicros: number;
  readonly turns: number;
  readonly state: ReviewerState;
}

const noUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export const runReviewer = async (
  cx: ReviewerContext,
  model: ReviewModel,
  brief: Omit<ReviewBriefInput, "kind">,
  options: { readonly deadline: number; readonly now?: () => number },
): Promise<ReviewerResult> => {
  const now = options.now ?? Date.now;
  const modelId = REVIEWER_MODELS[cx.kind];
  const state: ReviewerState = { raised: 0, written: [] };
  const usage = noUsage();
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: reviewBrief({ ...brief, kind: cx.kind }) },
  ];
  let turns = 0;
  const result = (outcome: ReviewerResult["outcome"], reason: string | null): ReviewerResult => ({
    outcome,
    reason,
    model: modelId,
    usage,
    costMicros: computeCostMicros(modelId, usage),
    turns,
    state,
  });

  while (true) {
    if (turns >= cx.limits.maxTurns) return result("stopped", "it reached its limit of steps");
    if (computeCostMicros(modelId, usage) >= cx.limits.reviewerBudgetMicros) {
      return result("stopped", "it reached its budget");
    }
    const left = options.deadline - now();
    if (left <= 5_000) return result("stopped", "the run ran out of time");

    let response: Anthropic.Message;
    try {
      response = await model.create(
        {
          model: modelId,
          max_tokens: cx.limits.maxOutputTokensPerTurn,
          // Thinking is adaptive on this model and cannot be turned off; effort is the control.
          output_config: { effort: REVIEWER_EFFORT[cx.kind] },
          system: [
            { type: "text", text: systemPrompt(cx.kind), cache_control: { type: "ephemeral" } },
          ],
          tools: REVIEW_TOOLS,
          // The history so far, cached up to its last block.
          cache_control: { type: "ephemeral" },
          messages,
        },
        { signal: AbortSignal.timeout(Math.min(cx.limits.turnTimeoutMs, left)) },
      );
    } catch (error) {
      return result("failed", describeModelError(error));
    }
    turns++;
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

    // Before anything is read from the answer: a decline has no content to act on.
    if (response.stop_reason === "refusal") {
      return result("failed", "the model declined to review this change");
    }
    const calls = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (response.stop_reason === "max_tokens") {
      // A tool call cut off mid-input is not one to run.
      return result("stopped", "one of its answers was cut off");
    }
    if (calls.length === 0) return result("complete", null);

    // The answer goes back whole and unchanged: its thinking blocks belong to this conversation.
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ContentBlockParam[] = [];
    for (const call of calls) {
      const answer = await runTool(cx, state, call.name, call.input);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: answer.content,
        ...(answer.isError ? { is_error: true } : {}),
      });
    }
    if (turns === cx.limits.maxTurns - 1) {
      results.push({
        type: "text",
        text: "You have one step left. Record anything you have not recorded yet, then stop.",
      });
    }
    // Every result of a turn in one message.
    messages.push({ role: "user", content: results });
  }
};
