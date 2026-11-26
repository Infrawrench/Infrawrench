/**
 * `AUTH_PATHS.t3Callback` (`/auth/t3/callback`): where a T3 Code environment
 * sends the browser back, with `code` and `state`, after the person signs in
 * to it from the forge (`t3.beginOAuth`). A redirect, not an endpoint: it
 * exchanges the code, stores the tokens encrypted (`api/handlers/t3.ts` says
 * how) and sends the browser on to the page it came from.
 *
 * Not built yet. The route is wired at all three of its ends (the contract's
 * `urls.ts`, `http/router.ts`, and the dev server's `/auth` proxy) and
 * answers 503 until it is.
 */
import type { Env } from "../env";

export const handleT3Callback = async (_request: Request, _env: Env): Promise<Response> =>
  new Response("Signing in to T3 Code is not available yet\n", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
