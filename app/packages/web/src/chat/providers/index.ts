/**
 * Provider selection by model id. Adding a model to CHAT_MODELS in
 * client-core means adding its id prefix here and a rate row in ../pricing.ts.
 */
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import type { ChatProvider } from "./types";

export type {
  ChatProvider,
  ProviderEvent,
  ProviderTool,
  ProviderUsage,
  TurnRequest,
} from "./types";

export function providerForModel(model: string): ChatProvider {
  if (model.startsWith("gemini-")) return geminiProvider;
  return anthropicProvider;
}
