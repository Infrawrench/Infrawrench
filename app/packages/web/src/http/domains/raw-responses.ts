/**
 * Answers built by hand, for the endpoints served with `handleRaw` that talk
 * to a browser or a third party rather than to an API client: the WorkOS
 * sign-in callback, the Slack and provider OAuth hops, Slack's inbound
 * endpoints and the agent ceremonies.
 *
 * Their wire behaviour is a contract with someone who is not our code (a
 * browser following a redirect, Slack reading a status, an OAuth provider), so
 * each helper writes exactly what the Hono route it replaced wrote:
 *
 * - {@link redirect} is `c.redirect(location, status)`: 302 by default, the
 *   `Location` as given, `encodeURI`d only when it holds a character Latin-1
 *   cannot carry, as Hono did.
 * - {@link htmlPage} and {@link plainText} are `c.html` and `c.text`, with
 *   their `charset=UTF-8` content types.
 * - {@link setCookie} and {@link deleteCookie} are Hono's `setCookie` and
 *   `deleteCookie(c, name, { path })`: the same attributes in the same order,
 *   `maxAge` in seconds, and a deletion as `name=; Max-Age=0; Path=...` with no
 *   `Expires`.
 * - {@link queryParam} and {@link requestCookie} read a request as
 *   `c.req.query(name)` and `getCookie(c, name)` did: the first value, or
 *   `undefined`.
 * - {@link answeringFailures} sends an {@link HttpFailure} (a refusal that
 *   carries its own status and body, such as `{ error, code }`) as exactly
 *   that, the way the routes' `c.json(body, status)` did.
 */
import { Duration, Effect } from "effect";
import { HttpServerResponse, type HttpServerRequest } from "effect/http";
import { HttpFailure } from "../errors";
import { failureResponse } from "../middleware";

// eslint-disable-next-line no-control-regex
const BEYOND_LATIN1 = /[^\x00-\xFF]/;

/** `c.redirect(location, status)`. */
export const redirect = (location: string, status = 302) =>
  HttpServerResponse.redirect(BEYOND_LATIN1.test(location) ? encodeURI(location) : location, {
    status,
  });

/** `c.html(body, status)`. */
export const htmlPage = (body: string, status = 200) =>
  HttpServerResponse.text(body, { status, contentType: "text/html; charset=UTF-8" });

/** `c.text(body, status)`. */
export const plainText = (body: string, status = 200) =>
  HttpServerResponse.text(body, { status, contentType: "text/plain; charset=UTF-8" });

/** A cookie as Hono's `setCookie` took it: `maxAge` in seconds. */
export interface CookieOptions {
  readonly path: string;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: "lax" | "strict" | "none";
  readonly maxAge?: number;
}

type ResponseStep = (
  response: HttpServerResponse.HttpServerResponse,
) => HttpServerResponse.HttpServerResponse;

/** `setCookie(c, name, value, options)`, as a step to apply to the response. */
export const setCookie =
  (name: string, value: string, options: CookieOptions): ResponseStep =>
  (response) => {
    const { maxAge, ...rest } = options;
    return HttpServerResponse.setCookieUnsafe(response, name, value, {
      ...rest,
      // A bare number is milliseconds to Effect's cookie encoder.
      ...(maxAge === undefined ? {} : { maxAge: Duration.seconds(maxAge) }),
    });
  };

/** `deleteCookie(c, name, { path })`. */
export const deleteCookie =
  (name: string, path: string): ResponseStep =>
  (response) =>
    HttpServerResponse.setCookieUnsafe(response, name, "", { path, maxAge: 0 });

/**
 * `response` with each step applied in order: the order the Hono handler set
 * and deleted its cookies in, which is the order of the `Set-Cookie` headers.
 */
export const withSteps = (
  response: HttpServerResponse.HttpServerResponse,
  steps: readonly ResponseStep[],
): HttpServerResponse.HttpServerResponse => steps.reduce((out, step) => step(out), response);

/** `c.req.query(name)`: the first value, or `undefined`. */
export const queryParam = (
  request: HttpServerRequest.HttpServerRequest,
  name: string,
): string | undefined =>
  new URL(request.url, "http://localhost").searchParams.get(name) ?? undefined;

/** `getCookie(c, name)`. */
export const requestCookie = (
  request: HttpServerRequest.HttpServerRequest,
  name: string,
): string | undefined => request.cookies[name];

/** `c.req.header(name)`. */
export const requestHeader = (
  request: HttpServerRequest.HttpServerRequest,
  name: string,
): string | undefined => request.headers[name.toLowerCase()];

const isHttpFailure = <E>(error: E): error is Extract<E, HttpFailure> =>
  error instanceof HttpFailure;

/** Send an {@link HttpFailure} the handler failed with as its own status and body. */
export const answeringFailures = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchIf(isHttpFailure, (failure) => Effect.succeed(failureResponse(failure))));
