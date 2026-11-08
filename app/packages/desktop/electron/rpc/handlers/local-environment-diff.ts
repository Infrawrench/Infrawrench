import { Effect, Layer } from "effect";
import { LocalEnvironmentDiffRpcs } from "../../../shared/rpc/groups/local-environment-diff";
import { LocalEnvironmentDiff } from "../../local-environment-diff";

export const LocalEnvironmentDiffHandlers = LocalEnvironmentDiffRpcs.toLayer(
  Effect.gen(function* () {
    const environmentDiff = yield* LocalEnvironmentDiff;
    return LocalEnvironmentDiffRpcs.of({
      LocalEnvironmentDiff: ({ accountIdA, accountIdB, includeIdentityFields }) =>
        environmentDiff.diff(accountIdA, accountIdB, { includeIdentityFields }),
    });
  }),
).pipe(Layer.provide(LocalEnvironmentDiff.layer));
