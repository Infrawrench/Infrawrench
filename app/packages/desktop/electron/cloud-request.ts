/**
 * A request to Infrawrench Cloud from an RPC handler: `cloudFetch` (the
 * signed-in session, one refresh on a 401) with the answer decoded against
 * the operation's schema, so a server that answers in an unexpected shape
 * fails the call with a sentence instead of the renderer receiving whatever
 * came back.
 */
import { Effect, Schema } from "effect";
import { CloudRequestError } from "../shared/rpc/errors";
import { cloudFetch } from "./cloud-data/shared";

/** `path` under the org, decoded as `schema`; a 204 decodes as `null`. */
export const cloudRequest = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  orgId: string,
  path: string,
  init?: RequestInit,
): Effect.Effect<S["Type"], CloudRequestError> =>
  Effect.tryPromise({
    try: () => cloudFetch<unknown>(orgId, path, init),
    catch: CloudRequestError.fromCause,
  }).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(
          (issue) =>
            new CloudRequestError({
              message: `Infrawrench Cloud answered ${path} in an unexpected shape: ${issue.message}`,
            }),
        ),
      ),
    ),
  );
