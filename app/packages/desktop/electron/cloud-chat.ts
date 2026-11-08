/**
 * The cloud chat's turn stream, served as the `CloudChatTurn` RPC
 * (`shared/rpc/groups/cloud-chat.ts`).
 *
 * The turn's route answers Server-Sent Events, which the buffered
 * `CloudHttp` transport cannot carry, so the main process sends it with the
 * transport's session (`sendAuthenticated`: the bearer token, one forced
 * refresh and retry on a 401) to a path it builds itself, and parses the
 * events as they arrive. Each event's `data` is one element; one that is not
 * a turn event this build knows is dropped. The stream's scope owns the
 * fetch: interrupting it cancels the body, which closes the connection.
 *
 * Imports `cloud-transport.ts`, which reads tokens from `cloud-tokens.ts`
 * directly, so this module has no import-time side effects either.
 */
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { CloudRequestError } from "../shared/rpc/errors";
import { CloudChatTurnEvent, type CloudChatTurnRequest } from "../shared/rpc/groups/cloud-chat";
import { sendAuthenticated } from "./cloud-transport";

const decodeEvent = Schema.decodeUnknownResult(Schema.fromJsonString(CloudChatTurnEvent));

const turnPath = ({ orgId, conversationId }: CloudChatTurnRequest) =>
  `/api/org/${encodeURIComponent(orgId)}/chat/conversations/${encodeURIComponent(conversationId)}/messages`;

/** The body of an answer that is not a stream, or nothing if it cannot be read. */
const bodyText = (response: Response) => Effect.promise(() => response.text().catch(() => ""));

const openTurn = Effect.fnUntraced(function* (request: CloudChatTurnRequest) {
  const response = yield* sendAuthenticated({
    method: "POST",
    url: turnPath(request),
    body: JSON.stringify(request.body),
  });
  const body = response.body;
  if (!response.ok || body === null) {
    const text = yield* bodyText(response);
    return yield* new CloudRequestError({
      message: text || `Cloud request failed: ${response.status}`,
    });
  }
  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: CloudRequestError.fromCause,
  }).pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.mapError(CloudRequestError.fromCause),
    Stream.filterMap((event) => decodeEvent(event.data)),
  );
});

export class CloudChat extends Context.Service<
  CloudChat,
  {
    readonly turn: (
      request: CloudChatTurnRequest,
    ) => Stream.Stream<CloudChatTurnEvent, CloudRequestError>;
  }
>()("infrawrench/desktop/CloudChat") {
  static readonly layer = Layer.succeed(CloudChat)(
    CloudChat.of({ turn: (request) => Stream.unwrap(openTurn(request)) }),
  );
}
