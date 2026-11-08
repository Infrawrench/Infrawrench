import { Effect, Layer } from "effect";
import { LocalPostureRpcs } from "../../../shared/rpc/groups/local-posture";
import { LocalPosture } from "../../local-posture";

export const LocalPostureHandlers = LocalPostureRpcs.toLayer(
  Effect.gen(function* () {
    const posture = yield* LocalPosture;
    return LocalPostureRpcs.of({
      LocalPostureList: () => posture.list,
      LocalPostureDismiss: ({ resourceId, ruleId, reason }) =>
        posture.dismiss(resourceId, ruleId, reason),
      LocalPostureRestore: ({ resourceId, ruleId }) => posture.restore(resourceId, ruleId),
    });
  }),
).pipe(Layer.provide(LocalPosture.layer));
