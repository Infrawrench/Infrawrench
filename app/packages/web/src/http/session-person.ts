/**
 * The signed-in person on a browser page that checks the session itself
 * rather than through the `SessionAuth` middleware: pages outside every auth layer that
 * bounce a signed-out browser through sign-in and come back (the GitHub App
 * setup callback, the anomaly feedback link). Their refusals are their own
 * (a redirect, an HTML page), so the session is a step in the handler, not a
 * middleware that would answer first.
 *
 * {@link sessionPerson} is `authenticatePerson` (`./auth.ts`), the same step
 * `sessionMiddleware` runs, failing with the `HttpFailure` that middleware
 * answered (the 401, or the 403 for an agent's token). A session WorkOS
 * refreshed is set on whatever the handler answers, as the Hono middleware's
 * `setCookie` was. The auth chain is imported on use, not with the module:
 * it loads the WorkOS client, which refuses to load without its environment,
 * and `DOMAINS` is imported by scripts (the spec build, `spec-diff`) that
 * have none.
 */
import { Effect } from "effect";
import type { HttpServerRequest } from "effect/http";
import type { AuthSession } from "../auth/users";
import { rawRequest } from "./caller-auth";
import type { HttpFailure } from "./errors";
import { legacy } from "./legacy";
import { keepRefreshedSession } from "./session-cookie";

export const sessionPerson: Effect.Effect<
  AuthSession,
  HttpFailure,
  HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const raw = yield* rawRequest;
  const { authenticatePerson } = yield* legacy(() => import("./auth"));
  const person = yield* authenticatePerson({ raw, orgId: undefined });
  yield* keepRefreshedSession(person.refreshedSession);
  return person.session;
});
