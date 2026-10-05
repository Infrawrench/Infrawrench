import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import {
  REALIZED_SAVINGS_BASES,
  REALIZED_SAVINGS_LIMITS,
  SAVINGS_EVENT_KINDS,
  SAVINGS_EVENT_SOURCES,
} from "@infrawrench/client-core";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-15" });

const Money = z.number().describe("Currency units (not cents), in the row's currency.");

export function registerSavingsPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const SavingsEventKind = z
    .enum(SAVINGS_EVENT_KINDS)
    .describe(
      "`rightsizing` — a resize to a smaller size; `orphan_deletion` — a resource the orphan " +
        "finder flags was deleted; `sleep_schedule` — a stretch of a sleep/wake schedule in force; " +
        "`commitment` — reservation and savings-plan discounts, derived from billing; `manual` — " +
        "logged by a person.",
    )
    .openapi("SavingsEventKind");

  const SavingsEventSource = z
    .enum(SAVINGS_EVENT_SOURCES)
    .describe(
      "`in_app` — recorded when Infrawrench performed the action; `detected` — inferred from an " +
        "inventory diff on sync (the action was taken in the provider's console); `manual`; " +
        "`derived` — computed from billing with no stored event (commitments).",
    )
    .openapi("SavingsEventSource");

  const RealizedSavingsBasis = z
    .enum(REALIZED_SAVINGS_BASES)
    .describe(
      "`billing` — baseline and post-action spend both read from this resource's cost rows; " +
        "`estimate` — no per-resource billing, so the list-price estimate is accrued over elapsed " +
        "days; `manual` — the logged amount accrued; `unmeasured` — nothing to measure against " +
        "(never summed as zero).",
    )
    .openapi("RealizedSavingsBasis");

  const SavingsShortfall = strict({
    kind: z
      .enum(["below_projection", "grew_back"])
      .describe(
        "`below_projection` — the trailing realized rate is under the org's threshold share of " +
          "the projected rate; `grew_back` — post-action spend is above the pre-action baseline.",
      ),
    realizedPerDay: Money,
    projectedPerDay: Money.nullable(),
  }).openapi("SavingsShortfall");

  const eventShape = {
    id: z
      .string()
      .describe("A UUID for stored events; `commitment:<accountId>:<currency>` for derived rows."),
    kind: SavingsEventKind,
    source: SavingsEventSource,
    title: z.string(),
    note: z.string().nullable(),
    occurredOn: IsoDate.describe("The day the action took effect (UTC)."),
    endedOn: IsoDate.nullable().describe("Last day in force, inclusive; null while it still is."),
    accountId: z.string().nullable(),
    accountName: z.string().nullable(),
    pluginId: z.string().nullable(),
    resourceTypeId: z.string().nullable(),
    resourceId: z.string().nullable().describe("Kept after the resource is deleted."),
    resourceName: z.string().nullable(),
    costCentreId: z
      .string()
      .nullable()
      .describe("Explicit attribution; null means attributed by the allocation rules."),
    projectedMonthlyAmount: Money.nullable().describe(
      "What the action was projected to save per month.",
    ),
    currency: z.string().nullable(),
    horizonMonths: z
      .number()
      .int()
      .nullable()
      .describe("Per-entry horizon override; null uses the org setting."),
    costAnnotationId: z
      .string()
      .nullable()
      .describe("The cost annotation marking the action on charts."),
    createdByUserId: z.string().nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  };

  const SavingsEvent = strict(eventShape).openapi("SavingsEvent");

  const SavingsEventResult = strict({
    ...eventShape,
    basis: RealizedSavingsBasis,
    status: z.enum(["pending", "accruing", "complete", "ended"]),
    realizedCurrency: z.string().nullable(),
    baselinePerDay: Money.nullable().describe("Spend per day before the action."),
    currentPerDay: Money.nullable().describe(
      "Spend per day over the trailing measured days since.",
    ),
    realizedToDate: Money.nullable(),
    realizedInRange: Money.nullable(),
    projectedInRange: Money.nullable().describe(
      "Projected over the same accrued days in the range.",
    ),
    accruedDays: z.number().int(),
    horizonEndsOn: IsoDate.nullable().describe(
      "Last day a one-off action accrues on; null for recurring ones.",
    ),
    attributedCostCentreId: z.string().nullable(),
    attributedCostCentreName: z.string().nullable(),
    shortfall: SavingsShortfall.nullable(),
    editable: z
      .enum(["full", "annotate", "none"])
      .describe(
        "`full` — a manual entry (PUT); `annotate` — an automatic event takes a note, a cost " +
          "centre, a horizon and an end date (PATCH); `none` — derived rows.",
      ),
  }).openapi("SavingsEventResult");

  const RealizedSavingsSettings = strict({
    horizonMonths: z
      .number()
      .int()
      .min(REALIZED_SAVINGS_LIMITS.minHorizonMonths)
      .max(REALIZED_SAVINGS_LIMITS.maxHorizonMonths)
      .describe("How long a one-off action keeps accruing, in months. Default 12."),
    shortfallThresholdPercent: z
      .number()
      .int()
      .min(REALIZED_SAVINGS_LIMITS.minShortfallThresholdPercent)
      .max(REALIZED_SAVINGS_LIMITS.maxShortfallThresholdPercent)
      .describe("Below this share of the projected rate an action is flagged short. Default 70."),
    baselineWindowDays: z
      .number()
      .int()
      .min(REALIZED_SAVINGS_LIMITS.minBaselineWindowDays)
      .max(REALIZED_SAVINGS_LIMITS.maxBaselineWindowDays)
      .describe("Days before the action whose spend makes up the baseline. Default 14."),
  }).openapi("RealizedSavingsSettings");

  const Total = strict({ currency: z.string(), realized: Money, projected: Money }).openapi(
    "RealizedSavingsTotal",
  );
  const Bucket = strict({
    key: z.string(),
    label: z.string(),
    currency: z.string(),
    realized: Money,
    projected: Money,
    events: z.number().int(),
  }).openapi("RealizedSavingsBucket");
  const Month = strict({
    month: z.string().describe("YYYY-MM"),
    currency: z.string(),
    realized: Money,
    projected: Money,
  }).openapi("RealizedSavingsMonth");

  const Report = strict({
    from: IsoDate,
    to: IsoDate,
    settings: RealizedSavingsSettings,
    totals: z.array(Total),
    byMonth: z.array(Month),
    byKind: z.array(Bucket),
    byCostCentre: z.array(Bucket),
    byAccount: z.array(Bucket),
    events: z.array(SavingsEventResult),
    shortfallCount: z.number().int(),
    unmeasuredCount: z.number().int(),
  }).openapi("RealizedSavingsReport");

  const SavingsEventInput = strict({
    title: z.string().min(1).max(REALIZED_SAVINGS_LIMITS.titleMaxLength),
    note: z.string().max(REALIZED_SAVINGS_LIMITS.noteMaxLength).nullable().optional(),
    occurredOn: IsoDate,
    endedOn: IsoDate.nullable().optional(),
    projectedMonthlyAmount: z.number().positive().max(REALIZED_SAVINGS_LIMITS.maxMonthlyAmount),
    currency: z.string().regex(/^[A-Z]{3}$/),
    resourceId: z
      .string()
      .nullable()
      .optional()
      .describe("Link a resource: the realized figure is then measured from its billing."),
    accountId: z.string().nullable().optional(),
    costCentreId: z.string().nullable().optional(),
    horizonMonths: z
      .number()
      .int()
      .min(REALIZED_SAVINGS_LIMITS.minHorizonMonths)
      .max(REALIZED_SAVINGS_LIMITS.maxHorizonMonths)
      .nullable()
      .optional(),
  }).openapi("SavingsEventInput");

  const SavingsEventAnnotation = strict({
    note: z.string().max(REALIZED_SAVINGS_LIMITS.noteMaxLength).nullable().optional(),
    costCentreId: z.string().nullable().optional(),
    horizonMonths: z
      .number()
      .int()
      .min(REALIZED_SAVINGS_LIMITS.minHorizonMonths)
      .max(REALIZED_SAVINGS_LIMITS.maxHorizonMonths)
      .nullable()
      .optional(),
    endedOn: IsoDate.nullable().optional(),
  }).openapi("SavingsEventAnnotation");

  const idParam = () =>
    OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/savings/realized",
    tags: ["Realized savings"],
    summary: "Realized savings report",
    description:
      "What the actions taken actually saved, against each resource's own trailing daily spend " +
      "before the action, accrued day by day (one-off actions up to the horizon). Recomputed on " +
      "every read, so figures improve as restated billing lands. Days collection has not " +
      "covered are not accrued. Per-currency throughout; never converted or merged.",
    request: {
      params: OrgIdParam,
      query: z.object({
        from: IsoDate.optional().openapi({
          param: { name: "from", in: "query" },
          description: "Inclusive first day. Defaults to the first of the month 11 months back.",
        }),
        to: IsoDate.optional().openapi({
          param: { name: "to", in: "query" },
          description: "Inclusive last day. Defaults to yesterday.",
        }),
      }),
    },
    responses: {
      200: { description: "The report", content: { "application/json": { schema: Report } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/savings/events",
    tags: ["Realized savings"],
    summary: "Log a saving",
    description:
      "Record a saving by hand, with the monthly amount and the day it began. Leaves an org-wide " +
      "cost annotation on that day. Requires `costs:write`.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SavingsEventInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: SavingsEvent } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/savings/events/{id}",
    tags: ["Realized savings"],
    summary: "Rewrite a manual saving",
    description: "Full replace of a manual entry. Automatic events are a 400; use PATCH.",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: SavingsEventInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: SavingsEvent } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/savings/events/{id}",
    tags: ["Realized savings"],
    summary: "Annotate a saving",
    description:
      "Add context to any event: a note, an explicit cost centre, a horizon override, or an end " +
      "date. The facts of an automatic event (what was done, when, the projection) stay as observed.",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: SavingsEventAnnotation } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: SavingsEvent } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/savings/events/{id}",
    tags: ["Realized savings"],
    summary: "Remove a saving",
    description: "Hard delete, together with the cost annotation the event left on the charts.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/savings/settings",
    tags: ["Realized savings"],
    summary: "Get realized savings settings",
    description:
      "The org's horizon, shortfall threshold and baseline window; defaults when never saved.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Settings",
        content: { "application/json": { schema: RealizedSavingsSettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/savings/settings",
    tags: ["Realized savings"],
    summary: "Update realized savings settings",
    description: "Requires `costs:write`. Changes every figure in the report, retroactively.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: RealizedSavingsSettings } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Saved",
        content: { "application/json": { schema: RealizedSavingsSettings } },
      },
      400: ErrorResponses[400],
    },
  });
}
