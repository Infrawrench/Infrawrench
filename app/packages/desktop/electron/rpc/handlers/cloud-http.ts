import { Effect, Layer } from "effect";
import { CloudHttpRpcs } from "../../../shared/rpc/groups/cloud-http";
import { CloudTransport } from "../../cloud-transport";

export const CloudHttpHandlers = CloudHttpRpcs.toLayer(
  Effect.gen(function* () {
    const transport = yield* CloudTransport;
    return CloudHttpRpcs.of({
      CloudHttp: (request) => transport.request(request),
      CloudHttpBytes: (request) => transport.requestBytes(request),
    });
  }),
).pipe(Layer.provide(CloudTransport.layer));
