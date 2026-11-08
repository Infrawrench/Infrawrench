/**
 * The dismissal handlers for recomputed security findings, on HttpApi.
 *
 * Posture checks and the access review are two surfaces over one decision
 * store (`posture_dismissals`; the rule-id namespaces are disjoint, so a
 * dismissal for one surface is inert on the other), and both serve these
 * handlers: the same checks, sentences and audit rows, with the surface named
 * by `auditPrefix` (`<prefix>.finding.dismissed`, `<prefix>.finding.restored`).
 *
 * The permission is `resources:write`, declared on each endpoint: accepting a
 * finding is a statement about one resource, the same trust level as
 * changing it, and members who can read the screen deliberately cannot
 * silence it.
 */
import { Effect, Predicate } from "effect";
import type { HttpServerRequest } from "effect/http";
import {
  dismissPostureFinding,
  restorePostureFinding,
  MAX_DISMISSAL_REASON_LENGTH,
} from "@infrawrench/server-core/posture/dismissals";
import { badRequest, notFound } from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { fireAndForget, legacy } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { OrgPrincipal } from "../../principal";

/**
 * Accept a finding, so it leaves the list and stops feeding the alerts.
 * Idempotent: re-dismissing rewrites the note and the author. The finding is
 * still evaluated on every scan and reported back under `dismissed`.
 */
export const dismissFinding = (auditPrefix: string, request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const read = yield* readObjectBody(request);
    if (!read.ok) return yield* badRequest(read.error);
    const body = read.body;

    const resourceId = body["resourceId"];
    const ruleId = body["ruleId"];
    if (!Predicate.isString(resourceId) || resourceId.trim() === "") {
      return yield* badRequest("resourceId is required");
    }
    if (!Predicate.isString(ruleId) || ruleId.trim() === "") {
      return yield* badRequest("ruleId is required");
    }
    const reason = body["reason"];
    if (reason !== undefined && reason !== null && !Predicate.isString(reason)) {
      return yield* badRequest("reason must be a string");
    }
    if (Predicate.isString(reason) && reason.length > MAX_DISMISSAL_REASON_LENGTH) {
      return yield* badRequest(`reason must be at most ${MAX_DISMISSAL_REASON_LENGTH} characters`);
    }

    const { organizationId, session } = yield* OrgPrincipal;
    const userId = session.userId;
    const dismissal = yield* legacy(() =>
      dismissPostureFinding(organizationId, {
        resourceId,
        ruleId,
        reason: reason ?? null,
        userId: userId ?? null,
      }),
    );
    yield* fireAndForget(() =>
      logAudit({
        organizationId,
        userId,
        action: `${auditPrefix}.finding.dismissed`,
        entityType: "resource",
        entityId: dismissal.resourceId,
        metadata: { ruleId: dismissal.ruleId, reason: dismissal.reason },
      }),
    );
    // Projected, not returned verbatim: the record carries the row's `id` and
    // `organizationId`, which the documented body forbids and no client uses.
    return {
      resourceId: dismissal.resourceId,
      ruleId: dismissal.ruleId,
      dismissedAt: dismissal.dismissedAt,
      dismissedBy: dismissal.dismissedBy,
      reason: dismissal.reason,
    };
  });

/**
 * Undo a dismissal. The key is in the query string, not the path: resource
 * ids are provider-native and routinely contain slashes, which path encoding
 * does not reliably survive.
 */
export const restoreFinding = (
  auditPrefix: string,
  query: { readonly resourceId?: string | undefined; readonly ruleId?: string | undefined },
) =>
  Effect.gen(function* () {
    const { resourceId, ruleId } = query;
    if (!resourceId) return yield* badRequest("resourceId is required");
    if (!ruleId) return yield* badRequest("ruleId is required");

    const { organizationId, session } = yield* OrgPrincipal;
    const removed = yield* legacy(() => restorePostureFinding(organizationId, resourceId, ruleId));
    if (!removed) return yield* notFound("That finding is not dismissed");

    yield* fireAndForget(() =>
      logAudit({
        organizationId,
        userId: session.userId,
        action: `${auditPrefix}.finding.restored`,
        entityType: "resource",
        entityId: resourceId,
        metadata: { ruleId },
      }),
    );
  });
