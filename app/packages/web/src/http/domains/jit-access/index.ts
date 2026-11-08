/**
 * Just-in-time access: `/api/org/:orgId/jit-access`, the handlers.
 *
 * The service owns every audit row of a request's life (so the Slack button
 * and this route record the same thing) and every decision check; the
 * handlers resolve the caller, validate the body and pass the service's
 * refusal through with the status and `code` it chose. Policy writes are
 * audited here. Mutations call plugin code, so the prefix is on the gateway
 * (`MUTATIONS_ON_GATEWAY`).
 */
import { Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  JitAccessError,
  cancelJitRequest,
  createJitPolicy,
  createJitRequest,
  decideJitRequest,
  deleteJitPolicy,
  extendJitRequest,
  getJitPolicy,
  getJitRequest,
  listJitAccounts,
  listJitPolicies,
  listJitPrincipalsForPolicy,
  listJitRequests,
  listJitRoleOptions,
  listJitScopeOptions,
  loadJitCaller,
  resolveJitPrincipalForCaller,
  revokeJitRequest,
  updateJitPolicy,
} from "@infrawrench/server-core/jit-access/service";
import { JIT_REQUEST_STATUSES, type JitRequestStatus } from "@infrawrench/client-core";
import {
  badRequest,
  JitAccessAccount,
  JitAccessApi,
  JitAccessRequest,
  JitBadRequest,
  JitCreateRequest,
  JitExtend,
  JitNote,
  JitPickerOption,
  JitPolicy,
  JitPolicyInput,
  JitPrincipalOption,
  JitPrincipalResolution,
  notFound,
  ok,
  Unauthorized,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { HttpFailure } from "../../errors";
import { decodeFirstIssue, readJsonOr } from "../../request-body";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/**
 * Call the service, answering its refusal with the status and body it chose:
 * `{ error, code? }`. The status varies per refusal, so it travels as an
 * already-shaped failure rather than one declared class per status.
 */
const service = <A>(fn: () => PromiseLike<A>) =>
  legacy(() =>
    Promise.resolve(fn()).catch((err: unknown) => {
      if (err instanceof JitAccessError) {
        throw new HttpFailure(err.status, {
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
        });
      }
      throw err;
    }),
  );

/** Who is calling, resolved once per request; null for a caller with no user. */
const caller = Effect.gen(function* () {
  const { organizationId, session, permissions } = yield* OrgPrincipal;
  const userId: string | undefined = session.userId;
  if (!userId) return null;
  return yield* legacy(() => loadJitCaller(organizationId, userId, permissions));
});

const requireCaller = Effect.gen(function* () {
  const who = yield* caller;
  if (!who) return yield* new Unauthorized({ error: "Unauthorized" });
  return who;
});

/** Where a decision came from, for the audit row; clients may say which app. */
const via = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const client = request.headers["x-infrawrench-client"];
  if (client === "mobile") return "the mobile app";
  if (client === "cli") return "the CLI";
  if (client === "desktop") return "the desktop app";
  // The browser authenticates with a session cookie; everything else (the
  // desktop proxy, mobile, the CLI) presents a bearer token.
  if (request.headers["authorization"]?.toLowerCase().startsWith("bearer ")) {
    return "a signed-in app (desktop, mobile or the CLI)";
  }
  return "the web app";
});

const isStatus = (value: string): value is JitRequestStatus =>
  JIT_REQUEST_STATUSES.some((status) => status === value);

/** Validate a policy body and create or replace the policy, auditing the write. */
const writePolicy = (rawBody: unknown, policyId: string | null) =>
  Effect.gen(function* () {
    const { organizationId, session } = yield* OrgPrincipal;
    const input = yield* decodeFirstIssue(JitPolicyInput, rawBody);
    const userId: string | null = session.userId ?? null;
    const policy = yield* service(() =>
      policyId
        ? updateJitPolicy(organizationId, policyId, input)
        : createJitPolicy(organizationId, input, userId),
    );
    if (!policy) return yield* notFound();
    yield* fireAndForget(() =>
      logAudit({
        organizationId,
        userId: userId ?? undefined,
        action: policyId ? "jit_access.policy.update" : "jit_access.policy.create",
        entityType: "jit-access-policy",
        entityId: policy.id,
        metadata: {
          name: policy.name,
          accountId: policy.accountId,
          targets: policy.targets.map((t) => `${t.roleName} on ${t.scopeName}`),
          maxDurationMinutes: policy.maxDurationMinutes,
          approverUserIds: policy.approverUserIds,
          approverRoleIds: policy.approverRoleIds,
          approverOnCallScheduleIds: policy.approverOnCallScheduleIds,
          allowSelfApprovalDuringIncident: policy.allowSelfApprovalDuringIncident,
          enabled: policy.enabled,
        },
      }),
    );
    return policy;
  });

const decide = (
  decision: "approve" | "deny",
  requestId: string,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const { organizationId } = yield* OrgPrincipal;
    const who = yield* requireCaller;
    const body = yield* readJsonOr(request, {});
    const parsed = yield* decodeFirstIssue(JitNote, body ?? {});
    const from = yield* via;
    const decided = yield* service(() =>
      decideJitRequest(organizationId, requestId, decision, who, {
        note: parsed.note ?? null,
        via: from,
      }),
    );
    return yield* respond(JitAccessRequest)(decided);
  });

const JitAccessHandlers = HttpApiBuilder.group(JitAccessApi, "jitAccess", (handlers) =>
  handlers
    .handle("accounts", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const accounts = yield* legacy(() => listJitAccounts(organizationId));
        return yield* respond(Schema.Array(JitAccessAccount))(accounts);
      }),
    )
    .handle("scopes", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const scopes = yield* service(() => listJitScopeOptions(organizationId, params.accountId));
        return yield* respond(Schema.Array(JitPickerOption))(scopes);
      }),
    )
    .handle("roles", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const scopeId = query.scopeId;
        if (!scopeId) return yield* badRequest("scopeId is required");
        const roles = yield* service(() =>
          listJitRoleOptions(organizationId, params.accountId, scopeId),
        );
        return yield* respond(Schema.Array(JitPickerOption))(roles);
      }),
    )
    .handle("listPolicies", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const who = yield* caller;
        const policies = yield* legacy(() => listJitPolicies(organizationId, who ?? undefined));
        return yield* respond(Schema.Array(JitPolicy))(policies);
      }),
    )
    .handleRaw("createPolicy", ({ request }) =>
      Effect.gen(function* () {
        const body = yield* readJsonOr(request, null);
        const policy = yield* writePolicy(body, null);
        return yield* respond(JitPolicy, { status: 201 })(policy);
      }),
    )
    .handle("getPolicy", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const who = yield* caller;
        const policy = yield* legacy(() =>
          getJitPolicy(organizationId, params.policyId, who ?? undefined),
        );
        if (!policy) return yield* notFound();
        return yield* respond(JitPolicy)(policy);
      }),
    )
    .handleRaw("replacePolicy", ({ params, request }) =>
      Effect.gen(function* () {
        const body = yield* readJsonOr(request, null);
        const policy = yield* writePolicy(body, params.policyId);
        return yield* respond(JitPolicy)(policy);
      }),
    )
    .handle("deletePolicy", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const id = params.policyId;
        const existing = yield* legacy(() => getJitPolicy(organizationId, id));
        if (!existing) return yield* notFound();
        const deleted = yield* legacy(() => deleteJitPolicy(organizationId, id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "jit_access.policy.delete",
            entityType: "jit-access-policy",
            entityId: id,
            metadata: { name: existing.name, accountId: existing.accountId },
          }),
        );
        return ok;
      }),
    )
    .handle("principal", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const who = yield* requireCaller;
        const resolution = yield* service(() =>
          resolveJitPrincipalForCaller(organizationId, params.policyId, who),
        );
        return yield* respond(JitPrincipalResolution)(resolution);
      }),
    )
    .handle("principals", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const who = yield* requireCaller;
        const q = query.q?.slice(0, 200);
        const principals = yield* service(() =>
          listJitPrincipalsForPolicy(organizationId, params.policyId, who, q),
        );
        return yield* respond(Schema.Array(JitPrincipalOption))(principals);
      }),
    )
    .handle("listRequests", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const who = yield* requireCaller;
        const rawStatus = query.status;
        if (rawStatus !== undefined && !isStatus(rawStatus)) {
          return yield* badRequest(`status must be one of: ${JIT_REQUEST_STATUSES.join(", ")}`);
        }
        const requests = yield* legacy(() =>
          listJitRequests(organizationId, who, {
            ...(rawStatus ? { status: rawStatus } : {}),
            ...(query.mine === "1" ? { mine: true } : {}),
            ...(query.holding === "1" ? { holding: true } : {}),
          }),
        );
        return yield* respond(Schema.Array(JitAccessRequest))(requests);
      }),
    )
    .handleRaw("createRequest", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const who = yield* requireCaller;
        const body = yield* readJsonOr(request, null);
        const input = yield* decodeFirstIssue(JitCreateRequest, body).pipe(
          Effect.mapError((e) => new JitBadRequest({ error: e.error })),
        );
        const from = yield* via;
        const created = yield* service(() => createJitRequest(organizationId, input, who, from));
        return yield* respond(JitAccessRequest, { status: 201 })(created);
      }),
    )
    .handle("getRequest", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const who = yield* requireCaller;
        const found = yield* legacy(() => getJitRequest(organizationId, params.requestId, who));
        if (!found) return yield* notFound();
        return yield* respond(JitAccessRequest)(found);
      }),
    )
    .handleRaw("approve", ({ params, request }) => decide("approve", params.requestId, request))
    .handleRaw("deny", ({ params, request }) => decide("deny", params.requestId, request))
    // Cancel and revoke take no body: whatever is sent is not read.
    .handleRaw("cancel", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const who = yield* requireCaller;
        const from = yield* via;
        const cancelled = yield* service(() =>
          cancelJitRequest(organizationId, params.requestId, who, from),
        );
        return yield* respond(JitAccessRequest)(cancelled);
      }),
    )
    /**
     * End a grant early. Allowed for the holder, an approver, or anyone with
     * `org:settings:write`; the service owns that check, since the permission
     * depends on who is asking.
     */
    .handleRaw("revoke", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const who = yield* requireCaller;
        const from = yield* via;
        const revoked = yield* service(() =>
          revokeJitRequest(organizationId, params.requestId, who, from),
        );
        return yield* respond(JitAccessRequest)(revoked);
      }),
    )
    .handleRaw("extend", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const who = yield* requireCaller;
        const body = yield* readJsonOr(request, null);
        const { minutes } = yield* decodeFirstIssue(JitExtend, body).pipe(
          Effect.mapError((e) => new JitBadRequest({ error: e.error })),
        );
        const from = yield* via;
        const extended = yield* service(() =>
          extendJitRequest(organizationId, params.requestId, minutes, who, from),
        );
        return yield* respond(JitAccessRequest)(extended);
      }),
    ),
);

export const jitAccessDomain = makeDomain("jitAccess", JitAccessApi, JitAccessHandlers);
