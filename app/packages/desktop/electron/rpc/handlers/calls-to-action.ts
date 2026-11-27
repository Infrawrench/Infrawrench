import { Effect, Layer } from "effect";
import { CallToActionRpcs } from "../../../shared/rpc/groups/calls-to-action";
import { CallsToAction } from "../../calls-to-action";

export const CallToActionHandlers = CallToActionRpcs.toLayer(
  Effect.gen(function* () {
    const ctas = yield* CallsToAction;
    return CallToActionRpcs.of({
      CallsToActionPending: (input) => ctas.pending(input),
      CallsToActionComplete: ({ id }) => ctas.complete(id),
    });
  }),
).pipe(Layer.provide(CallsToAction.layer));
