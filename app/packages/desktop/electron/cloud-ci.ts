/**
 * A running CI run's live log, served as the `CloudCiRunLogs` RPC
 * (`shared/rpc/groups/cloud-ci.ts`), the way `cloud-chat.ts` serves the chat
 * turn: the route answers Server-Sent Events, which the buffered `CloudHttp`
 * transport cannot carry, so the main process sends it with the transport's
 * session (`sendAuthenticated`: the bearer token, one forced refresh and
 * retry on a 401) to a path it builds itself, and hands on each event as it
 * arrives. One whose data is not JSON (a keep-alive) is dropped. The
 * stream's scope owns the fetch: interrupting it cancels the body, which
 * closes the connection.
 *
 * Imports `cloud-transport.ts`, which reads tokens from `cloud-tokens.ts`
 * directly, so this module has no import-time side effects either.
 */
import { Context, Effect, Layer, Result, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { CloudRequestError } from "../shared/rpc/errors";
import type { CloudCiLogFrame, CloudCiRunLogsRequest } from "../shared/rpc/groups/cloud-ci";
import { sendAuthenticated } from "./cloud-transport";

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json));

const logsPath = ({ orgId, runId }: CloudCiRunLogsRequest) =>
  `/api/org/${encodeURIComponent(orgId)}/ci/runs/${encodeURIComponent(runId)}/logs`;

/** The body of an answer that is not a stream, or nothing if it cannot be read. */
const bodyText = (response: Response) => Effect.promise(() => response.text().catch(() => ""));

/** The server's refusal sentence (`{ "error": ... }`), or the text as it came. */
const refusal = (text: string, status: number) => {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON.
  }
  return text || `Cloud request failed: ${status}`;
};

const openLogs = Effect.fnUntraced(function* (request: CloudCiRunLogsRequest) {
  const response = yield* sendAuthenticated({ method: "GET", url: logsPath(request) });
  const body = response.body;
  if (!response.ok || body === null) {
    const text = yield* bodyText(response);
    return yield* new CloudRequestError({ message: refusal(text, response.status) });
  }
  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: CloudRequestError.fromCause,
  }).pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.mapError(CloudRequestError.fromCause),
    Stream.filterMap((event) =>
      Result.map(decodeJson(event.data), (data): CloudCiLogFrame => ({ event: event.event, data })),
    ),
  );
});

export class CloudCi extends Context.Service<
  CloudCi,
  {
    readonly runLogs: (
      request: CloudCiRunLogsRequest,
    ) => Stream.Stream<CloudCiLogFrame, CloudRequestError>;
  }
>()("infrawrench/desktop/CloudCi") {
  static readonly layer = Layer.succeed(CloudCi)(
    CloudCi.of({ runLogs: (request) => Stream.unwrap(openLogs(request)) }),
  );
}
