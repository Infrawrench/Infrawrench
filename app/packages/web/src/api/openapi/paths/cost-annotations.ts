import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-15" });

const StartDate = IsoDate.describe(
  "Inclusive first day (UTC) the note is about. Mapped to whichever bucket holds it at the " +
    "chart's binning — daily and cumulative use the day itself, weekly the Monday that starts " +
    "its week, monthly the first of its month.",
);

const EndDate = IsoDate.nullable().describe(
  "Inclusive last day, or null for a note about a single moment. A deploy is a moment; a " +
    "migration is a week, and a week spelled as seven notes misstates how many things happened. " +
    "An end equal to the start is stored as null — the same fact has one spelling.",
);

const CostReportId = z
  .string()
  .nullable()
  .describe(
    "The report this note is scoped to, or null for **org-wide**. Null is the useful default: " +
      'an org-wide note is drawn on every cost chart, because "we changed instance types" is ' +
      "not a fact about one report. An id from another org is a 400.",
  );

const CostAnnotationInput = strict({
  startDate: StartDate,
  endDate: EndDate.optional(),
  text: z.string().min(1).max(500),
  costReportId: CostReportId.optional(),
}).openapi("CostAnnotationInput");

const CostAnnotation = strict({
  id: Uuid,
  startDate: StartDate,
  endDate: EndDate,
  text: z.string(),
  costReportId: CostReportId,
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  costAnomalyId: Uuid.nullable().describe(
    "The detected cost anomaly this note was written to explain (see POST " +
      "/costs/anomalies/{anomalyId}/acknowledge), or null for a note written by hand. The " +
      "reverse of the anomaly's own `acknowledgement.annotationId`, resolved from that same " +
      "single link rather than stored twice.",
  ),
}).openapi("CostAnnotation");

export function registerCostAnnotationPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParam = () =>
    OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-annotations",
    tags: ["Cost annotations"],
    summary: "List cost annotations",
    description:
      "Dated notes drawn over cost charts. With `reportId`, the set a chart for that report " +
      "draws: the org-wide notes plus that report's own. Without it, every annotation in the " +
      "org. Annotations are an overlay — they never appear in a series, a total, or an axis.",
    request: {
      params: OrgIdParam,
      query: z.object({
        reportId: Uuid.optional().openapi({
          param: { name: "reportId", in: "query" },
          description: "Scope to the notes a chart for this report should draw.",
        }),
      }),
    },
    responses: {
      200: {
        description: "Annotations, newest date first",
        content: {
          "application/json": {
            schema: strict({ annotations: z.array(CostAnnotation) }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-annotations",
    tags: ["Cost annotations"],
    summary: "Create a cost annotation",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CostAnnotationInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: CostAnnotation } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-annotations/{id}",
    tags: ["Cost annotations"],
    summary: "Update a cost annotation",
    description:
      "Replaces the note's dates, text and scope. Moving a note between org-wide and one report " +
      "is this same PUT with a different `costReportId`.",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: CostAnnotationInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: CostAnnotation } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-annotations/{id}",
    tags: ["Cost annotations"],
    summary: "Delete a cost annotation",
    description:
      "A hard delete. A withdrawn explanation should stop being drawn, and nothing references a " +
      "note by id.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
