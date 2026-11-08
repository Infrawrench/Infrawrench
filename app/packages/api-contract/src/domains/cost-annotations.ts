/**
 * Cost annotations: `/api/org/:orgId/cost-annotations`, the endpoint
 * definitions.
 *
 * An annotation is a dated note drawn over a cost chart: "we migrated to
 * Graviton here". Reads are `costs:read` and writes `costs:write`, the same
 * permissions cost reports use, because a note about spend is cost data with
 * words on it rather than dashboard furniture. The note body is the shared
 * schema the annotation editor validates with (`@infrawrench/api-contract/schemas`).
 *
 * `POST /change-impact` pins a change's or a deploy's measured cost impact
 * onto the charts. It is filed under Costs, beside the impact reads, and its
 * body is checked by hand: its 400s name the field at fault.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { CostAnnotationInput, IsoDate as Day, minLength } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";
import { ChangeCostBasis, ChangeCostImpact } from "../http/schemas/change-cost-impact";

const AnnotationDay = Day.annotate({ examples: ["2026-07-15"] });

export const CostAnnotation = Schema.Struct({
  id: Uuid,
  startDate: AnnotationDay.annotate({
    description:
      "Inclusive first day (UTC) the note is about. Mapped to whichever bucket holds it at the " +
      "chart's binning: daily and cumulative use the day itself, weekly the Monday that starts " +
      "its week, monthly the first of its month.",
  }),
  endDate: Schema.NullOr(AnnotationDay).annotate({
    description:
      "Inclusive last day, or null for a note about a single moment. A deploy is a moment; a " +
      "migration is a week, and a week spelled as seven notes misstates how many things happened. " +
      "An end equal to the start is stored as null; the same fact has one spelling.",
  }),
  text: Schema.String,
  costReportId: Schema.NullOr(Schema.String).annotate({
    description:
      "The report this note is scoped to, or null for **org-wide**. Null is the useful default: " +
      'an org-wide note is drawn on every cost chart, because "we changed instance types" is ' +
      "not a fact about one report. An id from another org is a 400.",
  }),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  costAnomalyId: Schema.NullOr(Uuid).annotate({
    description:
      "The detected cost anomaly this note was written to explain (see POST " +
      "/costs/anomalies/{anomalyId}/acknowledge), or null for a note written by hand. The " +
      "reverse of the anomaly's own `acknowledgement.annotationId`, resolved from that same " +
      "single link rather than stored twice.",
  }),
  budgetAlert: Schema.NullOr(Schema.Struct({ budgetId: Uuid, eventId: Uuid })).annotate({
    description:
      "The fired budget alert this note explains (see POST " +
      "/budgets/{id}/events/{eventId}/note), or null. Resolved from the event's own " +
      "`note.annotationId`, the same single link, never stored twice.",
  }),
}).annotate({ identifier: "CostAnnotation" });

export const CostAnnotationList = Schema.Struct({ annotations: Schema.Array(CostAnnotation) });

const ChangeCostImpactAnnotationRequest = Schema.Struct({
  subjectKind: Schema.Literals(["change", "deployment"]),
  subjectId: Schema.String.check(minLength(1)),
  windowDays: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 30 }))),
  costBasis: Schema.optionalKey(ChangeCostBasis),
}).annotate({ identifier: "ChangeCostImpactAnnotationRequest" });

export const ChangeCostImpactAnnotationResponse = Schema.Struct({
  annotationId: Uuid,
  text: Schema.String,
  impact: ChangeCostImpact,
}).annotate({ identifier: "ChangeCostImpactAnnotationResponse" });

export class CostAnnotationsGroup extends HttpApiGroup.make("costAnnotations")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: {
        reportId: Schema.optionalKey(
          Uuid.annotate({ description: "Scope to the notes a chart for this report should draw." }),
        ),
      },
      success: CostAnnotationList,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List cost annotations")
      .annotate(
        OpenApi.Description,
        "Dated notes drawn over cost charts. With `reportId`, the set a chart for that report " +
          "draws: the org-wide notes plus that report's own. Without it, every annotation in the " +
          "org. Annotations are an overlay; they never appear in a series, a total, or an axis.",
      )
      .annotate(SuccessDescription, "Annotations, newest date first"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CostAnnotationInput,
      success: CostAnnotation,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a cost annotation")
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid annotation"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: CostAnnotationInput,
      success: CostAnnotation,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update a cost annotation")
      .annotate(
        OpenApi.Description,
        "Replaces the note's dates, text and scope. Moving a note between org-wide and one report " +
          "is this same PUT with a different `costReportId`.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid annotation"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a cost annotation")
      .annotate(
        OpenApi.Description,
        "A hard delete. A withdrawn explanation should stop being drawn, and nothing references a " +
          "note by id.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/cost-annotations")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost annotations") {}

export class ChangeImpactAnnotationsGroup extends HttpApiGroup.make("changeImpactAnnotations")
  .add(
    HttpApiEndpoint.post("pin", "/change-impact", {
      params: OrgParams,
      payload: ChangeCostImpactAnnotationRequest,
      success: ChangeCostImpactAnnotationResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Pin a change's or deploy's cost impact onto the cost charts")
      .annotate(
        OpenApi.Description,
        "Writes the finding as a cost annotation, so the step in the run rate is explained on the " +
          "graph where it shows. Re-posting the same subject **rewords the existing note** rather " +
          "than adding a second; which is what makes it safe to pin a finding again once the " +
          "provider has finished restating. The note's date and report scope are never rewritten: " +
          "they may have been edited deliberately.\n\n" +
          "A subject with no measurable impact is a 400, not a note reading `$0.00/day`.",
      )
      .annotate(
        SuccessDescription,
        "The annotation that was written or reworded, with the impact it describes",
      )
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/cost-annotations")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Costs") {}

export class CostAnnotationsApi extends withApiDefaults(
  HttpApi.make("cost-annotations").add(CostAnnotationsGroup).add(ChangeImpactAnnotationsGroup),
) {}
