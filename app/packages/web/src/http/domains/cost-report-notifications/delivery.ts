/**
 * What the report and dashboard delivery domains share: the store's refusals
 * as typed errors, and the schedule body read as the Hono routes read it.
 */
import { Effect, Predicate } from "effect";
import type { HttpServerRequest } from "effect/http";
import type { ReportNotificationInput } from "@infrawrench/client-core";
import { ReportNotificationInputError } from "@infrawrench/server-core/report-delivery/store";
import { BadRequest, NotFound } from "../../errors";
import { fieldsOf, readJson } from "../../json-body";
import { legacyTry } from "../../legacy";

/** A store refusal (`ReportNotificationInputError`), with the status it carries. */
export const deliveryRefusal = (error: unknown): BadRequest | NotFound | undefined => {
  if (!(error instanceof ReportNotificationInputError)) return undefined;
  return error.status === 404
    ? new NotFound({ error: error.message })
    : new BadRequest({ error: error.message });
};

/** Promise code whose `ReportNotificationInputError` is the caller's 400 or 404. */
export const deliveryCall = <A>(fn: () => PromiseLike<A>) => legacyTry(fn, deliveryRefusal);

/**
 * A parsed body handed to the store as its input. The predicate claims only
 * an object: `normalizeInput` (server-core) then checks the cadence, every
 * number, the zone and each destination list itself, as it did when the
 * route cast the body.
 */
const isScheduleBody = <T extends ReportNotificationInput>(body: unknown): body is T =>
  Predicate.isObject(body);

/**
 * The schedule body as `(await c.req.json()) as Input` read it: a body that
 * is not JSON, or is `null`, is still the 500 it was, and anything else
 * reaches the store, whose sentences answer for it.
 */
export const readScheduleBody = <T extends ReportNotificationInput>(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<T> =>
  Effect.gen(function* () {
    const body = yield* fieldsOf(yield* readJson(request));
    if (isScheduleBody<T>(body)) return body;
    // Unreachable: `fieldsOf` only answers with an object.
    return yield* Effect.die(new TypeError("Request body is not an object"));
  });
