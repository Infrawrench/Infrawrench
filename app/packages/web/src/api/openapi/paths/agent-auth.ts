import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime, Ok } from "../common";
import type { BuildContext } from "../context";

/**
 * Agent registration and the claim ceremony.
 *
 * The three `/api/agent/*` routes are deliberately part of the *public* spec
 * even though two of them take no session: they are the documented way an
 * autonomous client gets credentials, and a surface an agent is meant to
 * discover cannot be one we leave out of the description of the API.
 */
const RegisterRequest = strict({
  label: z
    .string()
    .max(80)
    .optional()
    .openapi({ description: "Short name for the workspace, shown to the user who claims it." }),
}).openapi("AgentRegisterRequest");

const RegisteredAgent = strict({
  registration_id: Uuid,
  credential: z.string().openapi({
    description:
      "Bearer credential for this registration. Format `iwa_<base64url>`. Returned once and " +
      "never recoverable — there is no route that can show it again.",
  }),
  organization_id: Uuid,
  trial_expires_at: IsoDateTime.openapi({
    description: "When the trial workspace is deleted unless a person claims it.",
  }),
  claim_url: z.string().url(),
  notice: z.string().openapi({
    description: "Human-readable summary of the trial terms, meant to be relayed to the user.",
  }),
}).openapi("RegisteredAgent");

const ClaimStarted = strict({
  user_code: z.string().openapi({
    description: "Formatted as `XXXX-XXXX`. Show it to the user alongside `verification_uri`.",
  }),
  verification_uri: z.string().url(),
  verification_uri_complete: z
    .string()
    .url()
    .openapi({
      description:
        "The verification page with the code pre-filled. Convenient, but it puts a live bearer " +
        "secret in a URL — prefer `verification_uri` plus the code shown separately.",
    }),
  expires_at: IsoDateTime,
  interval: z.number().int().openapi({ description: "Minimum seconds between status polls." }),
}).openapi("AgentClaimStarted");

const AgentIdentity = strict({
  registration_id: Uuid,
  organization_id: Uuid,
  claimed: z.boolean(),
  claim_pending: z.boolean().openapi({ description: "A `user_code` is currently outstanding." }),
  trial_expires_in_ms: z
    .number()
    .int()
    .nullable()
    .openapi({ description: "Milliseconds until deletion. Null once the workspace is claimed." }),
}).openapi("AgentIdentity");

const AgentRegistration = strict({
  id: Uuid,
  label: z.string().nullable(),
  kind: z.enum(["anonymous", "service_auth"]),
  prefix: z.string().nullable().openapi({ description: "First 8 characters of the credential." }),
  claimedAt: IsoDateTime.nullable(),
  claimedByUserId: z.string().nullable(),
  claimedByEmail: z.string().nullable(),
  lastSeenAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
}).openapi("AgentRegistration");

export function registerAgentAuthPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParams = OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "post",
    path: "/api/agent/identity",
    tags: ["Agent auth"],
    summary: "Open an anonymous registration and a 24-hour trial workspace",
    description:
      "Requires no authentication — this is how a client with no credentials gets one. Rate " +
      "limited per source address. The workspace it opens is deleted 24 hours later unless a " +
      "person completes the claim ceremony.",
    security: [],
    request: {
      body: { content: { "application/json": { schema: RegisterRequest } } },
    },
    responses: {
      200: {
        description: "Registered",
        content: { "application/json": { schema: RegisteredAgent } },
      },
      429: { description: "Too many registrations from this address" },
      500: { description: "Could not open a workspace" },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/agent/identity",
    tags: ["Agent auth"],
    summary: "Poll this registration's claim status and time remaining",
    responses: {
      200: { description: "Status", content: { "application/json": { schema: AgentIdentity } } },
      401: { description: "Unknown or revoked credential" },
      404: { description: "Unknown registration" },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agent/identity/claim",
    tags: ["Agent auth"],
    summary: "Start the claim ceremony and mint a user code",
    description:
      "Returns a code to show the user together with the verification URL. Replaces any code " +
      "already outstanding for this registration.",
    responses: {
      200: {
        description: "Ceremony started",
        content: { "application/json": { schema: ClaimStarted } },
      },
      400: { description: "Already claimed" },
      401: { description: "Unknown or revoked credential" },
      403: { description: "Registration revoked" },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/agent-registrations",
    tags: ["Agent auth"],
    summary: "List the agent registrations acting in this organization",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Registrations",
        content: { "application/json": { schema: z.array(AgentRegistration) } },
      },
      ...ErrorResponses,
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/agent-registrations/{id}",
    tags: ["Agent auth"],
    summary: "Revoke an agent registration",
    description:
      "The row is kept so audit entries naming this agent stay legible; its credential stops " +
      "working on the next request. Closed to agent credentials.",
    request: { params: idParams },
    responses: {
      200: { description: "Revoked", content: { "application/json": { schema: Ok } } },
      ...ErrorResponses,
    },
  });
}
