import { Effect, Layer } from "effect";
import { DeepLinkRpcs } from "../../../shared/rpc/groups/deep-links";
import { DeepLinks } from "../../deep-links";

export const DeepLinkHandlers = DeepLinkRpcs.toLayer(
  Effect.gen(function* () {
    const links = yield* DeepLinks;
    return DeepLinkRpcs.of({ DeepLinks: () => links.subscribe });
  }),
).pipe(Layer.provide(DeepLinks.layer));
