/**
 * Picks the search backend for this deployment.
 *
 * Vertex wins by default because it is the credential the default deployment
 * already has: Gemini is the default chat model, the pods authenticate to Vertex
 * with Workload Identity, and `ANTHROPIC_API_KEY` is explicitly optional. A
 * deployment that set only the Anthropic key gets the Anthropic backend, and one
 * that set neither gets no search tool at all rather than a tool that always
 * fails.
 *
 * The choice is independent of the conversation's model on purpose. Search is a
 * sub-call, not part of the main turn, so pairing it with the chat model would
 * only mean a Claude conversation loses search on a Gemini-only deployment —
 * paying nothing for the coupling.
 *
 * `INFRAWRENCH_CHAT_SEARCH_BACKEND` overrides the order for operators who have
 * both configured and a reason to prefer one (cost, data residency, an
 * organization-level Console policy on which domains search may reach).
 */
import { anthropicSearchBackend } from "./anthropic-search";
import { vertexSearchBackend } from "./vertex-search";
import type { SearchBackend } from "./types";

const BACKENDS: SearchBackend[] = [vertexSearchBackend, anthropicSearchBackend];

export function searchBackend(): SearchBackend | null {
  const preferred = process.env["INFRAWRENCH_CHAT_SEARCH_BACKEND"];
  if (preferred) {
    const match = BACKENDS.find((b) => b.id === preferred);
    // A misconfigured override falls through to auto-selection rather than
    // disabling search: the name is a deploy-time typo risk, and silently
    // losing the tool is harder to notice than getting the other backend.
    if (match?.isConfigured()) return match;
    console.warn(
      `[chat/web] INFRAWRENCH_CHAT_SEARCH_BACKEND="${preferred}" is not a configured backend; ` +
        `falling back to auto-selection`,
    );
  }
  return BACKENDS.find((b) => b.isConfigured()) ?? null;
}

export function isWebSearchConfigured(): boolean {
  return searchBackend() !== null;
}
