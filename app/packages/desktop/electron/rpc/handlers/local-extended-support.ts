import { Effect, Layer } from "effect";
import { LocalExtendedSupportRpcs } from "../../../shared/rpc/groups/local-extended-support";
import { LocalExtendedSupport } from "../../local-extended-support";

export const LocalExtendedSupportHandlers = LocalExtendedSupportRpcs.toLayer(
  Effect.gen(function* () {
    const extendedSupport = yield* LocalExtendedSupport;
    return LocalExtendedSupportRpcs.of({ LocalExtendedSupportList: () => extendedSupport.list });
  }),
).pipe(Layer.provide(LocalExtendedSupport.layer));
