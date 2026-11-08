/**
 * Cost annotations: `/api/org/:orgId/cost-annotations`, the handlers. The
 * logic lives in services/cost-annotations.ts and
 * services/change-cost-impact-annotations.ts, run through `legacy` inside the
 * request's scopes.
 */
import { Effect, Layer, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { parseCostBasis } from "@infrawrench/client-core";
import {
  BadRequest,
  badRequest,
  ChangeCostImpactAnnotationResponse,
  CostAnnotation,
  CostAnnotationList,
  CostAnnotationsApi,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import {
  ChangeImpactAnnotationError,
  writeChangeImpactAnnotation,
} from "../../../services/change-cost-impact-annotations";
import {
  CostAnnotationError,
  createCostAnnotation,
  deleteCostAnnotation,
  listCostAnnotations,
  updateCostAnnotation,
} from "../../../services/cost-annotations";
import { makeDomain } from "../../domain";
import { fieldsOf, readJsonOr } from "../../request-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** A backwards span, an over-long note, or a report id from another org. */
const annotationRefusal = (error: unknown) =>
  error instanceof CostAnnotationError ? new BadRequest({ error: error.message }) : undefined;

const CostAnnotationsHandlers = HttpApiBuilder.group(
  CostAnnotationsApi,
  "costAnnotations",
  (handlers) =>
    handlers
      // With `reportId`, the set a chart for that report draws: the org-wide
      // notes plus that report's own. Without it, every annotation in the org.
      .handle("list", ({ query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const reportId = query.reportId;
          const annotations = yield* legacy(() =>
            listCostAnnotations(organizationId, { ...(reportId ? { reportId } : {}) }),
          );
          return yield* respond(CostAnnotationList)({ annotations });
        }),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const created = yield* legacyTry(
            () => createCostAnnotation(organizationId, payload, session.userId ?? null),
            annotationRefusal,
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_annotation.create",
              entityType: "cost_annotation",
              entityId: created.id,
              metadata: {
                startDate: created.startDate,
                endDate: created.endDate,
                costReportId: created.costReportId,
              },
            }),
          );
          return yield* respond(CostAnnotation)(created);
        }),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const updated = yield* legacyTry(
            () => updateCostAnnotation(organizationId, params.id, payload),
            annotationRefusal,
          );
          if (!updated) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_annotation.update",
              entityType: "cost_annotation",
              entityId: updated.id,
              metadata: {
                startDate: updated.startDate,
                endDate: updated.endDate,
                costReportId: updated.costReportId,
              },
            }),
          );
          return yield* respond(CostAnnotation)(updated);
        }),
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const deleted = yield* legacy(() => deleteCostAnnotation(organizationId, params.id));
          if (!deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_annotation.delete",
              entityType: "cost_annotation",
              entityId: params.id,
              metadata: {},
            }),
          );
          return ok;
        }),
      ),
);

/**
 * One route for both subject kinds, discriminated in the body, because they
 * write the same kind of note through the same link table. Re-posting the
 * same subject **rewords** its existing note rather than adding another. A
 * subject with no measurable impact is a 400 rather than a note reading
 * "$0.00/day": "we cannot say" must never be written down as "nothing".
 */
const ChangeImpactAnnotationsHandlers = HttpApiBuilder.group(
  CostAnnotationsApi,
  "changeImpactAnnotations",
  (handlers) =>
    handlers.handleRaw("pin", ({ request }) =>
      Effect.gen(function* () {
        const body = yield* fieldsOf(yield* readJsonOr(request, {}));
        const subjectKind = body["subjectKind"];
        if (subjectKind !== "change" && subjectKind !== "deployment") {
          return yield* badRequest("subjectKind must be change or deployment");
        }
        const subjectId = body["subjectId"];
        if (!Predicate.isString(subjectId) || subjectId.length === 0) {
          return yield* badRequest("subjectId is required");
        }
        const costBasis = parseCostBasis(body["costBasis"]);
        if (costBasis === null) return yield* badRequest("costBasis must be cash or amortized");
        const windowDays = body["windowDays"];

        const { organizationId, session } = yield* OrgPrincipal;
        const written = yield* legacyTry(
          () =>
            writeChangeImpactAnnotation(
              organizationId,
              {
                subjectKind,
                subjectId,
                ...(Predicate.isNumber(windowDays) ? { windowDays } : {}),
                costBasis,
              },
              session.userId ?? null,
            ),
          (error) =>
            error instanceof ChangeImpactAnnotationError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        if (!written) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_annotation.create",
            entityType: "cost_annotation",
            entityId: written.annotationId,
            metadata: { subjectKind, subjectId, source: "change-impact" },
          }),
        );
        return yield* respond(ChangeCostImpactAnnotationResponse)({
          annotationId: written.annotationId,
          text: written.text,
          impact: written.impact,
        });
      }),
    ),
);

export const costAnnotationsDomain = makeDomain(
  "cost-annotations",
  CostAnnotationsApi,
  Layer.mergeAll(CostAnnotationsHandlers, ChangeImpactAnnotationsHandlers),
);
