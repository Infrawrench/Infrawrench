/**
 * The HttpApi middleware tags, on their own so endpoint definitions (a
 * domain's `api.ts`) can name them without loading any implementation. The
 * implementations are in `./middleware.ts` (shared, light) and
 * `./middleware-live.ts` (the auth chain).
 */
import { HttpApiMiddleware } from "effect/http-api";
import type { OrgPrincipal, SessionPrincipal } from "./principal";

export class OrgAuth extends HttpApiMiddleware.Service<OrgAuth, { provides: OrgPrincipal }>()(
  "infrawrench/http/OrgAuth",
) {}

export class SessionAuth extends HttpApiMiddleware.Service<
  SessionAuth,
  { provides: SessionPrincipal }
>()("infrawrench/http/SessionAuth") {}

export class RequestErrors extends HttpApiMiddleware.Service<RequestErrors>()(
  "infrawrench/http/RequestErrors",
) {}
