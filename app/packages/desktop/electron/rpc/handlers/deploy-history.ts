import { Effect, Layer } from "effect";
import { LocalDeployHistoryRpcs } from "../../../shared/rpc/groups/deploy-history";
import { LocalDeployHistory } from "../../deploy-history";

export const LocalDeployHistoryHandlers = LocalDeployHistoryRpcs.toLayer(
  Effect.gen(function* () {
    const history = yield* LocalDeployHistory;
    return LocalDeployHistoryRpcs.of({ LocalDeployHistory: () => history.list });
  }),
).pipe(Layer.provide(LocalDeployHistory.layer));
