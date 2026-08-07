import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime, Ok } from "../common";
import type { BuildContext } from "../context";

const AccessRequestStatus = z.enum(["pending", "approved", "denied", "expired"]).openapi({
  description:
    "`pending` (awaiting a decision), `approved`, `denied`, or `expired` (nobody decided in " +
    "time, or the requester withdrew it). An approved row is only *granting* permissions while " +
    "`active` is true.",
});

export function registerAccessRequestPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const AccessRequest = strict({
    id: Uuid,
    userId: z.string(),
    userName: z.string().nullable(),
    permissions: z.array(z.string()).describe("The permission strings being asked for."),
    reason: z.string(),
    durationMinutes: z.number().int().describe("How long the elevation lasts once granted."),
    status: AccessRequestStatus,
    expiresAt: IsoDateTime.describe("When an undecided request stops being decidable."),
    decidedAt: IsoDateTime.nullable(),
    decidedByUserId: z.string().nullable(),
    decidedByName: z.string().nullable(),
    decisionNote: z.string().nullable(),
    grantedAt: IsoDateTime.nullable(),
    grantExpiresAt: IsoDateTime.nullable().describe("When the elevation lapses."),
    revokedAt: IsoDateTime.nullable(),
    revokedByName: z.string().nullable(),
    active: z
      .boolean()
      .describe(
        "True when this row is granting permissions right now. Evaluated, never swept — a grant " +
          "stops applying the instant it lapses.",
      ),
    createdAt: IsoDateTime,
  }).openapi("AccessRequest");

  const AccessRequestCatalog = strict({
    permissions: z.array(z.string()),
    held: z
      .array(z.string())
      .describe("Permissions the caller already holds; asking for these changes nothing."),
    minGrantMinutes: z.number().int(),
    maxGrantMinutes: z.number().int(),
  }).openapi("AccessRequestCatalog");

  const AccessRequestCreate = strict({
    permissions: z.array(z.string().min(1)).min(1).max(50),
    reason: z.string().min(10).max(2000),
    durationMinutes: z.number().int(),
  }).openapi("AccessRequestCreate");

  const AccessDecision = strict({
    note: z.string().max(1000).optional().describe("Shown on the request and in the audit log."),
  }).openapi("AccessDecision");

  const AccessDecisionForbidden = strict({
    error: z.string(),
    code: z.enum(["self_approval", "exceeds_approver"]),
    missing: z
      .array(z.string())
      .optional()
      .describe("For `exceeds_approver`: the permissions the approver does not hold."),
  }).openapi("AccessDecisionForbidden");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/access-requests",
    tags: ["Break-glass access"],
    summary: "List access requests",
    description:
      "The organization's break-glass requests, newest first. A `pending` listing hides rows " +
      "whose timeout has already passed, so the queue never offers a decision that would " +
      "immediately be refused.",
    request: {
      params: OrgIdParam,
      query: strict({
        status: AccessRequestStatus.optional(),
        mine: z.enum(["1"]).optional().describe("Only the caller's own requests."),
        active: z.enum(["1"]).optional().describe("Only rows granting permissions right now."),
      }),
    },
    responses: {
      200: {
        description: "The organization's requests",
        content: { "application/json": { schema: z.array(AccessRequest) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/access-requests/catalog",
    tags: ["Break-glass access"],
    summary: "Permissions a request may ask for",
    description:
      "The server's permission catalog plus the subset the caller already holds and the bounds " +
      "on grant length. Served rather than hard-coded in clients so a picker cannot drift from " +
      "what the server will accept.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Catalog and limits",
        content: { "application/json": { schema: AccessRequestCatalog } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/access-requests",
    tags: ["Break-glass access"],
    summary: "Request elevated access",
    description:
      "Ask for specific permissions, for a specific number of minutes, with a reason. Rejected " +
      "with 400 when the caller's role already grants every permission asked for — that is " +
      "almost always a wrong permission string rather than a real request. Fans out to push, " +
      "Slack (with Approve/Deny buttons) and Microsoft Teams under the Pages opt-in. " +
      "Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: AccessRequestCreate } } },
    },
    responses: {
      201: {
        description: "The created request",
        content: { "application/json": { schema: AccessRequest } },
      },
      400: ErrorResponses[400],
    },
  });

  for (const [op, verb] of [
    ["approve", "Approve"],
    ["deny", "Deny"],
  ] as const) {
    registry.registerPath({
      method: "post",
      path: `/api/org/{orgId}/access-requests/{requestId}/${op}`,
      tags: ["Break-glass access"],
      summary: `${verb} an access request`,
      description:
        (op === "approve"
          ? "Opens the elevation window: the requester holds the requested permissions from now " +
            "until `grantExpiresAt`, on every surface at once (HTTP, the WebSocket gateway, " +
            "chat, MCP tools). "
          : "Records the refusal. ") +
        "Two rules are enforced here and cannot be bypassed: you cannot decide your own request " +
        "(403 `self_approval`), and you cannot grant a permission you do not hold yourself (403 " +
        "`exceeds_approver`) — denying something aimed higher than you is allowed. Deciding a " +
        "request that has already been decided or has timed out is a 409. Audit-logged.",
      request: {
        params: OrgIdParam.extend({ requestId: Uuid }),
        body: { content: { "application/json": { schema: AccessDecision } } },
      },
      responses: {
        200: {
          description: "The decided request",
          content: { "application/json": { schema: AccessRequest } },
        },
        400: ErrorResponses[400],
        403: {
          description: "Self-approval, or granting beyond the approver's own permissions",
          content: { "application/json": { schema: AccessDecisionForbidden } },
        },
        404: ErrorResponses[404],
        409: {
          description: "Already decided, or the request timed out",
          content: {
            "application/json": {
              schema: strict({ error: z.string() }).openapi("AccessDecisionConflict"),
            },
          },
        },
      },
    });
  }

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/access-requests/{requestId}/revoke",
    tags: ["Break-glass access"],
    summary: "End a live elevation early",
    description:
      "Allowed for anyone with `access:approve` and for the holder — giving back an elevation " +
      "you no longer need must never require finding an approver. Applies from the next " +
      "permission resolution; nothing is cached. Audit-logged.",
    request: { params: OrgIdParam.extend({ requestId: Uuid }) },
    responses: {
      200: {
        description: "The revoked request",
        content: { "application/json": { schema: AccessRequest } },
      },
      404: ErrorResponses[404],
      409: {
        description: "The grant is not active",
        content: {
          "application/json": {
            schema: strict({ error: z.string() }).openapi("AccessRevokeConflict"),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/access-requests/{requestId}/withdraw",
    tags: ["Break-glass access"],
    summary: "Withdraw your own pending request",
    description:
      "Its own operation rather than a self-denial, so the audit trail distinguishes 'nobody " +
      "would approve this' from 'they decided they didn't need it'. Audit-logged.",
    request: { params: OrgIdParam.extend({ requestId: Uuid }) },
    responses: {
      200: { description: "Withdrawn", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
      409: {
        description: "Already decided or expired",
        content: {
          "application/json": {
            schema: strict({ error: z.string() }).openapi("AccessWithdrawConflict"),
          },
        },
      },
    },
  });
}
