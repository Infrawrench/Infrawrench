/**
 * A running CI run's live log: `GET /ci/runs/:runId/logs`, Server-Sent
 * Events the buffered `CloudHttp` transport cannot carry.
 *
 * One call per follower. Each element is one event: its SSE `event:` name
 * and its `data` as the server's JSON, which the renderer reads with
 * client-core's `ciLogEvent` (so the main process needs no knowledge of the
 * runner's events, and a newer server's are dropped in one place). The
 * stream ends when the run's log does; interrupting it, or the renderer
 * going away, cancels the fetch. A request that never got a stream fails
 * with `CloudRequestError`, whose message the CI panel shows.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { CloudRequestError } from "../errors";

export const CloudCiRunLogsRequest = Schema.Struct({
  orgId: Schema.String,
  runId: Schema.String,
});
export type CloudCiRunLogsRequest = typeof CloudCiRunLogsRequest.Type;

export const CloudCiLogFrame = Schema.Struct({
  event: Schema.String,
  data: Schema.Json,
});
export type CloudCiLogFrame = typeof CloudCiLogFrame.Type;

export class CloudCiRpcs extends RpcGroup.make(
  Rpc.make("CloudCiRunLogs", {
    payload: CloudCiRunLogsRequest,
    success: CloudCiLogFrame,
    error: CloudRequestError,
    stream: true,
  }),
) {}
