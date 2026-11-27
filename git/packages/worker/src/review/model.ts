/**
 * The model a reviewer talks to. One method, so the runner's tests hand it a
 * script instead of Claude.
 *
 * The real one is server-core's Anthropic client, which goes through
 * Cloudflare AI Gateway on Unified Billing (`anthropic-client.ts`): the
 * Worker holds the gateway's token and no Anthropic key. It reads
 * `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_ID` and `AI_GATEWAY_TOKEN` from
 * `process.env`, which `nodejs_compat` fills from the Worker's secrets.
 *
 * **A prompt and an answer are never logged.** They hold a repository's code
 * and its CI logs. What is kept of a failed call is its class and its HTTP
 * status ({@link describeModelError}), never its message, which can quote the
 * request.
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "@infrawrench/server-core/anthropic-client";

export interface ReviewModel {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options: { readonly signal: AbortSignal },
  ): Promise<Anthropic.Message>;
}

/** Claude, through the gateway. Throws when the deployment has none configured. */
export const anthropicReviewModel = (timeoutMs: number): ReviewModel => {
  const client = anthropicClient({ timeout: timeoutMs, maxRetries: 2 });
  return { create: (params, options) => client.messages.create(params, options) };
};

/** Why a model call failed, in words safe to store on a run and show to its readers. */
export const describeModelError = (error: unknown): string => {
  if (error instanceof Anthropic.APIUserAbortError) return "the model took too long to answer";
  if (error instanceof Anthropic.APIConnectionError) return "the model could not be reached";
  if (error instanceof Anthropic.RateLimitError) return "the model is rate limited (HTTP 429)";
  if (error instanceof Anthropic.APIError) {
    return `the model refused the request (HTTP ${error.status ?? "unknown"})`;
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "the model took too long to answer";
  }
  return "the model call failed";
};
