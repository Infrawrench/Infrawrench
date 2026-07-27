/**
 * Shared parser for OpenAI-compatible chat-completion SSE streams.
 *
 * Several plugins (Cloudflare Workers AI, DigitalOcean GenAI agents,
 * Databricks serving endpoints, GCP Vertex AI) stream chat completions in
 * the OpenAI wire format: `data: {json}\n\n` messages until `data: [DONE]`,
 * with token deltas at `choices[0].delta.content` and an optional trailing
 * `usage` block. Plugins `yield*` this helper after performing their own
 * request and response-status handling.
 */
import type { ChatStreamEvent } from "./schema.js";

/**
 * Consume an OpenAI-compatible SSE body and translate it into
 * {@link ChatStreamEvent}s: zero or more `delta` events as tokens arrive,
 * then a single terminal `done` event carrying the assembled assistant
 * message (plus usage metadata when the provider reports it). Malformed SSE
 * chunks are skipped rather than aborting the stream; read errors yield a
 * terminal `error` event.
 */
export async function* streamOpenAiSseChat(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let assembled = "";
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE messages are separated by blank lines. Split on `\n\n`,
      // keeping the trailing partial in `buffer` for the next read.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            assembled += delta;
            yield { kind: "delta", text: delta };
          }
          if (parsed.usage) {
            // exactOptionalPropertyTypes is on — only assign keys we have.
            const next: {
              inputTokens?: number;
              outputTokens?: number;
              totalTokens?: number;
            } = {};
            if (parsed.usage.prompt_tokens !== undefined) {
              next.inputTokens = parsed.usage.prompt_tokens;
            }
            if (parsed.usage.completion_tokens !== undefined) {
              next.outputTokens = parsed.usage.completion_tokens;
            }
            if (parsed.usage.total_tokens !== undefined) {
              next.totalTokens = parsed.usage.total_tokens;
            }
            usage = next;
          }
        } catch {
          // Malformed SSE chunk — skip rather than abort the whole stream.
        }
      }
    }
  } catch (err) {
    yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  yield {
    kind: "done",
    message: { role: "assistant", content: assembled },
    ...(usage ? { usage } : {}),
  };
}
