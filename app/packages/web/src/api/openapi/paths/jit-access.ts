import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime, Ok } from "../common";
import type { BuildContext } from "../context";

const TAG = "Just-in-time access";

const JIT_STATUSES = [
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
] as const;

export function registerJitAccessPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const JitRequestStatus = z.enum(JIT_STATUSES).openapi("JitRequestStatus", {
    description:
      "`pending` (awaiting an approver) or `timed_out`; `denied` / `cancelled`; `granting` (the " +
      "provider call is in flight), `active`, `grant_failed`; `revoking` then `revoked` when the " +
      "window ends; `revoke_failed` while a failed revoke is retried.",
  });

  const JitProviderLabels = strict({
    scopeLabel: z.string(),
    roleLabel: z.string(),
    principalLabel: z.string(),
    description: z.string().optional(),
    providerEnforcedExpiry: z
      .boolean()
      .describe(
        "True when the provider itself ends the access on time (a time-bound IAM Condition).",
      ),
    principalPicker: z.boolean(),
  }).openapi("JitProviderLabels");

  const JitPolicyTarget = strict({
    scopeId: z
      .string()
      .min(1)
      .max(1224)
      .describe("Provider id of the scope (account, project, namespace)."),
    scopeName: z.string().max(300),
    roleId: z
      .string()
      .min(1)
      .max(1224)
      .describe("Provider id of the role (permission set ARN, role name)."),
    roleName: z.string().max(300),
  }).openapi("JitPolicyTarget");

  const idList = z.array(z.string()).max(200);

  const JitPolicy = strict({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    enabled: z.boolean(),
    accountId: z.string(),
    accountName: z.string().nullable(),
    pluginId: z.string(),
    targets: z.array(JitPolicyTarget),
    maxDurationMinutes: z.number().int().min(5).max(720),
    defaultDurationMinutes: z.number().int().min(5).max(720),
    requestTimeoutMinutes: z.number().int().min(5).max(1440),
    requesterUserIds: idList.describe(
      "Who may ask. Empty (with requesterRoleIds) means any member with access:request.",
    ),
    requesterRoleIds: idList,
    approverUserIds: idList,
    approverRoleIds: idList,
    approverOnCallScheduleIds: idList.describe(
      "Rotations whose current on-call person may approve.",
    ),
    allowSelfApprovalDuringIncident: z.boolean(),
    requireReason: z.boolean(),
    requireTicket: z.boolean(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    labels: JitProviderLabels.nullable().optional(),
    canRequest: z
      .boolean()
      .optional()
      .describe("Caller-relative: whether the caller may ask under this policy."),
  }).openapi("JitPolicy");

  const JitPolicyInput = strict({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).nullable().optional(),
    enabled: z.boolean().optional(),
    accountId: z.string().min(1),
    targets: z.array(JitPolicyTarget).min(1).max(50),
    maxDurationMinutes: z.number().int().min(5).max(720),
    defaultDurationMinutes: z.number().int().min(5).max(720).optional(),
    requestTimeoutMinutes: z.number().int().min(5).max(1440).optional(),
    requesterUserIds: idList.optional(),
    requesterRoleIds: idList.optional(),
    approverUserIds: idList.optional(),
    approverRoleIds: idList.optional(),
    approverOnCallScheduleIds: idList.optional(),
    allowSelfApprovalDuringIncident: z.boolean().optional(),
    requireReason: z.boolean().optional(),
    requireTicket: z.boolean().optional(),
  }).openapi("JitPolicyInput");

  const JitAccessRequest = strict({
    id: z.string(),
    policyId: z.string().nullable(),
    policyName: z.string().nullable(),
    accountId: z.string(),
    accountName: z.string().nullable(),
    pluginId: z.string(),
    scopeId: z.string(),
    scopeName: z.string(),
    roleId: z.string(),
    roleName: z.string(),
    userId: z.string(),
    userName: z.string().nullable(),
    principalId: z.string(),
    principalName: z.string(),
    principalKind: z.enum(["user", "group"]),
    principalMatched: z
      .boolean()
      .describe("True when the principal was resolved from the requester's own email."),
    reason: z.string(),
    ticket: z.string().nullable(),
    durationMinutes: z.number().int(),
    status: JitRequestStatus,
    requestExpiresAt: IsoDateTime,
    decidedAt: IsoDateTime.nullable(),
    decidedByUserId: z.string().nullable(),
    decidedByName: z.string().nullable(),
    decisionNote: z.string().nullable(),
    selfApproved: z.boolean(),
    incidentId: z.string().nullable(),
    grantedAt: IsoDateTime.nullable(),
    grantExpiresAt: IsoDateTime.nullable(),
    preexisting: z
      .boolean()
      .describe("The principal already held the role; nothing was created and nothing is removed."),
    extendedMinutes: z.number().int(),
    endedAt: IsoDateTime.nullable(),
    endedByName: z.string().nullable(),
    endReason: z.enum(["expired", "revoked", "grant_failed"]).nullable(),
    lastError: z.string().nullable(),
    revokeAttempts: z.number().int(),
    createdAt: IsoDateTime,
    canDecide: z.boolean(),
    canCancel: z.boolean(),
    canExtend: z.boolean(),
    canRevoke: z.boolean(),
  }).openapi("JitAccessRequest");

  const JitAccessAccount = strict({
    id: z.string(),
    displayName: z.string(),
    pluginId: z.string(),
    labels: JitProviderLabels,
  }).openapi("JitAccessAccount");

  const JitPickerOption = strict({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    privileged: z.boolean().optional(),
  }).openapi("JitPickerOption");

  const JitPrincipalOption = strict({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["user", "group"]),
    email: z.string().nullable().optional(),
  }).openapi("JitPrincipalOption");

  const JitPrincipalResolution = strict({
    principal: JitPrincipalOption.nullable(),
    canPick: z.boolean(),
    labels: JitProviderLabels,
  }).openapi("JitPrincipalResolution");

  const JitCreateRequest = strict({
    policyId: z.string(),
    scopeId: z.string(),
    roleId: z.string(),
    durationMinutes: z.number().int().min(5).max(720),
    reason: z.string().max(2000),
    ticket: z.string().max(200).optional(),
    principalId: z
      .string()
      .optional()
      .describe("Only when the caller's email does not resolve; must be one the provider lists."),
  }).openapi("JitCreateRequest");

  const JitError = strict({
    error: z.string(),
    code: z.string().optional(),
  }).openapi("JitError");

  const PolicyIdParam = OrgIdParam.extend({ policyId: z.string() });
  const RequestIdParam = OrgIdParam.extend({ requestId: z.string() });
  const AccountIdParam = OrgIdParam.extend({ accountId: z.string() });
  const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
    description,
    content: { "application/json": { schema } },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jit-access/accounts",
    tags: [TAG],
    summary: "Accounts that can grant just-in-time access",
    description: "Connected accounts whose provider plugin declares the just-in-time capability.",
    request: { params: OrgIdParam },
    responses: { 200: json(z.array(JitAccessAccount), "Accounts") },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jit-access/accounts/{accountId}/scopes",
    tags: [TAG],
    summary: "Scopes on an account (picker)",
    description:
      "The places a role can be granted (AWS accounts, GCP projects, namespaces), read from the provider.",
    request: { params: AccountIdParam },
    responses: {
      200: json(z.array(JitPickerOption), "Scopes"),
      502: json(JitError, "Provider error"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jit-access/accounts/{accountId}/roles",
    tags: [TAG],
    summary: "Grantable roles in a scope (picker)",
    request: { params: AccountIdParam, query: strict({ scopeId: z.string() }) },
    responses: {
      200: json(z.array(JitPickerOption), "Roles"),
      502: json(JitError, "Provider error"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jit-access/policies",
    tags: [TAG],
    summary: "List just-in-time access policies",
    request: { params: OrgIdParam },
    responses: { 200: json(z.array(JitPolicy), "Policies") },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/jit-access/policies",
    tags: [TAG],
    summary: "Create a policy",
    description:
      "Audit-logged. At least one approver (member, role or on-call rotation) is required.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: JitPolicyInput } } },
    },
    responses: { 201: json(JitPolicy, "The created policy"), 400: ErrorResponses[400] },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jit-access/policies/{policyId}",
    tags: [TAG],
    summary: "Get a policy",
    request: { params: PolicyIdParam },
    responses: { 200: json(JitPolicy, "The policy"), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/jit-access/policies/{policyId}",
    tags: [TAG],
    summary: "Replace a policy",
    description:
      "Live grants keep their window; pending requests are decided against the new approver set.",
    request: {
      params: PolicyIdParam,
      body: { content: { "application/json": { schema: JitPolicyInput } } },
    },
    responses: {
      200: json(JitPolicy, "The policy"),
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/jit-access/policies/{policyId}",
    tags: [TAG],
    summary: "Delete a policy",
    description:
      "Grants the policy produced still end on time; its pending requests have no approvers and time out.",
    request: { params: PolicyIdParam },
    responses: { 200: json(Ok, "Deleted"), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jit-access/policies/{policyId}/principal",
    tags: [TAG],
    summary: "Resolve the caller's provider principal",
    description: "Who the grant would go to, matched by the caller's email in the provider.",
    request: { params: PolicyIdParam },
    responses: {
      200: json(JitPrincipalResolution, "Resolution"),
      403: json(JitError, "Not a requester"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jit-access/policies/{policyId}/principals",
    tags: [TAG],
    summary: "Principals the caller may pick",
    request: { params: PolicyIdParam, query: strict({ q: z.string().optional() }) },
    responses: { 200: json(z.array(JitPrincipalOption), "Principals") },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jit-access/requests",
    tags: [TAG],
    summary: "List just-in-time access requests",
    description: "Newest first, with caller-relative action flags.",
    request: {
      params: OrgIdParam,
      query: strict({
        status: JitRequestStatus.optional(),
        mine: z.enum(["1"]).optional(),
        holding: z
          .enum(["1"])
          .optional()
          .describe("Only rows that may be holding access upstream."),
      }),
    },
    responses: { 200: json(z.array(JitAccessRequest), "Requests"), 400: ErrorResponses[400] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/jit-access/requests",
    tags: [TAG],
    summary: "Request just-in-time access",
    description:
      "Ask for one of a policy's scope and role pairs for a bounded window. Approvers are notified " +
      "over push, Slack (with Approve/Deny buttons) and Microsoft Teams. Not available to API keys.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: JitCreateRequest } } },
    },
    responses: {
      201: json(JitAccessRequest, "The created request"),
      400: json(JitError, "Invalid"),
      403: json(JitError, "Not a requester under this policy"),
      409: json(JitError, "A pending or active request already covers this"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/jit-access/requests/{requestId}",
    tags: [TAG],
    summary: "Get a request",
    request: { params: RequestIdParam },
    responses: { 200: json(JitAccessRequest, "The request"), 404: ErrorResponses[404] },
  });

  const actions: Array<[string, string, string]> = [
    [
      "approve",
      "Approve a request",
      "The caller must be in the policy's approver set at this moment. On approval the provider " +
        "grant is made; the response may still read `granting` when it completes in the background.",
    ],
    ["deny", "Deny a request", "The caller must be in the policy's approver set."],
    ["cancel", "Cancel your pending request", "Requester only."],
    [
      "revoke",
      "End a grant early",
      "Allowed for the holder, an approver, or a member with org:settings:write.",
    ],
  ];
  for (const [op, summary, description] of actions) {
    registry.registerPath({
      method: "post",
      path: `/api/org/{orgId}/jit-access/requests/{requestId}/${op}`,
      tags: [TAG],
      summary,
      description: `${description} Audit-logged. Not available to API keys.`,
      request: {
        params: RequestIdParam,
        body: {
          content: {
            "application/json": { schema: strict({ note: z.string().max(1000).optional() }) },
          },
        },
      },
      responses: {
        200: json(JitAccessRequest, "The request"),
        403: json(JitError, "Not allowed"),
        404: ErrorResponses[404],
        409: json(JitError, "Already decided, timed out, or not in a state for this"),
      },
    });
  }

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/jit-access/requests/{requestId}/extend",
    tags: [TAG],
    summary: "Extend an active grant",
    description:
      "Approvers only, within the policy maximum for the whole window. A provider-enforced " +
      "expiry is moved upstream first. Audit-logged. Not available to API keys.",
    request: {
      params: RequestIdParam,
      body: {
        content: {
          "application/json": { schema: strict({ minutes: z.number().int().min(1).max(720) }) },
        },
      },
    },
    responses: {
      200: json(JitAccessRequest, "The request"),
      400: json(JitError, "Beyond the policy maximum"),
      403: json(JitError, "Not an approver"),
      409: json(JitError, "Not active"),
    },
  });
}
