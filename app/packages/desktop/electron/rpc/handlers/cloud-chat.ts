import { Effect, Layer } from "effect";
import { CloudChatRpcs } from "../../../shared/rpc/groups/cloud-chat";
import { CloudChat } from "../../cloud-chat";

export const CloudChatHandlers = CloudChatRpcs.toLayer(
  Effect.gen(function* () {
    const chat = yield* CloudChat;
    // The stream's scope owns the fetch: interrupting it, or the renderer
    // going away, cancels the turn's body.
    return CloudChatRpcs.of({ CloudChatTurn: (request) => chat.turn(request) });
  }),
).pipe(Layer.provide(CloudChat.layer));
