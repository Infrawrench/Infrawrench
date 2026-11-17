/**
 * The search backend for this deployment: Anthropic's web search, through the
 * same Claude client as the chat itself. A deployment without Claude gets no
 * search tool at all rather than a tool that always fails.
 */
import { anthropicSearchBackend } from "./anthropic-search";
import type { SearchBackend } from "./types";

export function searchBackend(): SearchBackend | null {
  return anthropicSearchBackend.isConfigured() ? anthropicSearchBackend : null;
}

export function isWebSearchConfigured(): boolean {
  return searchBackend() !== null;
}
