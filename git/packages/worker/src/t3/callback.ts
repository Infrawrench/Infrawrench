/**
 * `AUTH_PATHS.t3Callback` (`/auth/t3/callback`): where a T3 Code environment
 * sends the browser back, with `code` and `state`, after the person signs in
 * to it from the forge (`t3.beginOAuth`). A redirect, not an endpoint: it
 * exchanges the code, seals the tokens (`./environments.ts`) and sends the
 * browser on to the page it came from, which reads how it went from the
 * environment's row.
 *
 * **The `state` has to come back in the session that started it.** A
 * `state` names a row, and a row is a person's: the request must carry that
 * person's session cookie, or nothing is exchanged and the `state` stays
 * unspent. So a link to this address with somebody else's `code` and
 * `state` connects nothing to the person who follows it, and a `state`
 * that leaked is of no use without its owner's browser.
 *
 * Nothing from the query reaches the answer or a log: the browser is sent
 * to a path stored when the sign-in began (`safeReturnTo`), with one word
 * saying how it went.
 */
import type { Authenticated } from "../auth/authenticate";
import type { Env } from "../env";
import {
  type T3Deps,
  completeSignIn,
  environmentForState,
  safeReturnTo,
  t3Deps,
} from "./environments";

/** Where the browser lands when there is no sign-in to go back to. */
export const T3_SETTINGS_PATH = "/settings/t3";

const redirect = (location: string, cookies: readonly string[] = []): Response => {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
};

/** `path` with `t3=<outcome>` added, for the page to say how the sign-in went. */
const withOutcome = (path: string, outcome: "connected" | "failed"): string => {
  const [before, hash = ""] = path.split("#", 2) as [string, string?];
  const joined = `${before}${before.includes("?") ? "&" : "?"}t3=${outcome}`;
  return hash === "" ? joined : `${joined}#${hash}`;
};

export interface T3CallbackDeps {
  readonly authenticate: (request: Request, env: Env) => Promise<Authenticated>;
  readonly t3?: T3Deps;
}

/** Call inside `withDb`. */
export const handleT3Callback = async (
  request: Request,
  env: Env,
  deps: T3CallbackDeps,
): Promise<Response> => {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed\n", {
      status: 405,
      headers: { allow: "GET", "cache-control": "no-store" },
    });
  }
  const query = new URL(request.url).searchParams;
  const t3 = deps.t3 ?? t3Deps(env, request);
  const failed = redirect(withOutcome(T3_SETTINGS_PATH, "failed"));

  const authenticated = await deps.authenticate(request, env);
  const principal = authenticated.principal;
  // Signed out, or not a browser's session: the state is left for its owner.
  if (principal.kind !== "user" || principal.via !== "session") return failed;

  const row = await environmentForState(query.get("state") ?? "", t3.now());
  if (!row || row.userId !== principal.userId) {
    return redirect(withOutcome(T3_SETTINGS_PATH, "failed"), authenticated.setCookies);
  }
  const code = query.get("code");
  const error = query.get("error");
  const result = await completeSignIn(
    t3,
    row,
    code !== null && code !== "" && error === null
      ? { code, issuer: query.get("iss") }
      : { error: error ?? "no_code" },
  );
  return redirect(
    withOutcome(
      safeReturnTo(result.returnTo, T3_SETTINGS_PATH),
      result.connected ? "connected" : "failed",
    ),
    authenticated.setCookies,
  );
};
