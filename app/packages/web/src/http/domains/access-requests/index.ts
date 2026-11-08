/**
 * Break-glass access requests: `/api/org/:orgId/access-requests`, the
 * handlers.
 *
 * Everything here is audit-logged, denials and withdrawals included, and each
 * audit row is written before the response: a break-glass regime whose
 * history is only "who got in" is missing the half a reviewer asks about.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { eq } from "drizzle-orm";
import { lengthBetween, minLength } from "@infrawrench/api-contract/schemas";
import { db } from "@infrawrench/server-core/db/client";
import { users } from "@infrawrench/server-core/db/schema";
import {
  MAX_GRANT_MINUTES,
  MIN_GRANT_MINUTES,
  createAccessRequest,
  decideAccessRequest,
  getAccessRequest,
  listAccessRequests,
  revokeAccessGrant,
  withdrawAccessRequest,
  type AccessRequestStatus,
} from "@infrawrench/server-core/access/break-glass";
import { ALL_PERMISSIONS, hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  AccessDecision,
  AccessDecisionConflict,
  AccessDecisionForbidden,
  AccessRequest,
  AccessRequestCatalog,
  AccessRequestsApi,
  AccessRevokeConflict,
  AccessWithdrawConflict,
  badRequest,
  notFound,
  ok,
  Unauthorized,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { decodeFirstIssue, readJsonOr } from "../../request-body";
import { legacy } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";

const STATUSES: readonly AccessRequestStatus[] = ["pending", "approved", "denied", "expired"];
const isStatus = (value: string): value is AccessRequestStatus =>
  STATUSES.some((status) => status === value);

/** The create body's rules, the documented ones plus the service's grant-length bounds. */
const CreateBody = Schema.Struct({
  permissions: Schema.Array(Schema.String.check(minLength(1))).check(...lengthBetween(1, 50)),
  reason: Schema.String.check(...lengthBetween(10, 2000)),
  durationMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: MIN_GRANT_MINUTES, maximum: MAX_GRANT_MINUTES }),
  ),
});

const unauthorized = new Unauthorized({ error: "Unauthorized" });

/** The signed-in person; an API key or agent without one is a 401, as before. */
const callerId = Effect.gen(function* () {
  const { session } = yield* OrgPrincipal;
  const userId: string | undefined = session.userId;
  if (!userId) return yield* unauthorized;
  return userId;
});

const callerName = (userId: string) =>
  legacy(() =>
    db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ).pipe(Effect.map(([user]) => user?.displayName ?? user?.email ?? null));

const audit = (entry: Parameters<typeof logAudit>[0]) => legacy(() => logAudit(entry));

const decide = (decision: "approved" | "denied", requestId: string, rawBody: unknown) =>
  Effect.gen(function* () {
    const { organizationId, permissions } = yield* OrgPrincipal;
    const userId = yield* callerId;
    const parsed = yield* decodeFirstIssue(AccessDecision, rawBody ?? {});

    const name = yield* callerName(userId);
    const result = yield* legacy(() =>
      decideAccessRequest(
        organizationId,
        requestId,
        decision,
        // The decider's live set, which is the ceiling on what they can grant:
        // a grant can never mint authority nobody in the room had.
        { userId, name, permissions },
        { ...(parsed.note ? { note: parsed.note } : {}) },
      ),
    );

    if (result.outcome === "not_found") return yield* notFound();
    if (result.outcome === "self_approval") {
      return yield* new AccessDecisionForbidden({
        error:
          "You cannot decide your own access request; that is the whole point of the approval.",
        code: "self_approval",
      });
    }
    if (result.outcome === "exceeds_approver") {
      return yield* new AccessDecisionForbidden({
        error:
          `You cannot grant permissions you do not hold yourself: ` +
          `${result.missing.join(", ")}.`,
        code: "exceeds_approver",
        missing: result.missing,
      });
    }
    if (result.outcome === "conflict") {
      return yield* new AccessDecisionConflict({
        error: "This request has already been decided or has expired.",
      });
    }

    yield* audit({
      organizationId,
      userId,
      action: decision === "approved" ? "access_request.approve" : "access_request.deny",
      entityType: "access-request",
      entityId: requestId,
      metadata: {
        requesterUserId: result.request.userId,
        permissions: result.request.permissions,
        durationMinutes: result.request.durationMinutes,
        grantExpiresAt: result.request.grantExpiresAt,
        ...(result.request.decisionNote ? { note: result.request.decisionNote } : {}),
      },
    });
    return yield* respond(AccessRequest)(result.request);
  });

const AccessRequestsHandlers = HttpApiBuilder.group(
  AccessRequestsApi,
  "accessRequests",
  (handlers) =>
    handlers
      /** `?mine=1` narrows to the caller's own: "where is my request". */
      .handle("list", ({ query }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const rawStatus = query.status;
          if (rawStatus !== undefined && !isStatus(rawStatus)) {
            return yield* badRequest(`status must be one of: ${STATUSES.join(", ")}`);
          }
          const userId: string | undefined = session.userId;
          const requests = yield* legacy(() =>
            listAccessRequests(organizationId, {
              ...(rawStatus ? { status: rawStatus } : {}),
              ...(query.mine === "1" && userId ? { userId } : {}),
              ...(query.active === "1" ? { activeOnly: true } : {}),
            }),
          );
          return yield* respond(Schema.Array(AccessRequest))(requests);
        }),
      )
      /** Served rather than hard-coded so the picker cannot drift from the catalog. */
      .handle("catalog", () =>
        Effect.gen(function* () {
          const { permissions } = yield* OrgPrincipal;
          return yield* respond(AccessRequestCatalog)({
            permissions: [...ALL_PERMISSIONS],
            /** Permissions the caller already holds; the form greys these out. */
            held: ALL_PERMISSIONS.filter((p) => hasPermission(permissions, p)),
            minGrantMinutes: MIN_GRANT_MINUTES,
            maxGrantMinutes: MAX_GRANT_MINUTES,
          });
        }),
      )
      .handleRaw("create", ({ request }) =>
        Effect.gen(function* () {
          const { organizationId, permissions } = yield* OrgPrincipal;
          const userId = yield* callerId;
          const parsed = yield* decodeFirstIssue(CreateBody, yield* readJsonOr(request, null));
          const result = yield* legacy(() =>
            createAccessRequest(
              {
                organizationId,
                userId,
                permissions: [...parsed.permissions],
                reason: parsed.reason,
                durationMinutes: parsed.durationMinutes,
              },
              permissions,
            ),
          );
          if (result.outcome !== "created") return yield* badRequest(result.error);

          yield* audit({
            organizationId,
            userId,
            action: "access_request.create",
            entityType: "access-request",
            entityId: result.request.id,
            metadata: {
              permissions: result.request.permissions,
              durationMinutes: result.request.durationMinutes,
              reason: result.request.reason,
            },
          });
          return yield* respond(AccessRequest, { status: 201 })(result.request);
        }),
      )
      .handleRaw("approve", ({ params, request }) =>
        readJsonOr(request, {}).pipe(
          Effect.flatMap((body) => decide("approved", params.requestId, body)),
        ),
      )
      .handleRaw("deny", ({ params, request }) =>
        readJsonOr(request, {}).pipe(
          Effect.flatMap((body) => decide("denied", params.requestId, body)),
        ),
      )
      /**
       * End a live grant early. Allowed for anyone with `access:approve` and
       * for the holder: giving back an elevation you no longer need must never
       * require finding an approver.
       */
      .handle("revoke", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const userId = yield* callerId;
          const requestId = params.requestId;
          const existing = yield* legacy(() => getAccessRequest(organizationId, requestId));
          if (!existing) return yield* notFound();
          if (existing.userId !== userId) yield* requirePermission("access:approve");

          const name = yield* callerName(userId);
          const result = yield* legacy(() =>
            revokeAccessGrant(organizationId, requestId, { userId, name }),
          );
          if (result.outcome === "not_found") return yield* notFound();
          if (result.outcome === "not_active") {
            return yield* new AccessRevokeConflict({ error: "This grant is not active." });
          }

          yield* audit({
            organizationId,
            userId,
            action: "access_request.revoke",
            entityType: "access-request",
            entityId: requestId,
            metadata: {
              holderUserId: result.request.userId,
              permissions: result.request.permissions,
              selfRevoked: result.request.userId === userId,
            },
          });
          return yield* respond(AccessRequest)(result.request);
        }),
      )
      /** The requester calls off their own pending request. */
      .handle("withdraw", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const userId = yield* callerId;
          const requestId = params.requestId;
          const result = yield* legacy(() =>
            withdrawAccessRequest(organizationId, requestId, userId),
          );
          if (result.outcome === "not_found") return yield* notFound();
          if (result.outcome === "conflict") {
            return yield* new AccessWithdrawConflict({
              error: "This request has already been decided or has expired.",
            });
          }
          yield* audit({
            organizationId,
            userId,
            action: "access_request.withdraw",
            entityType: "access-request",
            entityId: requestId,
            metadata: {},
          });
          return ok;
        }),
      ),
);

export const accessRequestsDomain = makeDomain(
  "accessRequests",
  AccessRequestsApi,
  AccessRequestsHandlers,
);
