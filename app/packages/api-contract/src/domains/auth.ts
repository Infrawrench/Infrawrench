/**
 * Browser sign-in and the session: `/api/auth`, the endpoint definitions.
 *
 * `GET /api/auth/sign-in` is public (it starts the WorkOS redirect); the rest
 * is the user-scoped, session-only surface: a person, never an API key or an
 * agent credential. The sign-in and sign-out redirects are in the public
 * spec's withheld list, so those two operations are `x-internal`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { Unauthorized } from "../http/errors";
import { SessionAuth } from "../http/middleware-tags";
import { Email, Uuid } from "../http/schemas/common";
import { describeResponse } from "../http/schemas/documented";
import { OrganizationRole } from "../http/schemas/permissions";

export const Session = Schema.Struct({
  userId: Uuid,
  email: Schema.NullOr(Email),
  needsOnboarding: Schema.Boolean,
}).annotate({ identifier: "Session" });

export const OrgMembership = Schema.Struct({
  id: Uuid,
  displayName: Schema.String,
  role: OrganizationRole,
}).annotate({ identifier: "OrgMembership" });

export const SignedOut = Schema.Struct({ ok: Schema.Literal(true) });

export class SignInGroup extends HttpApiGroup.make("signIn")
  .add(
    HttpApiEndpoint.get("signIn", "/sign-in", { success: HttpApiSchema.Empty(302) })
      .annotate(OpenApi.Summary, "Start the WorkOS sign-in flow")
      .annotate(OpenApi.Description, "Redirects (302) to the WorkOS authorization URL. Public.")
      // Not `SuccessDescription`, which the spec builder applies to 2xx responses only.
      .annotate(OpenApi.Transform, describeResponse(302, "Redirect to WorkOS"))
      .annotate(Security, []),
  )
  .prefix("/api/auth")
  .annotate(OpenApi.Title, "Auth") {}

export class AuthGroup extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("me", "/me", { success: Session, error: Unauthorized })
      .annotate(OpenApi.Summary, "Current session + onboarding status")
      .annotate(SuccessDescription, "Session"),
    HttpApiEndpoint.get("orgs", "/orgs", {
      success: Schema.Array(OrgMembership),
      error: Unauthorized,
    })
      .annotate(OpenApi.Summary, "Organizations the current user belongs to")
      .annotate(SuccessDescription, "Memberships"),
    HttpApiEndpoint.post("signOut", "/sign-out", { success: SignedOut })
      .annotate(OpenApi.Summary, "Clear the session cookie")
      .annotate(SuccessDescription, "Signed out"),
  )
  .prefix("/api/auth")
  .middleware(SessionAuth)
  .annotate(OpenApi.Title, "Auth") {}

export class AuthApi extends withApiDefaults(
  HttpApi.make("auth").add(SignInGroup).add(AuthGroup),
) {}
