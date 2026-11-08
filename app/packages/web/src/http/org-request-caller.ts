/**
 * Org-scoped callers outside the org tree (`POST /costs/rows`, `/pages`): a
 * session, a WorkOS bearer token or an `iwk_` key, pinned to the path's
 * `:orgId` and holding one scope. See `./caller-auth.ts`.
 *
 * The authenticator is imported when a request needs it, as in
 * `./bearer-caller.ts`: it loads the WorkOS client, and the scripts that
 * import `DOMAINS` have no WorkOS environment.
 */
import { Effect } from "effect";
import { HttpRouter, type HttpServerRequest } from "effect/http";
import type { OrgAuthResult } from "../auth/org-request-auth";
import { asCaller, rawRequest } from "./caller-auth";
import { HttpFailure } from "./errors";
import { legacy } from "./legacy";

/**
 * The caller pinned to `:orgId` and holding `requiredScope`, or the refusal
 * `authenticateOrgRawRequest` answered, in its own words.
 */
export const orgRequestCaller = Effect.fnUntraced(function* (
  requiredScope: string,
): Effect.fn.Return<
  OrgAuthResult,
  HttpFailure,
  HttpServerRequest.HttpServerRequest | HttpRouter.RouteContext
> {
  const raw = yield* rawRequest;
  const route = yield* HttpRouter.RouteContext;
  const orgId = route.params["orgId"];
  if (!orgId) {
    return yield* Effect.fail(new HttpFailure(400, { error: "Missing organization ID" }));
  }
  const auth = yield* legacy(async () => {
    const { authenticateOrgRawRequest } = await import("../auth/org-request-auth");
    return authenticateOrgRawRequest(raw, orgId, requiredScope);
  });
  if (!auth.ok) return yield* Effect.fail(new HttpFailure(auth.status, { error: auth.error }));
  return auth.caller;
});

/** Authenticate as {@link orgRequestCaller}, then `serve` as the caller; a refusal is the response. */
export const asOrgRequestCaller = <A, E, R>(
  requiredScope: string,
  serve: (caller: OrgAuthResult) => Effect.Effect<A, E, R>,
) => asCaller(orgRequestCaller(requiredScope), serve);
