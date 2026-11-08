/**
 * Break-glass access requests: `/api/org/:orgId/access-requests`, the
 * endpoint definitions.
 *
 * Asking takes `access:request`, seeing the queue `access:read`, deciding
 * `access:approve` (deliberately not `team:role:write`: approving an elevation
 * happens mid-incident, granting a role is a considered change). API keys can
 * neither ask nor decide: `API_KEY_DENY_RULES` closes the prefix's writes.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { lengthBetween, maxLength, minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Forbidden, NotFound, Unauthorized } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs, optionalRequestBody } from "../../schemas/documented";

const AccessRequestStatus = Schema.Literals(["pending", "approved", "denied", "expired"]).annotate({
  description:
    "`pending` (awaiting a decision), `approved`, `denied`, or `expired` (nobody decided in " +
    "time, or the requester withdrew it). An approved row is only *granting* permissions while " +
    "`active` is true.",
});

export const AccessRequest = Schema.Struct({
  id: Uuid,
  userId: Schema.String,
  userName: Schema.NullOr(Schema.String),
  permissions: Schema.Array(Schema.String).annotate({
    description: "The permission strings being asked for.",
  }),
  reason: Schema.String,
  durationMinutes: Schema.Int.annotate({
    description: "How long the elevation lasts once granted.",
  }),
  status: AccessRequestStatus,
  expiresAt: IsoDateTime.annotate({
    description: "When an undecided request stops being decidable.",
  }),
  decidedAt: Schema.NullOr(IsoDateTime),
  decidedByUserId: Schema.NullOr(Schema.String),
  decidedByName: Schema.NullOr(Schema.String),
  decisionNote: Schema.NullOr(Schema.String),
  grantedAt: Schema.NullOr(IsoDateTime),
  grantExpiresAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the elevation lapses.",
  }),
  revokedAt: Schema.NullOr(IsoDateTime),
  revokedByName: Schema.NullOr(Schema.String),
  active: Schema.Boolean.annotate({
    description:
      "True when this row is granting permissions right now. Evaluated, never swept; a grant " +
      "stops applying the instant it lapses.",
  }),
  createdAt: IsoDateTime,
}).annotate({ identifier: "AccessRequest" });

export const AccessRequestCatalog = Schema.Struct({
  permissions: Schema.Array(Schema.String),
  held: Schema.Array(Schema.String).annotate({
    description: "Permissions the caller already holds; asking for these changes nothing.",
  }),
  minGrantMinutes: Schema.Int,
  maxGrantMinutes: Schema.Int,
}).annotate({ identifier: "AccessRequestCatalog" });

/**
 * The create body as documented. The handler validates it against the same
 * rules plus the grant-length bounds, which live with the break-glass service.
 */
const AccessRequestCreate = Schema.Struct({
  permissions: Schema.Array(Schema.String.check(minLength(1))).check(...lengthBetween(1, 50)),
  reason: Schema.String.check(...lengthBetween(10, 2000)),
  durationMinutes: Schema.Int,
}).annotate({ identifier: "AccessRequestCreate" });

/** The decide body; validated as given, refusing unknown keys. */
export const AccessDecision = Schema.Struct({
  note: Schema.optionalKey(
    Schema.String.check(maxLength(1000)).annotate({
      description: "Shown on the request and in the audit log.",
    }),
  ),
}).annotate({ identifier: "AccessDecision" });

export class AccessDecisionForbidden extends Schema.Error<AccessDecisionForbidden>(
  "infrawrench/http/accessRequests/AccessDecisionForbidden",
)(
  {
    error: Schema.String,
    code: Schema.Literals(["self_approval", "exceeds_approver"]),
    missing: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        description: "For `exceeds_approver`: the permissions the approver does not hold.",
      }),
    ),
  },
  { httpApiStatus: 403, identifier: "AccessDecisionForbidden" },
) {}

export class AccessDecisionConflict extends Schema.Error<AccessDecisionConflict>(
  "infrawrench/http/accessRequests/AccessDecisionConflict",
)({ error: Schema.String }, { httpApiStatus: 409, identifier: "AccessDecisionConflict" }) {}

export class AccessRevokeConflict extends Schema.Error<AccessRevokeConflict>(
  "infrawrench/http/accessRequests/AccessRevokeConflict",
)({ error: Schema.String }, { httpApiStatus: 409, identifier: "AccessRevokeConflict" }) {}

export class AccessWithdrawConflict extends Schema.Error<AccessWithdrawConflict>(
  "infrawrench/http/accessRequests/AccessWithdrawConflict",
)({ error: Schema.String }, { httpApiStatus: 409, identifier: "AccessWithdrawConflict" }) {}

const RequestParams = { orgId: OrgId, requestId: Uuid } as const;

const decideEndpoint = <const Name extends "approve" | "deny">(name: Name, verb: string) =>
  HttpApiEndpoint.post(name, `/:requestId/${name}`, {
    params: RequestParams,
    payload: AccessDecision,
    success: AccessRequest,
    error: [BadRequest, Unauthorized, AccessDecisionForbidden, NotFound, AccessDecisionConflict],
  })
    .annotate(RequiredPermission, "access:approve")
    .annotate(OpenApi.Summary, `${verb} an access request`)
    .annotate(
      OpenApi.Description,
      (name === "approve"
        ? "Opens the elevation window: the requester holds the requested permissions from now " +
          "until `grantExpiresAt`, on every surface at once (HTTP, the WebSocket gateway, " +
          "chat, MCP tools). "
        : "Records the refusal. ") +
        "Two rules are enforced here and cannot be bypassed: you cannot decide your own request " +
        "(403 `self_approval`), and you cannot grant a permission you do not hold yourself (403 " +
        "`exceeds_approver`): denying something aimed higher than you is allowed. Deciding a " +
        "request that has already been decided or has timed out is a 409. Audit-logged.",
    )
    .annotate(SuccessDescription, "The decided request")
    .annotate(OpenApi.Transform, optionalRequestBody);

export class AccessRequestsGroup extends HttpApiGroup.make("accessRequests")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      // Read raw: the handler names the allowed statuses in its 400, and any
      // `mine`/`active` other than "1" means no.
      query: {
        status: Schema.optionalKey(documentedAs(AccessRequestStatus)),
        mine: Schema.optionalKey(
          documentedAs(
            Schema.Literal("1").annotate({ description: "Only the caller's own requests." }),
          ),
        ),
        active: Schema.optionalKey(
          documentedAs(
            Schema.Literal("1").annotate({
              description: "Only rows granting permissions right now.",
            }),
          ),
        ),
      },
      success: Schema.Array(AccessRequest),
      error: BadRequest,
    })
      .annotate(RequiredPermission, "access:read")
      .annotate(OpenApi.Summary, "List access requests")
      .annotate(
        OpenApi.Description,
        "The organization's break-glass requests, newest first. A `pending` listing hides rows " +
          "whose timeout has already passed, so the queue never offers a decision that would " +
          "immediately be refused.",
      )
      .annotate(SuccessDescription, "The organization's requests"),
    HttpApiEndpoint.get("catalog", "/catalog", {
      params: OrgParams,
      success: AccessRequestCatalog,
    })
      .annotate(RequiredPermission, "access:read")
      .annotate(OpenApi.Summary, "Permissions a request may ask for")
      .annotate(
        OpenApi.Description,
        "The server's permission catalog plus the subset the caller already holds and the bounds " +
          "on grant length. Served rather than hard-coded in clients so a picker cannot drift from " +
          "what the server will accept.",
      )
      .annotate(SuccessDescription, "Catalog and limits"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: AccessRequestCreate,
      success: AccessRequest.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Unauthorized],
    })
      .annotate(RequiredPermission, "access:request")
      .annotate(OpenApi.Summary, "Request elevated access")
      .annotate(
        OpenApi.Description,
        "Ask for specific permissions, for a specific number of minutes, with a reason. Rejected " +
          "with 400 when the caller's role already grants every permission asked for; that is " +
          "almost always a wrong permission string rather than a real request. Fans out to push, " +
          "Slack (with Approve/Deny buttons) and Microsoft Teams under the Pages opt-in. " +
          "Audit-logged.",
      )
      .annotate(SuccessDescription, "The created request")
      .annotate(OpenApi.Transform, optionalRequestBody),
    decideEndpoint("approve", "Approve"),
    decideEndpoint("deny", "Deny"),
    // No gate of its own: the holder may always give an elevation back, and
    // anyone else needs `access:approve`, which the handler checks.
    HttpApiEndpoint.post("revoke", "/:requestId/revoke", {
      params: RequestParams,
      success: AccessRequest,
      error: [Unauthorized, Forbidden, NotFound, AccessRevokeConflict],
    })
      .annotate(OpenApi.Summary, "End a live elevation early")
      .annotate(
        OpenApi.Description,
        "Allowed for anyone with `access:approve` and for the holder; giving back an elevation " +
          "you no longer need must never require finding an approver. Applies from the next " +
          "permission resolution; nothing is cached. Audit-logged.",
      )
      .annotate(SuccessDescription, "The revoked request"),
    HttpApiEndpoint.post("withdraw", "/:requestId/withdraw", {
      params: RequestParams,
      success: Ok,
      error: [Unauthorized, NotFound, AccessWithdrawConflict],
    })
      .annotate(RequiredPermission, "access:request")
      .annotate(OpenApi.Summary, "Withdraw your own pending request")
      .annotate(
        OpenApi.Description,
        "Its own operation rather than a self-denial, so the audit trail distinguishes 'nobody " +
          "would approve this' from 'they decided they didn't need it'. Audit-logged.",
      )
      .annotate(SuccessDescription, "Withdrawn"),
  )
  .prefix("/api/org/:orgId/access-requests")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Break-glass access") {}

export class AccessRequestsApi extends withApiDefaults(
  HttpApi.make("accessRequests").add(AccessRequestsGroup),
) {}
