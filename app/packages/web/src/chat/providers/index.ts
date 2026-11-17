/**
 * Provider selection by model id. Every chat model is Claude today; the
 * indirection stays so the agent loop (../agent.ts) never names an SDK.
 * Adding a model to CHAT_MODELS in client-core means a rate row in
 * server-core's billing/ai-pricing.ts.
 */
import { anthropicProvider } from "./anthropic";
import type { ChatProvider } from "./types";

export type { ChatProvider, ProviderTool } from "./types";

export function providerForModel(_model: string): ChatProvider {
  return anthropicProvider;
}
