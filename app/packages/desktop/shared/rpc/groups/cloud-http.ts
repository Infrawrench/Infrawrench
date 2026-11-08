/**
 * The desktop's one authenticated transport to Infrawrench Cloud.
 *
 * The renderer builds each request from the endpoint's definition in
 * `@infrawrench/api-contract` (`src/lib/cloud-client.ts`), so the method,
 * path, query and JSON body arrive here already encoded. The main process
 * owns everything a renderer must not: the bearer token and its refresh,
 * `CLOUD_URL`, the SSH host-key prompt a 409 asks for, and the allowlist
 * that decides which method+path a renderer may reach at all
 * (`electron/cloud-transport.ts`).
 *
 * The answer is the status and the body text exactly as the server sent
 * them: whether a status is a failure, and what the body means, is the
 * caller's business. A request that never got an answer (not signed in, the
 * session expired, refused by the allowlist, the network failed) is a
 * {@link CloudRequestError}.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { CloudRequestError } from "../errors";

/** The methods the cloud API routes. HEAD and OPTIONS are never needed from a panel. */
export const CloudHttpMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type CloudHttpMethod = typeof CloudHttpMethod.Type;

export const CloudHttpRequest = Schema.Struct({
  method: CloudHttpMethod,
  /** Path and query under the cloud origin, starting `/api/`. */
  url: Schema.String,
  /** A JSON body as text; the transport sends it as `application/json`. */
  body: Schema.optionalKey(Schema.String),
});
export type CloudHttpRequest = typeof CloudHttpRequest.Type;

export const CloudHttpResponse = Schema.Struct({
  status: Schema.Int,
  /** The body as the server sent it, untouched (empty for a 204). */
  body: Schema.String,
});
export type CloudHttpResponse = typeof CloudHttpResponse.Type;

export class CloudHttpRpcs extends RpcGroup.make(
  Rpc.make("CloudHttp", {
    payload: CloudHttpRequest,
    success: CloudHttpResponse,
    error: CloudRequestError,
  }),
) {}
