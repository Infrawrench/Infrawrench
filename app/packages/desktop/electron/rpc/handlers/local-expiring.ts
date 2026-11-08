import { Effect, Layer } from "effect";
import { LocalExpiringRpcs } from "../../../shared/rpc/groups/local-expiring";
import { LocalExpiring } from "../../local-expiring";

export const LocalExpiringHandlers = LocalExpiringRpcs.toLayer(
  Effect.gen(function* () {
    const expiring = yield* LocalExpiring;
    return LocalExpiringRpcs.of({ LocalExpiringList: () => expiring.list });
  }),
).pipe(Layer.provide(LocalExpiring.layer));
