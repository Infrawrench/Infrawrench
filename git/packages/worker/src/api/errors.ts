/**
 * How the API answers when something refuses: the contract's error classes
 * as `{ error, code? }` with their status, a request that fails its schema as
 * the 400 with its issues, a `RepoReader` refusal as the API's own error for
 * it, and anything else as a 500 that says nothing about the server.
 *
 * Handlers are promise code and refuse by throwing (`./context.ts`), so most
 * refusals arrive here as defects, declared on the endpoint or not. This is
 * the `RequestErrors` middleware, outermost on every endpoint.
 */
import { Cause, Context, Effect, Layer, Predicate, SchemaIssue } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiError } from "effect/http-api";
import {
  BadRequest,
  Conflict,
  type ErrorCode,
  Forbidden,
  InternalServerError,
  InvalidRequestMessage,
  NotFound,
  PaymentRequired,
  RequestErrors,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  UnprocessableEntity,
} from "@infrawrench/git-contract";
import { type RepoReaderCode, RepoReaderError } from "../repo/reader";
import { describeError } from "../http/log";

export const json = (body: unknown, status: number) =>
  HttpServerResponse.jsonUnsafe(body, { status });

const API_ERRORS = [
  [BadRequest, 400],
  [Unauthorized, 401],
  [PaymentRequired, 402],
  [Forbidden, 403],
  [NotFound, 404],
  [Conflict, 409],
  [UnprocessableEntity, 422],
  [TooManyRequests, 429],
  [InternalServerError, 500],
  [ServiceUnavailable, 503],
] as const;

const apiErrorStatus = (error: unknown): number | undefined => {
  for (const [errorClass, status] of API_ERRORS) {
    if (error instanceof errorClass) return status;
  }
  return undefined;
};

/**
 * What each `RepoReader` refusal is on the API. A handler that needs another
 * answer for one (a `ref_not_found` that is a 422 because the ref came in a
 * payload) catches the `RepoReaderError` itself.
 */
const READER_STATUS: Record<RepoReaderCode, { status: number; code?: ErrorCode; error: string }> = {
  unavailable: { status: 503, error: "Repository contents are not available right now" },
  ref_not_found: { status: 404, code: "ref_not_found", error: "No such branch, tag or commit" },
  path_not_found: { status: 404, code: "path_not_found", error: "No such path" },
  not_a_file: { status: 422, code: "not_a_file", error: "That path is not a file" },
  not_a_directory: { status: 422, code: "not_a_directory", error: "That path is not a directory" },
  too_large: { status: 422, code: "too_large", error: "That file is too large" },
  repository_empty: {
    status: 422,
    code: "repository_empty",
    error: "Nothing has been pushed to this repository yet",
  },
  ref_exists: { status: 409, code: "ref_exists", error: "A branch with that name exists" },
  head_moved: { status: 409, code: "head_moved", error: "The branch has moved" },
  invalid_ref: { status: 400, code: "name_invalid", error: "That is not a valid branch name" },
};

const body = (error: string, code: unknown) =>
  typeof code === "string" ? { error, code } : { error };

/** The response for something thrown, whatever it is. */
export const renderFailure = (failure: unknown): HttpServerResponse.HttpServerResponse => {
  const status = apiErrorStatus(failure);
  if (status !== undefined && Predicate.hasProperty(failure, "error")) {
    return json(
      body(
        String(failure.error),
        Predicate.hasProperty(failure, "code") ? failure.code : undefined,
      ),
      status,
    );
  }
  if (failure instanceof RepoReaderError) {
    const known = READER_STATUS[failure.code];
    return json(body(known.error, known.code), known.status);
  }
  // Nothing of the error is in the answer, and the log gets what
  // `describeError` keeps of it. The id ties the answer to the log line.
  const correlationId = crypto.randomUUID();
  console.error(`[git] uncaught error correlationId=${correlationId}: ${describeError(failure)}`);
  return json({ error: "Internal server error", correlationId }, 500);
};

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export const RequestErrorsLive = Layer.succeed(RequestErrors)((httpEffect, { endpoint }) => {
  // Params, query, headers or payload that fail their schema are the caller's
  // 400. A schema error raised while encoding the answer is ours: a 500.
  const schemaError = (error: HttpApiError.HttpApiSchemaError) =>
    error.kind === "Body" || error.kind === "ResponseHeaders"
      ? renderFailure(error)
      : json(
          {
            error: Context.get(endpoint.annotations, InvalidRequestMessage),
            ...formatIssues(error.cause.issue),
          },
          400,
        );
  return httpEffect.pipe(
    Effect.catchCause((cause) => {
      const failed = Cause.findError(cause);
      if (failed._tag === "Success") {
        const error: unknown = failed.success;
        if (HttpApiError.HttpApiSchemaError.is(error)) return Effect.succeed(schemaError(error));
        if (apiErrorStatus(error) !== undefined) return Effect.succeed(renderFailure(error));
        return Effect.failCause(cause);
      }
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      const found = Cause.findDefect(cause);
      const defect = found._tag === "Success" ? found.success : Cause.squash(cause);
      if (HttpApiError.HttpApiSchemaError.is(defect)) return Effect.succeed(schemaError(defect));
      return Effect.succeed(renderFailure(defect));
    }),
  );
});
