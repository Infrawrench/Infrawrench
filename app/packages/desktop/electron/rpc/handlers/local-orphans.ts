import { Effect, Layer } from "effect";
import { LocalOrphansRpcs } from "../../../shared/rpc/groups/local-orphans";
import { LocalOrphans } from "../../local-orphans";

export const LocalOrphansHandlers = LocalOrphansRpcs.toLayer(
  Effect.gen(function* () {
    const orphans = yield* LocalOrphans;
    return LocalOrphansRpcs.of({ LocalOrphansList: () => orphans.list });
  }),
).pipe(Layer.provide(LocalOrphans.layer));
