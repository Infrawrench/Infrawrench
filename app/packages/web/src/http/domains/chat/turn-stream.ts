/**
 * The chat turn as Server-Sent Events, framed and driven exactly as Hono's
 * `streamSSE` drove it for the route this replaces.
 *
 * - Each agent event is one frame, `event: <type>` then `data: <JSON>` and a
 *   blank line. The web, desktop and mobile clients parse that framing (the
 *   chat contract in client-core), so it is byte-for-byte what `writeSSE`
 *   wrote. A turn that throws ends with one `error` frame.
 * - The turn is pushed, not pulled: it runs to its end once started, one
 *   frame ahead of the reader, as it did behind Hono's `TransformStream`. A
 *   client that goes away cancels the body, which makes further writes fail
 *   quietly, and the turn finishes server-side: the assistant message, its
 *   pending actions and the spend reservation are persisted rather than cut
 *   off mid-write, and the conversation reloads complete.
 * - The turn reads the request's scopes (the audit principal an `iwk_` key
 *   brings, the edge request scope) after the handler has returned. It is
 *   started synchronously inside {@link runInLegacyScopes}, so every pull of
 *   the turn's generator, and every continuation the agent loop creates,
 *   runs inside them, whatever fiber the scheduler resumes next.
 */
import { Effect } from "effect";
import type { AgentEvent } from "../../../chat/agent";
import { LegacyScopes, runInLegacyScopes } from "../../legacy";

/** One SSE frame, as Hono's `writeSSE({ event, data })` wrote it. */
export function sseFrame(event: AgentEvent): string {
  const data = JSON.stringify(event)
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join("\n");
  return `event: ${event.type}\n${data}\n\n`;
}

/** The headers `streamSSE` set on the response. */
const SSE_HEADERS = {
  "Transfer-Encoding": "chunked",
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/**
 * Start `turn` inside the request's scopes and answer with its events as an
 * SSE body. A rejection mid-turn is sent as `{ type: "error", message }`.
 */
export const turnStreamResponse = (turn: () => AsyncIterable<AgentEvent>) =>
  Effect.gen(function* () {
    const scopes = yield* LegacyScopes;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // A write after the client cancelled the body rejects; the turn carries on.
    const send = async (event: AgentEvent): Promise<void> => {
      try {
        await writer.write(encoder.encode(sseFrame(event)));
      } catch {
        // The reader is gone.
      }
    };

    const pump = async (): Promise<void> => {
      try {
        for await (const event of turn()) await send(event);
      } catch (e) {
        await send({ type: "error", message: e instanceof Error ? e.message : "Agent failed" });
      } finally {
        try {
          await writer.close();
        } catch {
          // Already errored by a cancelled reader.
        }
      }
    };

    runInLegacyScopes(scopes, () => {
      void pump();
    });

    return new Response(readable, { headers: SSE_HEADERS });
  });
