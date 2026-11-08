/**
 * Bearer-only callers (`/api/v1/whoami`, desktop sync, the pricing data):
 * see `./caller-auth.ts`.
 *
 * The authenticator is imported when a request needs it, not with the
 * module: `auth/api-auth.ts` loads the WorkOS client, which refuses to load
 * without its environment, and `DOMAINS` is imported by scripts (the spec
 * build, `spec-diff`) that have none.
 */
import { Effect } from "effect";
import type { HttpServerRequest } from "effect/http";
import type { ApiAuthResult } from "../auth/api-auth";
import { asCaller, rawRequest } from "./caller-auth";
import { HttpFailure } from "./errors";
import { legacy } from "./legacy";
import { failureResponse } from "./middleware";
import type { PrefixGuard } from "./prefix-guard";

/**
 * Who a bearer credential belongs to (an `iwk_` key, an agent credential, a
 * WorkOS access token), or the 401 `authenticateApiRequest`'s null has
 * always answered.
 */
export const bearerCaller: Effect.Effect<
  ApiAuthResult,
  HttpFailure,
  HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const raw = yield* rawRequest;
  const auth = yield* legacy(async () => {
    const { authenticateApiRequest } = await import("../auth/api-auth");
    return authenticateApiRequest(raw);
  });
  if (!auth) return yield* Effect.fail(new HttpFailure(401, { error: "Unauthorized" }));
  return auth;
});

/** Authenticate a bearer credential, then `serve` as its holder; a refusal is the response. */
export const asBearerCaller = <A, E, R>(serve: (caller: ApiAuthResult) => Effect.Effect<A, E, R>) =>
  asCaller(bearerCaller, serve);

/**
 * The guard for the rest of a bearer-only prefix (`./prefix-guard.ts`): a
 * 401 without a credential, and with one, on to the 404 nothing routes.
 */
export const bearerPrefixGuard: PrefixGuard = bearerCaller.pipe(
  Effect.as(undefined),
  Effect.catch((failure) => Effect.succeed(failureResponse(failure))),
);
