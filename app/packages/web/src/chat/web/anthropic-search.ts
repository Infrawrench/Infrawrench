/**
 * Search backend: Anthropic's server-side `web_search` tool, driven by a small
 * forced sub-model call.
 *
 * This is the shape Claude Code uses, and the reason for it is that neither we
 * nor Anthropic's API expose a raw "give me ten links" endpoint — `web_search`
 * only exists as a tool a model may call. So the search *tool* the chat agent
 * sees is implemented by handing the query to a cheap model that is compelled to
 * search (`tool_choice` pins it to the tool, so it cannot answer from memory)
 * and then reading the results back out of its response.
 *
 * The sub-model is Haiku: it is doing retrieval and compression, not reasoning,
 * and the expensive model that asked for the search is the one that will use the
 * answer. Haiku also can't do programmatic tool calling, which settles the tool
 * version — `web_search_20250305` defaults to `allowed_callers: ["direct"]`,
 * where the newer `_20260209` would try to route the search through code
 * execution and 400 on a model that can't.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SearchBackend, SearchHit, SearchOutcome } from "./types";

/** Retrieval model for the sub-call. Must have a row in ../pricing.ts. */
const SEARCH_MODEL = "claude-haiku-4-5";

/**
 * Ceiling on searches per tool call. The sub-model may fan one question out
 * into several queries, and every one of them is billed, so this is a cost
 * bound rather than a quality knob. Claude Code allows 8; a chat turn asks
 * narrower questions and can simply call the tool again.
 */
const MAX_USES = 5;

const MAX_TOKENS = 4096;

const SUB_PROMPT =
  "You are a search subroutine. Use the web_search tool to answer the query, then write a " +
  "dense factual summary of what the results say. Lead with the direct answer. Include " +
  "specifics — versions, dates, numbers, exact option and API names — because the reader " +
  "cannot see the pages you read, only your summary and the source list. If the results " +
  "disagree with each other, say so and attribute each claim. If they do not actually " +
  "answer the query, say that plainly instead of guessing. Do not pad, and do not add " +
  "advice that was not in the results.";

export const anthropicSearchBackend: SearchBackend = {
  id: "anthropic",
  label: "Anthropic web search",

  isConfigured() {
    return Boolean(process.env["ANTHROPIC_API_KEY"]);
  },

  async search(query: string): Promise<SearchOutcome> {
    const client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

    const message = await client.messages.create({
      model: SEARCH_MODEL,
      max_tokens: MAX_TOKENS,
      system: SUB_PROMPT,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_USES }],
      // Compel the search. Without this the sub-model is free to answer a
      // question it thinks it knows, which would silently turn a search tool
      // into a second, worse opinion from a smaller model.
      tool_choice: { type: "tool", name: "web_search" },
      messages: [{ role: "user", content: query }],
    });

    const hits: SearchHit[] = [];
    const text: string[] = [];
    // Surfaced rather than thrown: a rate-limited or over-budget search still
    // returns HTTP 200 with an error object in place of the result list, and
    // the agent can act on "rate limited, try again" far better than on a
    // generic tool failure.
    const errors: string[] = [];

    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.trim()) text.push(block.text.trim());
        continue;
      }
      if (block.type !== "web_search_tool_result") continue;

      const content = block.content;
      if (Array.isArray(content)) {
        for (const result of content) {
          hits.push({
            title: result.title,
            url: result.url,
            ...(result.page_age ? { age: result.page_age } : {}),
          });
        }
      } else {
        errors.push(content.error_code);
      }
    }

    const summary = text.join("\n\n");
    return {
      summary:
        errors.length > 0
          ? [summary, `Search errors: ${errors.join(", ")}`].join("\n\n").trim()
          : summary,
      hits,
      queries: message.usage.server_tool_use?.web_search_requests ?? 0,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      model: SEARCH_MODEL,
    };
  },
};
