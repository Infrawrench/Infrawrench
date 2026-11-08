/**
 * Just-in-time access: `/api/org/:orgId/jit-access`, the endpoint definitions.
 *
 * Time-boxed **provider** roles under admin-written policies; not break-glass
 * (`/access-requests`), which elevates Infrawrench permissions. Route
 * permissions are the floor, not the rule: who may *decide* is the policy's
 * approver set, which the service evaluates at decision time. API keys cannot
 * decide, extend or revoke (`API_KEY_DENY_RULES`).
 *
 * The request bodies are the validators the routes always used (Zod's
 * `.strict()` objects, translated), so the documented constraints are the
 * enforced ones.
 */
import { Schema, SchemaTransformation } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { JIT_LIMITS } from "@infrawrench/client-core";
import { lengthBetween, maxLength, minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound, Unauthorized } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgParams } from "../../schemas/common";
import { documentedAs, optionalRequestBody, requiredQuery } from "../../schemas/documented";

const jitErrorFields = { error: Schema.String, code: Schema.optionalKey(Schema.String) };
const jitError = (status: number) => ({ httpApiStatus: status, identifier: "JitError" }) as const;

/** The service's refusals, `{ error, code? }` with the status it chose. */
export class JitBadRequest extends Schema.Error<JitBadRequest>("infrawrench/http/jit/BadRequest")(
  jitErrorFields,
  jitError(400),
) {}
export class JitForbidden extends Schema.Error<JitForbidden>("infrawrench/http/jit/Forbidden")(
  jitErrorFields,
  jitError(403),
) {}
export class JitConflict extends Schema.Error<JitConflict>("infrawrench/http/jit/Conflict")(
  jitErrorFields,
  jitError(409),
) {}
export class JitBadGateway extends Schema.Error<JitBadGateway>("infrawrench/http/jit/BadGateway")(
  jitErrorFields,
  jitError(502),
) {}

const JitRequestStatus = Schema.Literals([
  "pending",
  "timed_out",
  "denied",
  "cancelled",
  "granting",
  "active",
  "grant_failed",
  "revoking",
  "revoked",
  "revoke_failed",
]).annotate({
  identifier: "JitRequestStatus",
  description:
    "`pending` (awaiting an approver) or `timed_out`; `denied` / `cancelled`; `granting` (the " +
    "provider call is in flight), `active`, `grant_failed`; `revoking` then `revoked` when the " +
    "window ends; `revoke_failed` while a failed revoke is retried.",
});

const JitProviderLabels = Schema.Struct({
  scopeLabel: Schema.String,
  roleLabel: Schema.String,
  principalLabel: Schema.String,
  description: Schema.optionalKey(Schema.String),
  providerEnforcedExpiry: Schema.Boolean.annotate({
    description:
      "True when the provider itself ends the access on time (a time-bound IAM Condition).",
  }),
  principalPicker: Schema.Boolean,
}).annotate({ identifier: "JitProviderLabels" });

const JitPolicyTarget = Schema.Struct({
  scopeId: Schema.String.check(...lengthBetween(1, 1224)).annotate({
    description: "Provider id of the scope (account, project, namespace).",
  }),
  scopeName: Schema.String.check(maxLength(300)),
  roleId: Schema.String.check(...lengthBetween(1, 1224)).annotate({
    description: "Provider id of the role (permission set ARN, role name).",
  }),
  roleName: Schema.String.check(maxLength(300)),
}).annotate({ identifier: "JitPolicyTarget" });

const IdList = Schema.Array(Schema.String).check(maxLength(200));
const durationMinutes = () =>
  Schema.Int.check(
    Schema.isBetween({
      minimum: JIT_LIMITS.minDurationMinutes,
      maximum: JIT_LIMITS.maxDurationMinutes,
    }),
  );
const timeoutMinutes = () =>
  Schema.Int.check(
    Schema.isBetween({
      minimum: JIT_LIMITS.minTimeoutMinutes,
      maximum: JIT_LIMITS.maxTimeoutMinutes,
    }),
  );

export const JitPolicy = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  accountId: Schema.String,
  accountName: Schema.NullOr(Schema.String),
  pluginId: Schema.String,
  targets: Schema.Array(JitPolicyTarget),
  maxDurationMinutes: durationMinutes(),
  defaultDurationMinutes: durationMinutes(),
  requestTimeoutMinutes: timeoutMinutes(),
  requesterUserIds: IdList.annotate({
    description: "Who may ask. Empty (with requesterRoleIds) means any member with access:request.",
  }),
  requesterRoleIds: IdList,
  approverUserIds: IdList,
  approverRoleIds: IdList,
  approverOnCallScheduleIds: IdList.annotate({
    description: "Rotations whose current on-call person may approve.",
  }),
  allowSelfApprovalDuringIncident: Schema.Boolean,
  requireReason: Schema.Boolean,
  requireTicket: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  labels: Schema.optionalKey(Schema.NullOr(JitProviderLabels)),
  canRequest: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Caller-relative: whether the caller may ask under this policy.",
    }),
  ),
}).annotate({ identifier: "JitPolicy" });

/**
 * The policy name, trimmed before its length is checked (Zod's
 * `.trim().min(1).max(120)`). The bounds apply to the trimmed value, so the
 * wire side states them for the document only.
 */
const PolicyName = Schema.String.check(
  Schema.makeFilter(() => true, {
    toJsonSchema: () => ({ minLength: 1, maxLength: JIT_LIMITS.maxNameLength }),
  }),
).pipe(
  Schema.decodeTo(
    Schema.String.check(...lengthBetween(1, JIT_LIMITS.maxNameLength)),
    SchemaTransformation.trim(),
  ),
);

/** Ids of members, roles or rotations: each non-empty and bounded, at most 200. */
const IdListInput = Schema.optionalKey(
  Schema.mutable(Schema.Array(Schema.String.check(...lengthBetween(1, 200)))).check(maxLength(200)),
);

export const JitPolicyInput = Schema.Struct({
  name: PolicyName,
  description: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(JIT_LIMITS.maxDescriptionLength))),
  ),
  enabled: Schema.optionalKey(Schema.Boolean),
  accountId: Schema.String.check(minLength(1)),
  targets: Schema.mutable(Schema.Array(JitPolicyTarget)).check(
    ...lengthBetween(1, JIT_LIMITS.maxTargets),
  ),
  maxDurationMinutes: durationMinutes(),
  defaultDurationMinutes: Schema.optionalKey(durationMinutes()),
  requestTimeoutMinutes: Schema.optionalKey(timeoutMinutes()),
  requesterUserIds: IdListInput,
  requesterRoleIds: IdListInput,
  approverUserIds: IdListInput,
  approverRoleIds: IdListInput,
  approverOnCallScheduleIds: IdListInput,
  allowSelfApprovalDuringIncident: Schema.optionalKey(Schema.Boolean),
  requireReason: Schema.optionalKey(Schema.Boolean),
  requireTicket: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "JitPolicyInput" });

export const JitAccessRequest = Schema.Struct({
  id: Schema.String,
  policyId: Schema.NullOr(Schema.String),
  policyName: Schema.NullOr(Schema.String),
  accountId: Schema.String,
  accountName: Schema.NullOr(Schema.String),
  pluginId: Schema.String,
  scopeId: Schema.String,
  scopeName: Schema.String,
  roleId: Schema.String,
  roleName: Schema.String,
  userId: Schema.String,
  userName: Schema.NullOr(Schema.String),
  principalId: Schema.String,
  principalName: Schema.String,
  principalKind: Schema.Literals(["user", "group"]),
  principalMatched: Schema.Boolean.annotate({
    description: "True when the principal was resolved from the requester's own email.",
  }),
  reason: Schema.String,
  ticket: Schema.NullOr(Schema.String),
  durationMinutes: Schema.Int,
  status: JitRequestStatus,
  requestExpiresAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  decidedByUserId: Schema.NullOr(Schema.String),
  decidedByName: Schema.NullOr(Schema.String),
  decisionNote: Schema.NullOr(Schema.String),
  selfApproved: Schema.Boolean,
  incidentId: Schema.NullOr(Schema.String),
  grantedAt: Schema.NullOr(IsoDateTime),
  grantExpiresAt: Schema.NullOr(IsoDateTime),
  preexisting: Schema.Boolean.annotate({
    description: "The principal already held the role; nothing was created and nothing is removed.",
  }),
  extendedMinutes: Schema.Int,
  endedAt: Schema.NullOr(IsoDateTime),
  endedByName: Schema.NullOr(Schema.String),
  endReason: Schema.NullOr(Schema.Literals(["expired", "revoked", "grant_failed"])),
  lastError: Schema.NullOr(Schema.String),
  revokeAttempts: Schema.Int,
  createdAt: IsoDateTime,
  canDecide: Schema.Boolean,
  canCancel: Schema.Boolean,
  canExtend: Schema.Boolean,
  canRevoke: Schema.Boolean,
}).annotate({ identifier: "JitAccessRequest" });

export const JitAccessAccount = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  pluginId: Schema.String,
  labels: JitProviderLabels,
}).annotate({ identifier: "JitAccessAccount" });

export const JitPickerOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  privileged: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "JitPickerOption" });

export const JitPrincipalOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["user", "group"]),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "JitPrincipalOption" });

export const JitPrincipalResolution = Schema.Struct({
  principal: Schema.NullOr(JitPrincipalOption),
  canPick: Schema.Boolean,
  labels: JitProviderLabels,
}).annotate({ identifier: "JitPrincipalResolution" });

export const JitCreateRequest = Schema.Struct({
  policyId: Schema.String.check(minLength(1)),
  scopeId: Schema.String.check(...lengthBetween(1, 1224)),
  roleId: Schema.String.check(...lengthBetween(1, 1224)),
  durationMinutes: durationMinutes(),
  reason: Schema.String.check(maxLength(JIT_LIMITS.maxReasonLength)),
  ticket: Schema.optionalKey(Schema.String.check(maxLength(JIT_LIMITS.maxTicketLength))),
  principalId: Schema.optionalKey(
    Schema.String.check(...lengthBetween(1, 500)).annotate({
      description: "Only when the caller's email does not resolve; must be one the provider lists.",
    }),
  ),
}).annotate({ identifier: "JitCreateRequest" });

export const JitNote = Schema.Struct({
  note: Schema.optionalKey(Schema.String.check(maxLength(1000))),
});
export const JitExtend = Schema.Struct({
  minutes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: JIT_LIMITS.maxDurationMinutes }),
  ),
});

const PolicyParams = { orgId: OrgId, policyId: Schema.String } as const;
const RequestParams = { orgId: OrgId, requestId: Schema.String } as const;
const AccountParams = { orgId: OrgId, accountId: Schema.String } as const;

const requestAction = <const Name extends "approve" | "deny" | "cancel" | "revoke">(
  name: Name,
  summary: string,
  description: string,
) =>
  HttpApiEndpoint.post(name, `/requests/:requestId/${name}`, {
    params: RequestParams,
    payload: JitNote,
    success: JitAccessRequest,
    error: [BadRequest, Unauthorized, JitForbidden, NotFound, JitConflict],
  })
    .annotate(OpenApi.Summary, summary)
    .annotate(OpenApi.Description, `${description} Audit-logged. Not available to API keys.`)
    .annotate(SuccessDescription, "The request")
    .annotate(OpenApi.Transform, optionalRequestBody);

export class JitAccessGroup extends HttpApiGroup.make("jitAccess")
  .add(
    HttpApiEndpoint.get("accounts", "/accounts", {
      params: OrgParams,
      success: Schema.Array(JitAccessAccount),
    })
      .annotate(RequiredPermission, "access:read")
      .annotate(OpenApi.Summary, "Accounts that can grant just-in-time access")
      .annotate(
        OpenApi.Description,
        "Connected accounts whose provider plugin declares the just-in-time capability.",
      )
      .annotate(SuccessDescription, "Accounts"),
    HttpApiEndpoint.get("scopes", "/accounts/:accountId/scopes", {
      params: AccountParams,
      success: Schema.Array(JitPickerOption),
      error: JitBadGateway,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Scopes on an account (picker)")
      .annotate(
        OpenApi.Description,
        "The places a role can be granted (AWS accounts, GCP projects, namespaces), read from the provider.",
      )
      .annotate(SuccessDescription, "Scopes"),
    HttpApiEndpoint.get("roles", "/accounts/:accountId/roles", {
      params: AccountParams,
      // Read raw so a missing one is the handler's "scopeId is required".
      query: { scopeId: Schema.optionalKey(documentedAs(Schema.String)) },
      success: Schema.Array(JitPickerOption),
      error: [BadRequest, JitBadGateway],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Grantable roles in a scope (picker)")
      .annotate(SuccessDescription, "Roles")
      .annotate(OpenApi.Transform, requiredQuery(["scopeId"])),
    HttpApiEndpoint.get("listPolicies", "/policies", {
      params: OrgParams,
      success: Schema.Array(JitPolicy),
    })
      .annotate(RequiredPermission, "access:read")
      .annotate(OpenApi.Summary, "List just-in-time access policies")
      .annotate(SuccessDescription, "Policies"),
    HttpApiEndpoint.post("createPolicy", "/policies", {
      params: OrgParams,
      payload: JitPolicyInput,
      success: JitPolicy.pipe(HttpApiSchema.status(201)),
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create a policy")
      .annotate(
        OpenApi.Description,
        "Audit-logged. At least one approver (member, role or on-call rotation) is required.",
      )
      .annotate(SuccessDescription, "The created policy")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("getPolicy", "/policies/:policyId", {
      params: PolicyParams,
      success: JitPolicy,
      error: NotFound,
    })
      .annotate(RequiredPermission, "access:read")
      .annotate(OpenApi.Summary, "Get a policy")
      .annotate(SuccessDescription, "The policy"),
    HttpApiEndpoint.put("replacePolicy", "/policies/:policyId", {
      params: PolicyParams,
      payload: JitPolicyInput,
      success: JitPolicy,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Replace a policy")
      .annotate(
        OpenApi.Description,
        "Live grants keep their window; pending requests are decided against the new approver set.",
      )
      .annotate(SuccessDescription, "The policy")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("deletePolicy", "/policies/:policyId", {
      params: PolicyParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete a policy")
      .annotate(
        OpenApi.Description,
        "Grants the policy produced still end on time; its pending requests have no approvers and time out.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("principal", "/policies/:policyId/principal", {
      params: PolicyParams,
      success: JitPrincipalResolution,
      error: [Unauthorized, JitForbidden],
    })
      .annotate(RequiredPermission, "access:request")
      .annotate(OpenApi.Summary, "Resolve the caller's provider principal")
      .annotate(
        OpenApi.Description,
        "Who the grant would go to, matched by the caller's email in the provider.",
      )
      .annotate(SuccessDescription, "Resolution"),
    HttpApiEndpoint.get("principals", "/policies/:policyId/principals", {
      params: PolicyParams,
      query: { q: Schema.optionalKey(documentedAs(Schema.String)) },
      success: Schema.Array(JitPrincipalOption),
      error: Unauthorized,
    })
      .annotate(RequiredPermission, "access:request")
      .annotate(OpenApi.Summary, "Principals the caller may pick")
      .annotate(SuccessDescription, "Principals"),
    HttpApiEndpoint.get("listRequests", "/requests", {
      params: OrgParams,
      // Read raw: the handler names the allowed statuses in its 400, and any
      // `mine`/`holding` other than "1" means no.
      query: {
        status: Schema.optionalKey(documentedAs(JitRequestStatus)),
        mine: Schema.optionalKey(documentedAs(Schema.Literal("1"))),
        holding: Schema.optionalKey(
          documentedAs(
            Schema.Literal("1").annotate({
              description: "Only rows that may be holding access upstream.",
            }),
          ),
        ),
      },
      success: Schema.Array(JitAccessRequest),
      error: [BadRequest, Unauthorized],
    })
      .annotate(RequiredPermission, "access:read")
      .annotate(OpenApi.Summary, "List just-in-time access requests")
      .annotate(OpenApi.Description, "Newest first, with caller-relative action flags.")
      .annotate(SuccessDescription, "Requests"),
    HttpApiEndpoint.post("createRequest", "/requests", {
      params: OrgParams,
      payload: JitCreateRequest,
      success: JitAccessRequest.pipe(HttpApiSchema.status(201)),
      error: [JitBadRequest, Unauthorized, JitForbidden, JitConflict],
    })
      .annotate(RequiredPermission, "access:request")
      .annotate(OpenApi.Summary, "Request just-in-time access")
      .annotate(
        OpenApi.Description,
        "Ask for one of a policy's scope and role pairs for a bounded window. Approvers are notified " +
          "over push, Slack (with Approve/Deny buttons) and Microsoft Teams. Not available to API keys.",
      )
      .annotate(SuccessDescription, "The created request")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("getRequest", "/requests/:requestId", {
      params: RequestParams,
      success: JitAccessRequest,
      error: [Unauthorized, NotFound],
    })
      .annotate(RequiredPermission, "access:read")
      .annotate(OpenApi.Summary, "Get a request")
      .annotate(SuccessDescription, "The request"),
    // Deciding is gated on `access:read` only: who may decide is the policy's
    // approver set, which the service checks.
    requestAction(
      "approve",
      "Approve a request",
      "The caller must be in the policy's approver set at this moment. On approval the provider " +
        "grant is made; the response may still read `granting` when it completes in the background.",
    ).annotate(RequiredPermission, "access:read"),
    requestAction(
      "deny",
      "Deny a request",
      "The caller must be in the policy's approver set.",
    ).annotate(RequiredPermission, "access:read"),
    requestAction("cancel", "Cancel your pending request", "Requester only.").annotate(
      RequiredPermission,
      "access:request",
    ),
    // No gate: the holder, an approver or `org:settings:write` may revoke,
    // which depends on who is asking; the service owns the check.
    requestAction(
      "revoke",
      "End a grant early",
      "Allowed for the holder, an approver, or a member with org:settings:write.",
    ),
    HttpApiEndpoint.post("extend", "/requests/:requestId/extend", {
      params: RequestParams,
      payload: JitExtend,
      success: JitAccessRequest,
      error: [JitBadRequest, Unauthorized, JitForbidden, JitConflict],
    })
      .annotate(RequiredPermission, "access:read")
      .annotate(OpenApi.Summary, "Extend an active grant")
      .annotate(
        OpenApi.Description,
        "Approvers only, within the policy maximum for the whole window. A provider-enforced " +
          "expiry is moved upstream first. Audit-logged. Not available to API keys.",
      )
      .annotate(SuccessDescription, "The request")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/jit-access")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Just-in-time access") {}

export class JitAccessApi extends withApiDefaults(HttpApi.make("jitAccess").add(JitAccessGroup)) {}
