import { z } from "../zod";
import { strict, ErrorResponses, Email, Ok } from "../common";
import type { BuildContext } from "../context";

const OAuthProvider = z
  .string()
  .openapi({ description: "WorkOS OAuth provider id", example: "GoogleOAuth" });

const Profile = strict({
  id: z.string(),
  email: Email,
  emailVerified: z.boolean(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  profilePictureUrl: z.string().nullable(),
  lastSignInAt: z.string().nullable(),
  createdAt: z.string(),
  identities: z
    .array(strict({ provider: OAuthProvider }))
    .openapi({ description: "Connected OAuth accounts, if any" }),
}).openapi("Profile");

// The PATCH response omits `identities` — updating a name can't change them,
// and re-listing them would cost an extra WorkOS round trip.
const ProfileSummary = strict({
  id: z.string(),
  email: Email,
  emailVerified: z.boolean(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  profilePictureUrl: z.string().nullable(),
  lastSignInAt: z.string().nullable(),
  createdAt: z.string(),
}).openapi("ProfileSummary");

const AuthFactor = strict({
  id: z.string(),
  type: z.enum(["totp", "sms", "generic_otp"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  totpIssuer: z.string().nullable(),
  totpUser: z.string().nullable(),
}).openapi("AuthFactor");

const TotpEnrollment = strict({
  factorId: z.string(),
  challengeId: z.string(),
  qrCode: z.string().nullable().openapi({ description: "Data-URI image of the enrolment QR code" }),
  secret: z.string().nullable().openapi({ description: "Base32 secret, for manual entry" }),
  uri: z.string().nullable().openapi({ description: "`otpauth://` URI" }),
}).openapi("TotpEnrollment");

const UserSession = strict({
  id: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  authMethod: z.string(),
  status: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  current: z.boolean().openapi({ description: "True for the session making this request" }),
}).openapi("UserSession");

export function registerProfilePaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/profile",
    tags: ["Profile"],
    summary: "The signed-in user's account profile",
    description:
      "User-scoped, not organization-scoped: one WorkOS identity is shared across every organization the user belongs to.",
    responses: {
      200: { description: "Profile", content: { "application/json": { schema: Profile } } },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/profile",
    tags: ["Profile"],
    summary: "Update the signed-in user's name",
    request: {
      body: {
        content: {
          "application/json": {
            schema: strict({
              firstName: z.string().max(128).optional(),
              lastName: z.string().max(128).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: ProfileSummary } } },
      400: ErrorResponses[400],
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/profile/password-reset",
    tags: ["Profile"],
    summary: "Mint a password reset link for the signed-in user",
    description:
      "Returns a one-time AuthKit-hosted reset URL rather than emailing it — the caller already holds a valid session for the account. Also the way to set a first password on an SSO or OAuth-only account.",
    responses: {
      200: {
        description: "Reset link",
        content: {
          "application/json": {
            schema: strict({ passwordResetUrl: z.string(), expiresAt: z.string() }),
          },
        },
      },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/profile/send-verification-email",
    tags: ["Profile"],
    summary: "Re-send the email verification message",
    responses: {
      200: { description: "Sent", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/profile/mfa",
    tags: ["Profile"],
    summary: "List enrolled authentication factors",
    description:
      "Includes factors whose enrolment was never confirmed — WorkOS does not expose a verified flag.",
    responses: {
      200: {
        description: "Factors",
        content: { "application/json": { schema: z.array(AuthFactor) } },
      },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/profile/mfa",
    tags: ["Profile"],
    summary: "Begin TOTP enrolment",
    description:
      "Creates the factor and a first challenge. The factor only becomes usable once a code is verified; abandon the flow by DELETEing the returned `factorId`.",
    responses: {
      200: {
        description: "Enrolment material",
        content: { "application/json": { schema: TotpEnrollment } },
      },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/profile/mfa/{factorId}/challenge",
    tags: ["Profile"],
    summary: "Issue a fresh challenge for a factor",
    request: { params: strict({ factorId: z.string() }) },
    responses: {
      200: {
        description: "Challenge",
        content: { "application/json": { schema: strict({ challengeId: z.string() }) } },
      },
      401: ErrorResponses[401],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/profile/mfa/{factorId}/verify",
    tags: ["Profile"],
    summary: "Verify a code against a challenge",
    request: {
      params: strict({ factorId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: strict({ challengeId: z.string(), code: z.string() }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Verified",
        content: { "application/json": { schema: strict({ verified: z.literal(true) }) } },
      },
      400: ErrorResponses[400],
      401: ErrorResponses[401],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/profile/mfa/{factorId}",
    tags: ["Profile"],
    summary: "Remove an authentication factor",
    request: { params: strict({ factorId: z.string() }) },
    responses: {
      200: { description: "Removed", content: { "application/json": { schema: Ok } } },
      401: ErrorResponses[401],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/profile/sessions",
    tags: ["Profile"],
    summary: "List the signed-in user's active sessions",
    responses: {
      200: {
        description: "Sessions",
        content: { "application/json": { schema: z.array(UserSession) } },
      },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/profile/sessions/{sessionId}",
    tags: ["Profile"],
    summary: "Revoke one session",
    description: "Refuses the session making the request — use sign-out for that.",
    request: { params: strict({ sessionId: z.string() }) },
    responses: {
      200: { description: "Revoked", content: { "application/json": { schema: Ok } } },
      400: ErrorResponses[400],
      401: ErrorResponses[401],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/profile/sessions/revoke-others",
    tags: ["Profile"],
    summary: "Revoke every session except the current one",
    responses: {
      200: {
        description: "Count revoked",
        content: {
          "application/json": { schema: strict({ revoked: z.number().int() }) },
        },
      },
      401: ErrorResponses[401],
    },
  });
}
