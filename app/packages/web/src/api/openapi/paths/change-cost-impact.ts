/**
 * Cost per change / cost per deploy.
 *
 * Three routes that share one set of schemas, which is why they live in one
 * file rather than being split across `resource-changes.ts`,
 * `deployments.ts` and `cost-annotations.ts` the way their handlers are: the
 * shape of an impact is the contract, and describing it three times is how
 * three descriptions of it end up disagreeing.
 */
import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, ResourceId, Uuid } from "../common";
import type { BuildContext } from "../context";

const ChangeCostBasis = z
  .enum(["cash", "amortized"])
  .describe(
    "Which charge-type basis both windows are read on. `cash` (the default) is what the provider " +
      "charged on the day it charged it; `amortized` spreads a commitment's up-front fee across " +
      "the term it buys. It is echoed on every response because a delta whose basis is unstated " +
      "is unreadable — an amortized 'after' against a cash 'before' looks exactly like a saving.",
  )
  .openapi("ChangeCostBasis");

const ChangeCostImpactStatus = z
  .enum(["measured", "insufficient_data", "unknown"])
  .describe(
    "`measured` — both windows had collected data and the delta is real. " +
      "`insufficient_data` — the windows exist but are too short to compare. " +
      "`unknown` — nothing here can answer the question. **`unknown` is never zero**: a resource " +
      "with no cost data reports that we cannot say, not that the change was free.",
  )
  .openapi("ChangeCostImpactStatus");

const ChangeCostImpactConfidence = z
  .enum(["high", "medium", "low", "none"])
  .describe(
    "How much the delta is worth believing. Derived from the number of comparable days per side " +
      "(7+ high, 4+ medium, otherwise low) and dropped one tier when other recorded changes " +
      "touched the same resource inside the window.",
  )
  .openapi("ChangeCostImpactConfidence");

const ChangeCostImpactReason = z
  .enum([
    "no_cost_identity",
    "period_native_provider",
    "no_cost_data",
    "no_coverage_before",
    "no_coverage_after",
    "short_window",
    "window_clamped",
    "overlapping_changes",
  ])
  .describe(
    "Why the result reads the way it does. Every non-`measured` status carries at least one, and " +
      "`measured` carries whatever lowered its confidence. `period_native_provider` is the " +
      "notable one: a provider that dates a whole invoice period to the period's start cannot be " +
      "read by a day-window comparison at all.",
  )
  .openapi("ChangeCostImpactReason");

const ChangeCostImpactSeries = strict({
  currency: z.string().openapi({ description: "ISO 4217 code. Currencies are never summed." }),
  beforePerDay: z.number(),
  afterPerDay: z.number(),
  deltaPerDay: z.number().openapi({
    description: "`afterPerDay - beforePerDay`. Positive means the change costs more.",
  }),
  deltaPercent: z.number().nullable().openapi({
    description: "Null when the before window spent nothing — there is no percentage.",
  }),
  beforeTotal: z.number(),
  afterTotal: z.number(),
}).openapi("ChangeCostImpactSeries");

const ChangeCostImpactWindow = strict({
  from: z.string().openapi({ description: "Inclusive first UTC day, `YYYY-MM-DD`." }),
  to: z.string().openapi({ description: "Inclusive last UTC day." }),
}).openapi("ChangeCostImpactWindow");

const ChangeCostImpact = strict({
  status: ChangeCostImpactStatus,
  costBasis: ChangeCostBasis,
  windowDays: z.number().int().openapi({ description: "The half-window that was requested." }),
  effectiveWindowDays: z
    .number()
    .int()
    .openapi({
      description:
        "The half-window the data supported. Clamped symmetrically, so both means always average " +
        "the same number of days.",
    }),
  eventDay: z.string().openapi({
    description: "UTC day the change landed on. Excluded from both windows — it is a mixed day.",
  }),
  before: ChangeCostImpactWindow.nullable(),
  after: ChangeCostImpactWindow.nullable(),
  series: z.array(ChangeCostImpactSeries),
  confidence: ChangeCostImpactConfidence,
  reasons: z.array(ChangeCostImpactReason),
  overlappingChanges: z
    .number()
    .int()
    .nonnegative()
    .openapi({
      description:
        "Other recorded changes to the same resource inside the window. A delta is correlation, " +
        "never causation; this is the number that says how much else was going on.",
    }),
}).openapi("ChangeCostImpact");

const ChangeCostImpactEntry = strict({
  changeId: Uuid,
  resourceId: ResourceId,
  impact: ChangeCostImpact,
}).openapi("ChangeCostImpactEntry");

const ChangeCostImpactsRequest = strict({
  changeIds: z.array(Uuid).max(50).openapi({
    description: "Change ids from `GET /changes`. At most 50 — one feed page.",
  }),
  windowDays: z.number().int().min(2).max(30).optional().openapi({
    description: "Days either side of the change. Default 7; clamped server-side.",
  }),
  costBasis: ChangeCostBasis.optional(),
}).openapi("ChangeCostImpactsRequest");

const ChangeCostImpactsResponse = strict({
  impacts: z.array(ChangeCostImpactEntry),
}).openapi("ChangeCostImpactsResponse");

const DeploymentCostImpactResource = strict({
  resourceId: ResourceId,
  displayName: z.string(),
  pluginId: z.string(),
  resourceTypeId: z.string(),
  impact: ChangeCostImpact,
}).openapi("DeploymentCostImpactResource");

const DeploymentCostImpact = strict({
  runId: Uuid,
  costBasis: ChangeCostBasis,
  windowDays: z.number().int(),
  eventDay: z
    .string()
    .openapi({ description: "The run's start day, UTC — what both windows hang off." }),
  resources: z.array(DeploymentCostImpactResource).openapi({
    description:
      "One row per resource the run provisioned through `infra.accounts.*.create(...)`. That is " +
      "the only set attributable to a run with certainty: a deploy that merely re-shipped an " +
      "image links to nothing and honestly reports an empty breakdown.",
  }),
  total: z.array(strict({ currency: z.string(), deltaPerDay: z.number() })).openapi({
    description:
      "Summed `deltaPerDay` per currency across the **measured** rows only, so the breakdown " +
      "always adds up to it. An unmeasurable resource contributes nothing rather than zero.",
  }),
  unknownResources: z.number().int().nonnegative().openapi({
    description: "Rows excluded from `total` because their impact could not be measured.",
  }),
  confidence: ChangeCostImpactConfidence.describe(
    "The weakest confidence among the measured rows — a breakdown is only as good as its worst row.",
  ),
}).openapi("DeploymentCostImpact");

const ChangeCostImpactAnnotationRequest = strict({
  subjectKind: z.enum(["change", "deployment"]),
  subjectId: z.string().min(1),
  windowDays: z.number().int().min(2).max(30).optional(),
  costBasis: ChangeCostBasis.optional(),
}).openapi("ChangeCostImpactAnnotationRequest");

const ChangeCostImpactAnnotationResponse = strict({
  annotationId: Uuid,
  text: z.string(),
  impact: ChangeCostImpact,
}).openapi("ChangeCostImpactAnnotationResponse");

export function registerChangeCostImpactPaths(ctx: BuildContext): void {
  ctx.registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/changes/cost-impacts",
    tags: ["Changes"],
    summary: "Cost impact of a page of changes",
    description:
      "For each change, compares the resource's per-day spend over the window before it against " +
      "the window after, and reports the difference as a run-rate delta.\n\n" +
      "A POST because it takes a list of ids, not because it writes: nothing is stored. The " +
      "answer is recomputed on every call, deliberately — provider cost arrives late and is then " +
      "restated, so a stored number would be a wrong number that never corrects itself.\n\n" +
      "Both windows exclude the change's own day (spend on it is half old shape, half new) and " +
      "today (an accruing day always reads as a dip), and are clamped symmetrically to the days " +
      "cost collection actually covers.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ChangeCostImpactsRequest } } },
    },
    responses: {
      200: {
        description: "One entry per change id that belongs to the organization",
        content: { "application/json": { schema: ChangeCostImpactsResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/deployments/runs/{id}/cost-impact",
    tags: ["Deployments"],
    summary: "Cost impact of a deployment run",
    description:
      "The same comparison as `POST /changes/cost-impacts`, run over the resources this deploy " +
      "provisioned, with a per-resource breakdown that sums to the total.",
    request: {
      params: OrgIdParam.extend({ id: Uuid }),
      query: strict({
        windowDays: z.coerce
          .number()
          .int()
          .min(2)
          .max(30)
          .optional()
          .openapi({ param: { name: "windowDays", in: "query" } }),
        costBasis: ChangeCostBasis.optional().openapi({
          param: { name: "costBasis", in: "query" },
        }),
      }),
    },
    responses: {
      200: {
        description: "Per-resource cost impact for the run",
        content: { "application/json": { schema: DeploymentCostImpact } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  ctx.registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/cost-annotations/change-impact",
    tags: ["Costs"],
    summary: "Pin a change's or deploy's cost impact onto the cost charts",
    description:
      "Writes the finding as a cost annotation, so the step in the run rate is explained on the " +
      "graph where it shows. Re-posting the same subject **rewords the existing note** rather " +
      "than adding a second — which is what makes it safe to pin a finding again once the " +
      "provider has finished restating. The note's date and report scope are never rewritten: " +
      "they may have been edited deliberately.\n\n" +
      "A subject with no measurable impact is a 400, not a note reading `$0.00/day`.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ChangeCostImpactAnnotationRequest } } },
    },
    responses: {
      200: {
        description: "The annotation that was written or reworded, with the impact it describes",
        content: { "application/json": { schema: ChangeCostImpactAnnotationResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
