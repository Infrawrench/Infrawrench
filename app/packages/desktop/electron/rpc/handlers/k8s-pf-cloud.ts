import { Effect, Layer } from "effect";
import { K8sPfCloudRpcs } from "../../../shared/rpc/groups/k8s-pf-cloud";
import { K8sPfCloud } from "../../k8s-pf-cloud";

export const K8sPfCloudHandlers = K8sPfCloudRpcs.toLayer(
  Effect.gen(function* () {
    const forwards = yield* K8sPfCloud;
    // The stream's scope owns the listener: interrupting it, or the renderer
    // going away, closes the listener and every connection through it.
    return K8sPfCloudRpcs.of({ K8sPfCloudStart: (config) => forwards.start(config) });
  }),
).pipe(Layer.provide(K8sPfCloud.layer));
