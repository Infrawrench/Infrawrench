/**
 * The cloud chat's turn stream: `POST /chat/conversations/:id/messages`, an
 * SSE answer the buffered `CloudHttp` transport cannot carry.
 *
 * A turn is one streaming call. Each element is one SSE event's `data`, the
 * `ChatTurnEvent` the shared chat UI reduces; the stream ends when the server
 * ends the turn. Interrupting it, which is what the chat's stop does, or the
 * renderer going away, cancels the fetch. A request that never got a stream
 * (signed out, the refresh failed, a non-2xx answer, the network) fails with
 * `CloudRequestError`, whose message the renderer shows as the turn's error.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { CloudRequestError } from "../errors";

export const CloudChatTurnRequest = Schema.Struct({
  orgId: Schema.String,
  conversationId: Schema.String,
  /** The route's body: a new user message, or `resume` once every pending action is resolved. */
  body: Schema.Struct({
    text: Schema.optionalKey(Schema.String),
    resume: Schema.optionalKey(Schema.Boolean),
  }),
});
export type CloudChatTurnRequest = typeof CloudChatTurnRequest.Type;

/**
 * One turn event (client-core `ChatTurnEvent`): its `type` and whatever
 * fields that type carries, as the server's JSON. An event of a type this
 * build does not know is dropped in the main process, as one that is not
 * JSON always was; the chat UI ignores types it does not reduce.
 */
export const CloudChatTurnEvent = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literals([
      "text_delta",
      "tool_use_start",
      "tool_use_input",
      "tool_executed",
      "pending_action",
      "secret_request",
      "sleep",
      "turn_end",
      "spend_blocked",
      "error",
    ]),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type CloudChatTurnEvent = typeof CloudChatTurnEvent.Type;

export class CloudChatRpcs extends RpcGroup.make(
  Rpc.make("CloudChatTurn", {
    payload: CloudChatTurnRequest,
    success: CloudChatTurnEvent,
    error: CloudRequestError,
    stream: true,
  }),
) {}
