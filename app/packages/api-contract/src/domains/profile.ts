/**
 * Personal account settings: `/api/profile`, the endpoint definitions.
 *
 * User-scoped, never org-scoped: one WorkOS identity is shared across every
 * organization the user belongs to. Session-only (a person, never an API key
 * or an agent credential). The operations that can turn a borrowed session
 * into permanent control of the account also require a recent sign-in and
 * refuse with {@link ReauthenticationRequired}.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength } from "../schemas";
import { SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadGateway, BadRequest, NotFound, Unauthorized } from "../http/errors";
import { SessionAuth } from "../http/middleware-tags";
import { Email, Ok } from "../http/schemas/common";
import { describeResponse, optionalRequestBody } from "../http/schemas/documented";

/**
 * The 403 of a route that requires a recent sign-in rather than merely a valid
 * session (`auth/step-up.ts`). Distinguished from a plain 403 by `code`, so a
 * client re-authenticates and retries instead of reporting a permanent
 * authorization failure.
 */
export class ReauthenticationRequired extends Schema.Error<ReauthenticationRequired>(
  "infrawrench/http/profile/ReauthenticationRequired",
)(
  {
    error: Schema.String.annotate({ description: "Human-readable error message" }),
    code: Schema.Literal("reauthentication_required"),
  },
  { httpApiStatus: 403, identifier: "ReauthenticationRequired" },
) {}

const reauthDescription = describeResponse(
  403,
  "Recent sign-in required. Send the user through sign-in again and retry; the request itself was well-formed.",
);

const OAuthProvider = Schema.String.annotate({
  description: "WorkOS OAuth provider id",
  examples: ["GoogleOAuth"],
});

const profileFields = {
  id: Schema.String,
  email: Email,
  emailVerified: Schema.Boolean,
  firstName: Schema.NullOr(Schema.String),
  lastName: Schema.NullOr(Schema.String),
  profilePictureUrl: Schema.NullOr(Schema.String),
  lastSignInAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
};

export const Profile = Schema.Struct({
  ...profileFields,
  identities: Schema.Array(Schema.Struct({ provider: OAuthProvider })).annotate({
    description: "Connected OAuth accounts, if any",
  }),
}).annotate({ identifier: "Profile" });

// The PATCH response omits `identities`: updating a name can't change them,
// and re-listing them would cost an extra WorkOS round trip.
export const ProfileSummary = Schema.Struct(profileFields).annotate({
  identifier: "ProfileSummary",
});

const ProfileUpdate = Schema.Struct({
  firstName: Schema.optionalKey(Schema.String.check(maxLength(128))),
  lastName: Schema.optionalKey(Schema.String.check(maxLength(128))),
});

const OrganizationRef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
}).annotate({ identifier: "OrganizationRef" });

/** An organization the caller must hand over before the account can be deleted. */
const OwnershipBlocker = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  memberCount: Schema.Int.annotate({ description: "People in the organization" }),
}).annotate({ identifier: "OwnershipBlocker" });

export const AccountDeletionPreview = Schema.Struct({
  organizationsToDelete: Schema.Array(OrganizationRef).annotate({
    description: "Deleted with the account; the caller is their only member.",
  }),
  organizationsToLeave: Schema.Array(OrganizationRef).annotate({
    description: "Survive; the caller's membership is removed.",
  }),
  blockers: Schema.Array(OwnershipBlocker).annotate({
    description: "Non-empty means DELETE /api/profile will refuse until another owner is promoted.",
  }),
}).annotate({ identifier: "AccountDeletionPreview" });

export const AccountDeleted = Schema.Struct({
  ok: Schema.Literal(true),
  organizationsDeleted: Schema.Int,
}).annotate({ identifier: "AccountDeleted" });

/** The 409 `DELETE /api/profile` refuses with while the caller solely owns a shared org. */
export class OwnershipTransferRequired extends Schema.Error<OwnershipTransferRequired>(
  "infrawrench/http/profile/OwnershipTransferRequired",
)(
  {
    error: Schema.String,
    code: Schema.Literal("transfer_ownership_required"),
    organizations: Schema.Array(OwnershipBlocker),
  },
  { httpApiStatus: 409, identifier: "OwnershipTransferRequired" },
) {}

export const AuthFactor = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["totp", "sms", "generic_otp"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  totpIssuer: Schema.NullOr(Schema.String),
  totpUser: Schema.NullOr(Schema.String),
}).annotate({ identifier: "AuthFactor" });

export const TotpEnrollment = Schema.Struct({
  factorId: Schema.String,
  challengeId: Schema.String,
  qrCode: Schema.NullOr(Schema.String).annotate({
    description: "Data-URI image of the enrolment QR code",
  }),
  secret: Schema.NullOr(Schema.String).annotate({ description: "Base32 secret, for manual entry" }),
  uri: Schema.NullOr(Schema.String).annotate({ description: "`otpauth://` URI" }),
}).annotate({ identifier: "TotpEnrollment" });

export const UserSession = Schema.Struct({
  id: Schema.String,
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  authMethod: Schema.String,
  status: Schema.String,
  expiresAt: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  current: Schema.Boolean.annotate({ description: "True for the session making this request" }),
}).annotate({ identifier: "UserSession" });

export const PasswordResetLink = Schema.Struct({
  passwordResetUrl: Schema.String,
  expiresAt: Schema.String,
});

export const EmailChangeStarted = Schema.Struct({ newEmail: Email, expiresAt: Schema.String });
export const EmailChanged = Schema.Struct({ email: Email });
export const Challenge = Schema.Struct({ challengeId: Schema.String });
export const Verified = Schema.Struct({ verified: Schema.Literal(true) });
export const Revoked = Schema.Struct({ revoked: Schema.Int });

const FactorParams = { factorId: Schema.String } as const;

export class ProfileGroup extends HttpApiGroup.make("profile")
  .add(
    HttpApiEndpoint.get("get", "/", { success: Profile, error: Unauthorized })
      .annotate(OpenApi.Summary, "The signed-in user's account profile")
      .annotate(
        OpenApi.Description,
        "User-scoped, not organization-scoped: one WorkOS identity is shared across every organization the user belongs to.",
      )
      .annotate(SuccessDescription, "Profile"),
    HttpApiEndpoint.patch("update", "/", {
      payload: ProfileUpdate,
      success: ProfileSummary,
      error: [BadRequest, Unauthorized],
    })
      .annotate(OpenApi.Summary, "Update the signed-in user's name")
      .annotate(SuccessDescription, "Updated")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("deletionPreview", "/deletion-preview", {
      success: AccountDeletionPreview,
      error: Unauthorized,
    })
      .annotate(OpenApi.Summary, "What deleting this account would do")
      .annotate(
        OpenApi.Description,
        "Read-only. Lets a confirmation screen name the organizations that go with the account, and the ones that must be handed over first.",
      )
      .annotate(SuccessDescription, "Preview"),
    HttpApiEndpoint.delete("delete", "/", {
      success: AccountDeleted,
      error: [Unauthorized, ReauthenticationRequired, OwnershipTransferRequired, BadGateway],
    })
      .annotate(OpenApi.Summary, "Delete the signed-in user's account")
      .annotate(
        OpenApi.Description,
        "Irreversible. Organizations where the caller is the only member are deleted and their subscriptions cancelled; other memberships are simply removed. Refuses with `transfer_ownership_required` while the caller is the only owner of an organization other people belong to.",
      )
      .annotate(SuccessDescription, "Deleted")
      .annotate(OpenApi.Transform, (operation) =>
        describeResponse(
          502,
          "A subscription could not be cancelled; nothing was deleted.",
        )(
          describeResponse(
            409,
            "The caller still solely owns a shared organization; nothing was deleted.",
          )(reauthDescription(operation)),
        ),
      ),
    HttpApiEndpoint.post("passwordReset", "/password-reset", {
      success: PasswordResetLink,
      error: [Unauthorized, ReauthenticationRequired],
    })
      .annotate(OpenApi.Summary, "Mint a password reset link for the signed-in user")
      .annotate(
        OpenApi.Description,
        "Returns a one-time AuthKit-hosted reset URL rather than emailing it; the caller already holds a valid session for the account. Also the way to set a first password on an SSO or OAuth-only account.",
      )
      .annotate(SuccessDescription, "Reset link")
      .annotate(OpenApi.Transform, reauthDescription),
    HttpApiEndpoint.post("emailChange", "/email-change", {
      payload: Schema.Struct({ newEmail: Email }),
      success: EmailChangeStarted,
      error: [BadRequest, Unauthorized, ReauthenticationRequired],
    })
      .annotate(OpenApi.Summary, "Send a confirmation code to a new email address")
      .annotate(
        OpenApi.Description,
        "Starts an email change. The code goes to the new address and the account keeps its current address until `/api/profile/email-change/confirm` redeems it, so an abandoned or mistyped change is harmless.",
      )
      .annotate(SuccessDescription, "Code sent")
      .annotate(OpenApi.Transform, (operation) =>
        reauthDescription(optionalRequestBody(operation)),
      ),
    HttpApiEndpoint.post("emailChangeConfirm", "/email-change/confirm", {
      payload: Schema.Struct({ code: Schema.String }),
      success: EmailChanged,
      error: [BadRequest, Unauthorized, ReauthenticationRequired],
    })
      .annotate(OpenApi.Summary, "Redeem an email change code")
      .annotate(
        OpenApi.Description,
        "On success the account's email is the new address and it is marked verified.",
      )
      .annotate(SuccessDescription, "New email")
      .annotate(OpenApi.Transform, (operation) =>
        reauthDescription(optionalRequestBody(operation)),
      ),
    HttpApiEndpoint.post("sendVerificationEmail", "/send-verification-email", {
      success: Ok,
      error: [BadRequest, Unauthorized],
    })
      .annotate(OpenApi.Summary, "Re-send the email verification message")
      .annotate(SuccessDescription, "Sent"),
    HttpApiEndpoint.get("listFactors", "/mfa", {
      success: Schema.Array(AuthFactor),
      error: Unauthorized,
    })
      .annotate(OpenApi.Summary, "List enrolled authentication factors")
      .annotate(
        OpenApi.Description,
        "Includes factors whose enrolment was never confirmed; WorkOS does not expose a verified flag.",
      )
      .annotate(SuccessDescription, "Factors"),
    HttpApiEndpoint.post("enrollFactor", "/mfa", {
      success: TotpEnrollment,
      error: [Unauthorized, ReauthenticationRequired],
    })
      .annotate(OpenApi.Summary, "Begin TOTP enrolment")
      .annotate(
        OpenApi.Description,
        "Creates the factor and a first challenge. The factor only becomes usable once a code is verified; abandon the flow by DELETEing the returned `factorId`.",
      )
      .annotate(SuccessDescription, "Enrolment material")
      .annotate(OpenApi.Transform, reauthDescription),
    HttpApiEndpoint.post("challengeFactor", "/mfa/:factorId/challenge", {
      params: FactorParams,
      success: Challenge,
      error: [Unauthorized, NotFound],
    })
      .annotate(OpenApi.Summary, "Issue a fresh challenge for a factor")
      .annotate(SuccessDescription, "Challenge"),
    HttpApiEndpoint.post("verifyFactor", "/mfa/:factorId/verify", {
      params: FactorParams,
      payload: Schema.Struct({ challengeId: Schema.String, code: Schema.String }),
      success: Verified,
      error: [BadRequest, Unauthorized, NotFound],
    })
      .annotate(OpenApi.Summary, "Verify a code against a challenge")
      .annotate(SuccessDescription, "Verified")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("deleteFactor", "/mfa/:factorId", {
      params: FactorParams,
      success: Ok,
      error: [Unauthorized, ReauthenticationRequired, NotFound],
    })
      .annotate(OpenApi.Summary, "Remove an authentication factor")
      .annotate(SuccessDescription, "Removed")
      .annotate(OpenApi.Transform, reauthDescription),
    HttpApiEndpoint.get("listSessions", "/sessions", {
      success: Schema.Array(UserSession),
      error: Unauthorized,
    })
      .annotate(OpenApi.Summary, "List the signed-in user's active sessions")
      .annotate(SuccessDescription, "Sessions"),
    HttpApiEndpoint.delete("revokeSession", "/sessions/:sessionId", {
      params: { sessionId: Schema.String },
      success: Ok,
      error: [BadRequest, Unauthorized, NotFound],
    })
      .annotate(OpenApi.Summary, "Revoke one session")
      .annotate(
        OpenApi.Description,
        "Refuses the session making the request, use sign-out for that.",
      )
      .annotate(SuccessDescription, "Revoked"),
    HttpApiEndpoint.post("revokeOtherSessions", "/sessions/revoke-others", {
      success: Revoked,
      error: [Unauthorized, ReauthenticationRequired],
    })
      .annotate(OpenApi.Summary, "Revoke every session except the current one")
      .annotate(SuccessDescription, "Count revoked")
      .annotate(OpenApi.Transform, reauthDescription),
  )
  .prefix("/api/profile")
  .middleware(SessionAuth)
  .annotate(OpenApi.Title, "Profile") {}

export class ProfileApi extends withApiDefaults(HttpApi.make("profile").add(ProfileGroup)) {}
