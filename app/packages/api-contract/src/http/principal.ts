/**
 * Who is calling, as the Effect services the auth middlewares provide
 * (`OrgAuth`, `SessionAuth` in `./middleware-tags.ts`).
 *
 * {@link OrgPrincipal} is the org tree's context. Whichever credential
 * authenticated (session cookie, WorkOS bearer, `iwk_` key, agent token), it
 * leaves this in the identical shape, so a permission gate means the same
 * thing for each.
 *
 * The contract states the part of that value every credential leaves and any
 * reader can type: the person, the organization, the permissions and the key.
 * What the server resolves beside them (the role, the active elevations, the
 * cost visibility scope) is typed by server packages a client must never
 * compile against, so the server adds those fields to {@link OrgPrincipalValue}
 * by module augmentation (web's `http/principal.ts`). The tag, and so every
 * handler's `yield* OrgPrincipal`, sees the merged interface; a client that
 * derives from this package sees only the fields declared here, which it never
 * reads anyway, since a middleware's provided service exists only on the
 * server.
 */
import { Context } from "effect";

/** The person a request authenticated as. */
export interface SessionPrincipalValue {
  readonly userId: string;
  readonly email: string;
  /**
   * WorkOS session (`sid`) this request authenticated with, when there is one.
   * Lets the account settings UI mark (and refuse to revoke) the session the
   * user is currently browsing from. Absent only if WorkOS ever hands us a
   * token without the claim.
   */
  readonly sessionId?: string;
}

/** The `iwk_` key or agent credential the request authenticated with, if any. */
export interface ApiKeyPrincipal {
  readonly id: string;
  readonly scopes: readonly string[];
  readonly agentRegistrationId?: string | undefined;
}

/**
 * The org-tree caller. The server augments it with `role`, `elevations` and
 * `costVisibility` (see the module comment).
 */
export interface OrgPrincipalValue {
  readonly session: SessionPrincipalValue;
  readonly organizationId: string;
  readonly permissions: readonly string[];
  readonly apiKey: ApiKeyPrincipal | undefined;
}

export class OrgPrincipal extends Context.Service<OrgPrincipal, OrgPrincipalValue>()(
  "infrawrench/http/OrgPrincipal",
) {}

/** The user-scoped surface (`/api/profile`, `/api/orgs`, ...): a person, no org. */
export class SessionPrincipal extends Context.Service<SessionPrincipal, SessionPrincipalValue>()(
  "infrawrench/http/SessionPrincipal",
) {}
