import { Effect, Layer } from "effect";
import { CloudCiRpcs } from "../../../shared/rpc/groups/cloud-ci";
import { CloudCi } from "../../cloud-ci";

export const CloudCiHandlers = CloudCiRpcs.toLayer(
  Effect.gen(function* () {
    const ci = yield* CloudCi;
    // The stream's scope owns the fetch: interrupting it, or the renderer
    // going away, cancels the log's body.
    return CloudCiRpcs.of({ CloudCiRunLogs: (request) => ci.runLogs(request) });
  }),
).pipe(Layer.provide(CloudCi.layer));
