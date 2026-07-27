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
      "Exchanges an authorization code for a session and sets the `wos-session` cookie. Public.",
    security: [],
    request: {
      query: strict({
        code: z.string().openapi({ description: "Authorization code from WorkOS" }),
      }),
    },
    responses: {
      302: { description: "Redirect to `/`" },
      400: { description: "Missing code", content: { "text/plain": { schema: z.string() } } },
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
