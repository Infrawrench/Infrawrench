/**
 * Search backend: Google Search grounding on Vertex AI, driven by a small
 * sub-model call.
 *
 * Structurally the twin of ./anthropic-search.ts — grounding is likewise only
 * reachable as a tool a model may call, so the search tool is again "ask a cheap
 * model, read the sources back out". The differences are Google's: grounding is
 * requested with `googleSearch` rather than being pinned with a tool_choice (the
 * Gemini API has no equivalent forcing knob for it), the sources come back as
 * `groundingMetadata.groundingChunks[].web` instead of tool-result blocks, and
 * the model reports the queries it actually ran in `webSearchQueries`.
 *
 * This is the backend the default deployment uses: Gemini is the default chat
 * model and the pods already authenticate to Vertex with Workload Identity, so
 * search works with no extra key. `ANTHROPIC_API_KEY` is optional here.
 */
import { GoogleGenAI } from "@google/genai";
import type { SearchBackend, SearchHit, SearchOutcome } from "./types";

/** Retrieval model for the sub-call. Must have a row in ../pricing.ts. */
const SEARCH_MODEL = "gemini-3.7-flash";

const DEFAULT_LOCATION = "global";

const MAX_TOKENS = 4096;

const SUB_PROMPT =
  "You are a search subroutine. Search the web to answer the query, then write a dense " +
  "factual summary of what the results say. Lead with the direct answer. Include specifics — " +
  "versions, dates, numbers, exact option and API names — because the reader cannot see the " +
  "pages you read, only your summary and the source list. If the results disagree with each " +
  "other, say so and attribute each claim. If they do not actually answer the query, say that " +
  "plainly instead of guessing. Do not pad, and do not add advice that was not in the results.";

export const vertexSearchBackend: SearchBackend = {
  id: "vertex",
  label: "Google Search grounding (Vertex AI)",

  isConfigured() {
    return Boolean(process.env["GOOGLE_CLOUD_PROJECT"]);
  },

  async search(query: string): Promise<SearchOutcome> {
    const ai = new GoogleGenAI({
      enterprise: true,
      project: process.env["GOOGLE_CLOUD_PROJECT"] as string,
      location: process.env["GOOGLE_CLOUD_LOCATION"] || DEFAULT_LOCATION,
    });

    const response = await ai.models.generateContent({
      model: SEARCH_MODEL,
      contents: [{ role: "user", parts: [{ text: query }] }],
      config: {
        systemInstruction: SUB_PROMPT,
        maxOutputTokens: MAX_TOKENS,
        tools: [{ googleSearch: {} }],
      },
    });

    const candidate = response.candidates?.[0];
    const grounding = candidate?.groundingMetadata;

    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const chunk of grounding?.groundingChunks ?? []) {
      const web = chunk.web;
      if (!web?.uri) continue;
      // Grounding cites the same page once per supported claim, so the chunk
      // list routinely repeats a URL several times.
      if (seen.has(web.uri)) continue;
      seen.add(web.uri);
      hits.push({ title: web.title || web.domain || web.uri, url: web.uri });
    }

    const summary = (candidate?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => (part.text as string).trim())
      .filter(Boolean)
      .join("\n\n");

    // Google bills a grounded prompt only when it returns at least one web
    // grounding URL, so a query that found nothing is not a billable query.
    const queries = hits.length > 0 ? (grounding?.webSearchQueries?.length ?? 0) : 0;

    const usage = response.usageMetadata;
    const promptTokens = usage?.promptTokenCount ?? 0;
    const cachedTokens = usage?.cachedContentTokenCount ?? 0;
    return {
      summary,
      hits,
      queries,
      usage: {
        // Gemini's prompt count includes cached tokens where Anthropic's does
        // not; subtract so the two price against the same rate table.
        inputTokens: Math.max(0, promptTokens - cachedTokens),
        // Reasoning tokens bill at the output rate.
        outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        cacheReadTokens: cachedTokens,
        cacheWriteTokens: 0,
      },
      model: SEARCH_MODEL,
    };
  },
};
