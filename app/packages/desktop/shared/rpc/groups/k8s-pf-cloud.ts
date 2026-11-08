/**
 * Kubernetes port-forward through the cloud: a local TCP listener on
 * 127.0.0.1 whose every connection is piped over its own WebSocket to the
 * cloud's `/api/ws` proxy (`electron/k8s-pf-cloud.ts`).
 *
 * A session is one streaming call. `Started` carries the port the listener
 * bound; the stream then stays open while the listener does and ends when
 * the main process closes it (the app quitting). Interrupting the stream,
 * which is what stopping the forward does, and the renderer going away both
 * close the listener, its sockets and their WebSockets.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const K8sPfCloudConfig = Schema.Struct({
  orgId: Schema.String,
  accountId: Schema.String,
  resourceId: Schema.String,
  peerPluginId: Schema.String,
  namespace: Schema.String,
  resourceType: Schema.String,
  resourceName: Schema.String,
  remotePort: Schema.Int,
  /** Omitted or 0: any free port. */
  localPort: Schema.optionalKey(Schema.Int),
});
export type K8sPfCloudConfig = typeof K8sPfCloudConfig.Type;

export const K8sPfCloudEvent = Schema.TaggedStruct("Started", {
  sessionId: Schema.String,
  localPort: Schema.Int,
});

/** The listener could not bind (the port is taken, or not allowed). */
export class K8sPfCloudError extends Schema.TaggedError<K8sPfCloudError>()("K8sPfCloudError", {
  message: Schema.String,
}) {}

export class K8sPfCloudRpcs extends RpcGroup.make(
  Rpc.make("K8sPfCloudStart", {
    payload: K8sPfCloudConfig,
    success: K8sPfCloudEvent,
    error: K8sPfCloudError,
    stream: true,
  }),
) {}
