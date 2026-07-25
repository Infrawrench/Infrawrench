/**
 * Gemini chat provider, served through Vertex AI (Gemini Enterprise Agent
 * Platform) with Application Default Credentials.
 *
 * Vertex rather than the AI Studio developer API on purpose: Vertex usage is a
 * normal Google Cloud SKU billed to the project, so Google Cloud credits and
 * committed-use discounts apply to it. Gemini Developer API usage is explicitly
 * excluded from Google Cloud welcome/free-trial credits. It also means there is
 * no API key to store or rotate — in GKE the pod authenticates as a Google
 * service account through Workload Identity, and locally ADC comes from
 * `gcloud auth application-default login`.
 *
 * The persisted content-block format stays Anthropic-shaped (see
 * ./types.ts), so this module converts in both directions at its boundary.
 */
import { GoogleGenAI, type Content, type Part, type FunctionDeclaration } from "@google/genai";
import { v4 as uuidv4 } from "uuid";
import type { ChatContentBlock } from "@infrawrench/ui";
import type { ChatProvider, ProviderEvent, ProviderTool, TurnRequest } from "./types";

/**
 * Vertex location. `global` is the multi-region endpoint — it has the broadest
 * model availability and the least capacity-driven 429s, and Gemini 3.x is
 * offered there. Override with GOOGLE_CLOUD_LOCATION when a data-residency
 * requirement pins inference to a single region.
 */
const DEFAULT_LOCATION = "global";

const NOT_CONFIGURED =
  "GOOGLE_CLOUD_PROJECT not configured for this deployment — Gemini models are served " +
  "through Vertex AI and need a project plus Application Default Credentials";

function requireProjectId(): string {
  const project = process.env["GOOGLE_CLOUD_PROJECT"];
  if (!project) throw new Error(NOT_CONFIGURED);
  return project;
}

function toFunctionDeclaration(t: ProviderTool): FunctionDeclaration {
  return {
    name: t.name,
    description: t.description,
    // `parametersJsonSchema` takes raw JSON Schema. The alternative
    // (`parameters`) is Gemini's own trimmed Schema dialect, which would mean
    // a second lossy conversion of the same zod-derived schemas the Anthropic
    // path and MCP already share.
    parametersJsonSchema: t.inputSchema,
  };
}

/**
 * Anthropic-shaped history → Gemini `Content[]`.
 *
 * tool_result blocks carry only a tool_use_id, but Gemini's functionResponse
 * wants the function name too, so we index tool_use blocks as we walk forward.
 */
export function toGeminiContents(req: Pick<TurnRequest, "messages">): Content[] {
  const toolNameById = new Map<string, string>();
  const contents: Content[] = [];

  for (const message of req.messages) {
    const parts: Part[] = [];

    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.length > 0) {
          const signature = block.provider === "gemini" ? block.signature : undefined;
          parts.push({ text: block.text, ...(signature ? { thoughtSignature: signature } : {}) });
        }
      } else if (block.type === "thinking") {
        // Only replay a thought part when Gemini itself signed it. An unsigned
        // one, or one carrying Anthropic's signature from before the
        // conversation was switched to this model, is rejected on replay.
        if (block.provider === "gemini" && block.signature) {
          parts.push({
            text: block.thinking,
            thought: true,
            thoughtSignature: block.signature,
          });
        }
      } else if (block.type === "tool_use") {
        toolNameById.set(block.id, block.name);
        const signature = block.provider === "gemini" ? block.signature : undefined;
        parts.push({
          functionCall: { id: block.id, name: block.name, args: block.input },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      } else if (block.type === "tool_result") {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c.text).join("\n")
          : block.content;
        parts.push({
          functionResponse: {
            id: block.tool_use_id,
            name: toolNameById.get(block.tool_use_id) ?? "unknown",
            // Gemini wants an object here. `error` vs `output` is the
            // documented convention for signalling a failed call.
            response: block.is_error ? { error: text } : { output: text },
          },
        });
      }
    }

    if (parts.length > 0) {
      contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
    }
  }

  return contents;
}

/** Gemini finish reasons → the Anthropic-style stop reasons the UI expects. */
function toStopReason(finishReason: string | undefined): string | null {
  if (!finishReason) return null;
  if (finishReason === "STOP") return "end_turn";
  if (finishReason === "MAX_TOKENS") return "max_tokens";
  return finishReason.toLowerCase();
}

export const geminiProvider: ChatProvider = {
  label: "Gemini (Vertex AI)",

  assertConfigured() {
    requireProjectId();
  },

  async *streamTurn(req: TurnRequest): AsyncGenerator<ProviderEvent> {
    const ai = new GoogleGenAI({
      enterprise: true,
      project: requireProjectId(),
      location: process.env["GOOGLE_CLOUD_LOCATION"] || DEFAULT_LOCATION,
    });

    const stream = await ai.models.generateContentStream({
      model: req.model,
      contents: toGeminiContents(req),
      config: {
        systemInstruction: req.system,
        maxOutputTokens: req.maxTokens,
        tools: [{ functionDeclarations: req.tools.map(toFunctionDeclaration) }],
        // We dispatch tools ourselves (with an approval gate for destructive
        // ones); the SDK must never call anything on its own.
        automaticFunctionCalling: { disable: true },
      },
    });

    const collectedBlocks: ChatContentBlock[] = [];
    let stopReason: string | null = null;
    let promptTokens = 0;
    let candidateTokens = 0;
    let thoughtTokens = 0;
    let cachedTokens = 0;
    // Index into collectedBlocks of the block currently being appended to, so
    // consecutive text (or thought) chunks coalesce into one block instead of
    // producing one block per streamed fragment.
    let openTextIdx = -1;
    let openThoughtIdx = -1;

    for await (const chunk of stream) {
      const usage = chunk.usageMetadata;
      if (usage) {
        // Cumulative, not per-chunk — last one present wins.
        promptTokens = usage.promptTokenCount ?? promptTokens;
        candidateTokens = usage.candidatesTokenCount ?? candidateTokens;
        thoughtTokens = usage.thoughtsTokenCount ?? thoughtTokens;
        cachedTokens = usage.cachedContentTokenCount ?? cachedTokens;
      }

      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) stopReason = toStopReason(candidate.finishReason);

      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall) {
          const id = part.functionCall.id ?? uuidv4();
          const name = part.functionCall.name ?? "";
          const args = (part.functionCall.args ?? {}) as Record<string, unknown>;
          openTextIdx = -1;
          openThoughtIdx = -1;
          // Gemini delivers function calls whole rather than as a token
          // stream, so start and full input land together.
          yield { type: "tool_use_start", toolUseId: id, name };
          yield { type: "tool_use_input", toolUseId: id, partialJson: JSON.stringify(args) };
          collectedBlocks.push({
            type: "tool_use",
            id,
            name,
            input: args,
            provider: "gemini",
            ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
          });
          continue;
        }

        if (typeof part.text !== "string") continue;

        if (part.thought) {
          openTextIdx = -1;
          const open = collectedBlocks[openThoughtIdx];
          if (open && open.type === "thinking") {
            open.thinking += part.text;
            if (part.thoughtSignature) open.signature = part.thoughtSignature;
          } else {
            openThoughtIdx = collectedBlocks.length;
            collectedBlocks.push({
              type: "thinking",
              thinking: part.text,
              signature: part.thoughtSignature ?? "",
              provider: "gemini",
            });
          }
          continue;
        }

        if (part.text.length === 0) continue;
        openThoughtIdx = -1;
        yield { type: "text_delta", delta: part.text };
        const open = collectedBlocks[openTextIdx];
        if (open && open.type === "text") {
          open.text += part.text;
          // Signatures arrive on individual parts; the last one wins for the
          // coalesced block, which is the one the model expects back.
          if (part.thoughtSignature) open.signature = part.thoughtSignature;
        } else {
          openTextIdx = collectedBlocks.length;
          collectedBlocks.push({
            type: "text",
            text: part.text,
            provider: "gemini",
            ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
          });
        }
      }
    }

    yield {
      type: "done",
      blocks: collectedBlocks,
      stopReason,
      usage: {
        // promptTokenCount is the whole prompt including anything served from
        // cache; the billed-at-full-rate portion is the remainder.
        inputTokens: Math.max(0, promptTokens - cachedTokens),
        // Reasoning tokens are billed as output but counted separately.
        outputTokens: candidateTokens + thoughtTokens,
        cacheReadTokens: cachedTokens,
        // Implicit caching is automatic and has no separate write charge.
        cacheWriteTokens: 0,
      },
    };
  },
};
