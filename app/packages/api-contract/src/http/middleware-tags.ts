/**
 * The HttpApi middleware tags, on their own so endpoint definitions can name
 * them without loading any implementation. The implementations are the
 * server's (web's `http/middleware.ts` and `http/middleware-live.ts`).
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
