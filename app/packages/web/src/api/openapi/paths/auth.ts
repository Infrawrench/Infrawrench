import { z } from "../zod";
import { strict, ErrorResponses, Email, Role, Uuid } from "../common";
import type { BuildContext } from "../context";

const SessionResponse = strict({
  userId: Uuid,
  email: Email.nullable(),
  needsOnboarding: z.boolean(),
}).openapi("Session");

const OrgMembership = strict({
  id: Uuid,
  displayName: z.string(),
  role: Role,
}).openapi("OrgMembership");

const Whoami = strict({
  userId: z.string().openapi({
    description:
      "The user the credential acts as. For an agent this is the agent's own user, not the person who claimed it.",
  }),
  organizationId: Uuid.openapi({
    description: "The organization the credential is pinned to.",
  }),
  principal: z.enum(["user", "api_key", "agent"]).openapi({
    description:
      "`user` for a person's WorkOS access token, `api_key` for an `iwk_` key, `agent` for an agent credential or agent token.",
  }),
}).openapi("Whoami");

export function registerAuthPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/auth/sign-in",
    tags: ["Auth"],
    summary: "Start the WorkOS sign-in flow",
    description: "Redirects (302) to the WorkOS authorization URL. Public.",
    security: [],
    responses: {
      302: { description: "Redirect to WorkOS" },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/callback",
    tags: ["Auth"],
    summary: "WorkOS OAuth callback",
    description:
      "Exchanges an authorization code for a session and sets the `wos-session` cookie. " +
      "If the `state` nonce does not match the cookie set at sign-in (most often because " +
      "the cookie expired while the user was still on AuthKit) the flow is restarted once " +
      "with a fresh nonce rather than failing. Public.",
    security: [],
    request: {
      query: strict({
        code: z.string().openapi({ description: "Authorization code from WorkOS" }),
        state: z.string().optional().openapi({ description: "CSRF nonce echoed back by WorkOS" }),
        error: z.string().optional().openapi({
          description: "Error code WorkOS sends instead of `code` when sign-in failed on its side",
        }),
        error_description: z
          .string()
          .optional()
          .openapi({ description: "Human-readable detail accompanying `error`" }),
      }),
    },
    responses: {
      302: { description: "Redirect to `/`, or back to sign-in to restart a failed state check" },
      400: {
        description:
          "Missing code, a provider error redirect (`error` present), or a state check " +
          "that already failed its one restart",
        content: { "text/plain": { schema: z.string() }, "text/html": { schema: z.string() } },
      },
      500: {
        description: "Failed to seal session",
        content: { "text/plain": { schema: z.string() } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/auth/me",
    tags: ["Auth"],
    summary: "Current session + onboarding status",
    responses: {
      200: { description: "Session", content: { "application/json": { schema: SessionResponse } } },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/whoami",
    tags: ["Auth"],
    summary: "Identify a bearer credential",
    description:
      "Reports who an `Authorization: Bearer` credential belongs to: an API key, an agent " +
      "credential, or a WorkOS access token. Needs no scope; a 401 means the credential is " +
      "unknown, revoked, expired or no longer backed by an organization membership. Use it to " +
      "check a key before relying on it, or to gate a service of your own on Infrawrench sign-in.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: "Credential owner", content: { "application/json": { schema: Whoami } } },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/auth/orgs",
    tags: ["Auth"],
    summary: "Organizations the current user belongs to",
    responses: {
      200: {
        description: "Memberships",
        content: { "application/json": { schema: z.array(OrgMembership) } },
      },
      401: ErrorResponses[401],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/auth/sign-out",
    tags: ["Auth"],
    summary: "Clear the session cookie",
    responses: {
      200: {
        description: "Signed out",
        content: { "application/json": { schema: strict({ ok: z.literal(true) }) } },
      },
    },
  });
}
