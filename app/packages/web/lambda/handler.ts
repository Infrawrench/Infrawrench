/**
 * The web app's Lambda gateway: the Hono API on AWS Lambda, behind the edge
 * Worker, for the Node work that finishes within a request.
 *
 * Three tiers serve `app.infrawrench.com` (KNOWLEDGE.md, "Edge/gateway split"):
 *
 * - the **edge** Worker runs most of the API itself;
 * - this **Lambda gateway** takes what needs real Node but no long-lived
 *   process: plugin code (the web Worker carries none), socket drivers, SSH
 *   that finishes in the request, and the writes that reach them;
 * - the **session gateway** (the Node server, `server.ts`) keeps what does
 *   need one: WebSockets, the in-process registries, chat's long streams.
 *
 * The Worker calls the function URL with a shared secret; see
 * `src/lambda/protocol.ts` for the contract and `src/lambda/handle-request.ts`
 * for the logic. Responses stream (invoke mode `RESPONSE_STREAM`), which lifts
 * the 6 MB buffered-response limit to 200 MB.
 *
 * Packaged as a container image (`infra/docker/lambda.Dockerfile`) because the
 * externalized native and socket libraries need a real `node_modules`. The
 * image runs our own runtime (`lambda/runtime.ts`), which provides the
 * `awslambda` global the managed runtime would, and the function runs on
 * SnapStart: everything above the handler is init, done once per deploy and
 * copied into every environment, so it must not keep randomness or sockets
 * (`server-core/src/runtime/lambda-snapshot.ts` refuses a snapshot that does).
 */
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { lambdaInvocation, prepareLambdaProcess } from "@infrawrench/server-core/runtime/lambda";
import type { FunctionUrlEvent } from "../src/lambda/handle-request";

/** The response stream the Node.js runtime hands a streaming handler. */
type ResponseStream = NodeJS.WritableStream & { end(chunk?: string): void };

declare const awslambda: {
  streamifyResponse(
    handler: (event: FunctionUrlEvent, responseStream: ResponseStream) => Promise<void>,
  ): unknown;
  HttpResponseStream: {
    from(stream: ResponseStream, metadata: object): ResponseStream;
  };
};

// Init phase: configuration first (the API reads some of it at import time),
// then the API itself, once per execution environment rather than per request.
await prepareLambdaProcess();
const [{ api }, accounts, scope, request] = await Promise.all([
  import("../src/api/index"),
  import("@infrawrench/server-core/runtime/account-runtime"),
  import("@infrawrench/server-core/runtime/request-scope"),
  import("../src/lambda/handle-request"),
]);

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const invocation = lambdaInvocation({ sessionHandoff: true });
  let response: Response;
  try {
    response = await invocation.run(() =>
      request.handleLambdaRequest(request.eventToRequest(event), {
        secret: process.env["LAMBDA_GATEWAY_SECRET"],
        apiFetch: async (req) => api.fetch(req),
        accountNeedsSession: accounts.accountNeedsSession,
        gatewayOnlyHit: scope.gatewayOnlyHitInScope,
        dbWrites: scope.dbWritesInScope,
        waitUntil: (promise) => void scope.keepAlive(promise),
      }),
    );
  } catch (error) {
    console.error("[lambda] request failed:", error);
    response = new Response("Internal Server Error", { status: 500 });
  }

  const out = awslambda.HttpResponseStream.from(responseStream, request.responseMetadata(response));
  try {
    if (response.body) {
      await invocation.run(() =>
        pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), out),
      );
    } else {
      // Metadata is only sent with the first write.
      out.write("");
      out.end();
    }
  } catch (error) {
    // The client went away mid-stream, or the body errored; either way there
    // is nobody left to tell.
    console.warn("[lambda] response stream ended early:", error);
  }
  // After the response has gone, before the invocation ends: anything
  // `keepAlive` was given (audit writes, Slack replies) finishes here rather
  // than being frozen with the environment.
  await invocation.drain();
});
