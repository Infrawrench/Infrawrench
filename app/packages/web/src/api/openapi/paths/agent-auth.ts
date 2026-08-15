import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

/**
 * Agent registration and the claim ceremony.
 *
 * The `/api/agent/*` routes are deliberately part of the *public* spec even
 * though they take no session (registration, and the agent's own polling) or a
 * cookie rather than a bearer token (the human half of the claim): they are the
 * documented way an autonomous client gets credentials, and a surface an agent
 * is meant to discover cannot be one we leave out of the description of the API.
 *
 * **Both halves or neither.** The ceremony spans an agent-authed start and a
 * session-authed confirm, so describing only the agent's half publishes a flow
 * that can be begun and never finished — which is exactly what shipped first.
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

const ClaimLookupRequest = strict({
  code: z.string().openapi({ description: "The `user_code` the agent showed its user." }),
}).openapi("AgentClaimLookupRequest");

const ClaimMergeTarget = strict({
  id: Uuid,
  displayName: z.string(),
}).openapi("AgentClaimMergeTarget");

const ClaimLookup = strict({
  registrationId: Uuid,
  workspaceName: z.string(),
  trialExpiresInMs: z.number().int().nullable(),
  mergeTargets: z.array(ClaimMergeTarget).openapi({
    description:
      "Organizations this user may merge the workspace into: ones they already belong to AND " +
      "hold `accounts:write` in. A merge writes cloud credentials, so membership alone is not " +
      "enough — the confirm route enforces the same rule.",
  }),
}).openapi("AgentClaimLookup");

const ClaimRequest = strict({
  code: z.string(),
  mode: z
    .enum(["adopt", "merge"])
    .optional()
    .openapi({
      description:
        "`adopt` keeps the workspace as its own organization and stops the clock. `merge` moves " +
        "its cloud accounts into an organization you already belong to and destroys the trial. " +
        "Defaults to `adopt`.",
    }),
  targetOrganizationId: Uuid.optional().openapi({ description: "Required when `mode` is merge." }),
  moveHistory: z
    .boolean()
    .optional()
    .openapi({
      description:
        "Merge only: also re-parent the trial's metrics and cost history. Off by default — it " +
        "changes numbers the target organization may already be reporting on. Needs `costs:write`.",
    }),
}).openapi("AgentClaimRequest");

const ClaimResult = strict({
  organizationId: Uuid.openapi({ description: "The organization the agent acts in from now on." }),
  mode: z.enum(["adopt", "merge"]),
  accountsMoved: z.number().int(),
  historyMoved: z.boolean(),
}).openapi("AgentClaimResult");

const AgentRevoked = strict({
  ok: z.literal(true),
  revoked: z.boolean().openapi({
    description:
      "False when the registration was already revoked. The request still succeeds — revocation " +
      "is idempotent — but nothing changed.",
  }),
}).openapi("AgentRevoked");

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

  // The human half of the ceremony. Session-authed (no `security` override, so
  // the document default applies), and in the spec for the same reason the
  // agent half is: a ceremony described only up to the point where it needs a
  // person is a ceremony no client can be written against.
  registry.registerPath({
    method: "post",
    path: "/api/agent/claim/lookup",
    tags: ["Agent auth"],
    summary: "Resolve a user code so the claim page can show what is being claimed",
    description:
      "A POST rather than a GET with the code in the path: the code is a live bearer secret for " +
      "15 minutes, and a URL lands in history, in `Referer`, and in access logs. Rate limited " +
      "per user.",
    request: {
      body: { content: { "application/json": { schema: ClaimLookupRequest } } },
    },
    responses: {
      200: { description: "Resolved", content: { "application/json": { schema: ClaimLookup } } },
      400: { description: "Missing, malformed, or expired code" },
      401: ErrorResponses[401],
      404: { description: "The workspace no longer exists" },
      429: { description: "Too many attempts" },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agent/claim",
    tags: ["Agent auth"],
    summary: "Confirm a claim, binding the workspace to the signed-in user",
    description:
      "The code is re-resolved here rather than trusting a registration id from the lookup, so " +
      "the lookup cannot be used as an oracle. Rate limited per user.",
    request: {
      body: { content: { "application/json": { schema: ClaimRequest } } },
    },
    responses: {
      200: { description: "Claimed", content: { "application/json": { schema: ClaimResult } } },
      400: { description: "Bad code, already claimed, revoked, or a merge with no valid target" },
      401: ErrorResponses[401],
      402: { description: "The merge would put a free target organization over its plan limits" },
      403: {
        description:
          "You lack the permission the merge needs in the target organization " +
          "(`accounts:write`, plus `costs:write` when moving history).",
      },
      429: { description: "Too many attempts" },
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
      200: { description: "Revoked", content: { "application/json": { schema: AgentRevoked } } },
      ...ErrorResponses,
    },
  });
}
