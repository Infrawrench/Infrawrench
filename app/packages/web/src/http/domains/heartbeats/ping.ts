/**
 * The public ping URL (`GET|POST /api/ping/:token[/start|/fail]`), on its own
 * so the boundary is visible in the imports: this module reaches the ping
 * recorder and nothing else. No session, no org, no credential beyond the
 * token in the path, which is never logged.
 *
 * Served raw so nothing is decoded or refused before the token is looked up,
 * and answered in plain text: a job's `curl -fsS` needs a status code, not a
 * document. Every answer is `no-store`, so no cache between the job and us can
 * swallow a ping. It runs on the edge Worker (Postgres only); the recovery or
 * failure alert goes out after the answer, kept alive with `keepAlive`.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type { HttpServerRequest } from "effect/http";
import type { HeartbeatPingKind } from "@infrawrench/client-core";
import {
  announcePingTransition,
  recordHeartbeatPing,
} from "@infrawrench/server-core/heartbeats/ping";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import { HeartbeatsApi } from "@infrawrench/api-contract";
import { fireAndForget, legacy } from "../../legacy";

/** Bodies past this are not read at all: a ping is a signal, not an upload. */
const MAX_BODY_BYTES = 64 * 1024;

const text = (body: string, status: number) =>
  HttpServerResponse.text(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });

const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    if (request.method !== "POST") return null;
    const length = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const trimmed = body.trim();
    return trimmed ? trimmed : null;
  });

const handlePing = Effect.fn("heartbeats.ping")(function* (
  kind: HeartbeatPingKind,
  token: string,
  request: HttpServerRequest.HttpServerRequest,
) {
  const body = yield* readBody(request);
  const result = yield* legacy(() =>
    recordHeartbeatPing(token, kind, {
      method: request.method,
      userAgent: request.headers["user-agent"] ?? null,
      body,
    }),
  );
  switch (result.outcome) {
    case "not-found":
      return text("Not found\n", 404);
    case "rate-limited":
      return text("Too many pings for this heartbeat; try again in a minute\n", 429);
    case "recorded": {
      const transition = result.transition;
      if (transition) yield* fireAndForget(() => keepAlive(announcePingTransition(transition)));
      return text("OK\n", 200);
    }
  }
});

export const HeartbeatPingHandlers = HttpApiBuilder.group(HeartbeatsApi, "heartbeatPing", (h) =>
  h
    .handleRaw("successGet", ({ params, request }) => handlePing("success", params.token, request))
    .handleRaw("successPost", ({ params, request }) => handlePing("success", params.token, request))
    .handleRaw("startGet", ({ params, request }) => handlePing("start", params.token, request))
    .handleRaw("startPost", ({ params, request }) => handlePing("start", params.token, request))
    .handleRaw("failGet", ({ params, request }) => handlePing("fail", params.token, request))
    .handleRaw("failPost", ({ params, request }) => handlePing("fail", params.token, request)),
);
