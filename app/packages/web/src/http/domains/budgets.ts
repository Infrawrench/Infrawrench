/**
 * Budgets: `/api/org/:orgId/budgets`.
 *
 * Request bodies are the shared schemas the budget form validates with
 * (`@infrawrench/ui/schemas`); response shapes are documented here. The
 * services are still promise code and run through `legacy`, inside the
 * request's cost visibility scope.
 */
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  AlertEmailRecipients,
  BudgetAlertNoteInput,
  BudgetCostBasis,
  BudgetCostFilter,
  BudgetInput,
  BudgetMeasure,
  BudgetParentId,
  BudgetPeriod,
  BudgetSavedFilterId,
  BudgetScenarioModelId,
  BudgetThreshold,
  BudgetUsageAmount,
  BudgetUsageUnit,
  BudgetUseAdjustedSpend,
  pattern,
} from "@infrawrench/ui/schemas";
import { SavedCostFilterResolutionError } from "@infrawrench/server-core/cost/saved-filters";
import { AlertEmailRecipientsError } from "@infrawrench/server-core/alerts/email-errors";
import {
  BudgetValidationError,
  createBudget,
  getBudgetWithStatus,
  listBudgetEvents,
  listBudgetsWithStatus,
  softDeleteBudget,
  updateBudget,
} from "../../services/budgets";
import { BudgetAlertNoteError, noteBudgetAlertEvent } from "../../services/budget-alert-notes";
import { logAudit } from "../../services/audit";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../annotations";
import { makeDomain, withApiDefaults } from "../domain";
import { BadRequest, Forbidden, NotFound, notFound } from "../errors";
import { fireAndForget, legacy, legacyTry } from "../legacy";
import { OrgAuth } from "../middleware";
import { OrgPrincipal, requirePermission } from "../principal";
import { respond } from "../response";
import { IsoDate, IsoDateTime, Ok, ok, OrgIdParams, OrgParams, Uuid } from "../schemas/common";

const Month = Schema.String.check(pattern(/^\d{4}-\d{2}$/)).annotate({
  examples: ["2026-07"],
});

const IsoDay = Schema.String.check(pattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
  examples: ["2026-10-01"],
});

const BudgetHierarchyWarning = Schema.Struct({
  kind: Schema.Literals(["allocation", "actual", "forecast"]).annotate({
    description:
      "`allocation`: the children's own amounts for this period (children on the same period " +
      "only) add up to more than the parent's. `actual`: together they have already spent " +
      "more. `forecast`: together they are projected to.",
  }),
  childTotal: Schema.Finite.annotate({
    description: "The children's total, in the parent's unit.",
  }),
  parentLimit: Schema.Finite.annotate({
    description: "The parent's limit for the period, in the same unit.",
  }),
}).annotate({ identifier: "BudgetHierarchyWarning" });

const BudgetFull = Schema.Struct({
  id: Uuid,
  organizationId: Uuid,
  name: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  filters: Schema.Array(BudgetCostFilter),
  savedFilterId: Schema.NullOr(BudgetSavedFilterId),
  scenarioModelId: Schema.NullOr(BudgetScenarioModelId),
  thresholds: Schema.Array(BudgetThreshold),
  costBasis: BudgetCostBasis,
  useAdjustedSpend: BudgetUseAdjustedSpend,
  emailRecipients: AlertEmailRecipients,
  createdByUserId: Schema.NullOr(Schema.String),
  deletedAt: Schema.NullOr(IsoDate),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  measure: BudgetMeasure,
  usageUnit: Schema.NullOr(BudgetUsageUnit),
  usageAmount: Schema.NullOr(BudgetUsageAmount),
  period: Schema.NullOr(BudgetPeriod),
  parentBudgetId: Schema.NullOr(BudgetParentId),
}).annotate({ identifier: "BudgetFull" });

const BudgetAlertNote = Schema.Struct({
  text: Schema.String,
  notedAt: IsoDateTime.annotate({
    description: "When the note as it now reads was written; a rewrite restamps it.",
  }),
  notedByUserId: Schema.NullOr(Schema.String),
  notedByName: Schema.NullOr(Schema.String).annotate({
    description: "The author's display name, or email when they have none.",
  }),
  annotationId: Schema.NullOr(Schema.String).annotate({
    description:
      "The org-wide cost annotation the note drew on the charts at the day the alert fired " +
      "(see /cost-annotations). Null once that marker is deleted; the note itself stays.",
  }),
}).annotate({
  identifier: "BudgetAlertNote",
  description: "Somebody's explanation of this firing. Null while there is none.",
});

const budgetAlertEventFields = {
  id: Uuid,
  month: Month,
  thresholdType: Schema.Literals(["actual", "forecast"]),
  thresholdPercent: Schema.Int,
  actualAmountCents: Schema.Int,
  forecastAmountCents: Schema.NullOr(Schema.Int),
  triggeredAt: IsoDateTime,
  periodStart: Schema.NullOr(IsoDay).annotate({
    description:
      "First day of the period the crossing was observed in; null on events from before " +
      "budget periods were configurable (those are calendar months: see `month`).",
  }),
  periodEnd: Schema.NullOr(IsoDay),
  actualUsage: Schema.NullOr(Schema.Finite).annotate({
    description: "A usage budget's period-to-date usage at the crossing (the cents fields are 0).",
  }),
  forecastUsage: Schema.NullOr(Schema.Finite),
  note: Schema.NullOr(BudgetAlertNote),
};

const BudgetAlertEvent = Schema.Struct(budgetAlertEventFields).annotate({
  identifier: "BudgetAlertEvent",
});

const BudgetAlertNoteResult = Schema.Struct({
  ...budgetAlertEventFields,
  followUp: Schema.Struct({
    slack: Schema.Int.annotate({ description: "Slack threads the note was posted in as a reply." }),
    msTeams: Schema.Int.annotate({
      description: "Teams webhooks the note was sent to (incoming webhooks cannot thread).",
    }),
  }),
}).annotate({ identifier: "BudgetAlertNoteResult" });

const BudgetWithStatus = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  filters: Schema.Array(BudgetCostFilter),
  thresholds: Schema.Array(BudgetThreshold),
  costBasis: BudgetCostBasis.annotate({
    description: "The basis `actualCents` and `forecastCents` were measured on.",
  }),
  savedFilterId: Schema.NullOr(BudgetSavedFilterId),
  scenarioModelId: Schema.NullOr(BudgetScenarioModelId),
  scenarioModelName: Schema.NullOr(Schema.String).annotate({
    description:
      "The opted-into model's name, so a card can say whose assumptions are in the number.",
  }),
  useAdjustedSpend: BudgetUseAdjustedSpend,
  emailRecipients: AlertEmailRecipients,
  rawActualCents: Schema.NullOr(Schema.Int).annotate({
    description:
      "Month-to-date **collected** spend, non-null only for a budget measuring adjusted spend. " +
      'Null on an unadjusted budget rather than a copy of `actualCents`: "there is no ' +
      'separate collected figure because this one is it" and "the collected figure happens ' +
      'to equal the adjusted one" are different facts, and captioning every budget in the ' +
      "organisation would make the adjusted ones invisible.",
  }),
  month: Month,
  actualCents: Schema.Int,
  forecastCents: Schema.NullOr(Schema.Int).annotate({
    description:
      "The **unadjusted trend** forecast, whether or not a scenario is applied; so both " +
      "numbers are always comparable.",
  }),
  forecastLowCents: Schema.optionalKey(
    Schema.NullOr(Schema.Int).annotate({
      description:
        "Lower end of the 80% prediction interval around `forecastCents` (the trend's, before " +
        "any scenario), never below the spend already observed. Null when there was too " +
        "little history to fit. Display only: thresholds are judged on `forecastCents`.",
    }),
  ),
  forecastHighCents: Schema.optionalKey(
    Schema.NullOr(Schema.Int).annotate({
      description: "Upper end of the 80% prediction interval around `forecastCents`.",
    }),
  ),
  scenarioForecastCents: Schema.NullOr(Schema.Int).annotate({
    description:
      "The scenario-adjusted month forecast, set only for a budget that opted into a model, " +
      "and the number its forecast thresholds are judged against. Null means the thresholds " +
      "used `forecastCents`.",
  }),
  currentMonthEvents: Schema.Array(
    Schema.Struct({
      id: Uuid,
      thresholdType: Schema.Literals(["actual", "forecast"]),
      thresholdPercent: Schema.Int,
      triggeredAt: IsoDateTime,
      note: Schema.optionalKey(Schema.NullOr(BudgetAlertNote)),
    }),
  ),
  /** The dashboards carrying a card for this budget; empty is normal. */
  placements: Schema.Array(
    Schema.Struct({ widgetId: Uuid, dashboardId: Uuid, dashboardName: Schema.String }),
  ),
  measure: BudgetMeasure,
  usageUnit: Schema.NullOr(BudgetUsageUnit),
  usageAmount: Schema.NullOr(BudgetUsageAmount),
  period: Schema.NullOr(BudgetPeriod),
  parentBudgetId: Schema.NullOr(BudgetParentId),
  periodStart: Schema.NullOr(IsoDay).annotate({
    description:
      "First day of the period being measured. Null when the budget's periods do not cover " +
      "today (a cadence not started yet, a gap in an explicit list): nothing is measured.",
  }),
  periodEnd: Schema.NullOr(IsoDay),
  periodLimit: Schema.NullOr(Schema.Finite).annotate({
    description:
      "This period's limit in the budget's unit: cents for a spend budget, the quantity for " +
      "a usage budget. Null when no period is active.",
  }),
  actualUsage: Schema.NullOr(Schema.Finite).annotate({
    description: "Period-to-date usage, for a usage budget (whose `actualCents` is 0).",
  }),
  forecastUsage: Schema.NullOr(Schema.Finite).annotate({
    description: "Projected period-end usage, for a usage budget.",
  }),
  rolledUp: Schema.Boolean.annotate({
    description:
      "True when the budget has children, so its figures are the sum of theirs over its " +
      "period rather than a measurement of its own scope.",
  }),
  childCount: Schema.Int.annotate({ description: "Number of direct child budgets." }),
  hierarchyWarnings: Schema.Array(BudgetHierarchyWarning),
}).annotate({ identifier: "BudgetWithStatus" });

export class BudgetsGroup extends HttpApiGroup.make("budgets")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(BudgetWithStatus),
    })
      .annotate(RequiredPermission, "budgets:read")
      .annotate(OpenApi.Summary, "List budgets with current-period actuals and forecasts")
      .annotate(SuccessDescription, "Budgets"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: BudgetInput,
      success: BudgetFull,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "budgets:write")
      .annotate(OpenApi.Summary, "Create a budget")
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid budget"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: BudgetWithStatus,
      error: NotFound,
    })
      .annotate(RequiredPermission, "budgets:read")
      .annotate(OpenApi.Summary, "Get a budget with current-period status")
      .annotate(SuccessDescription, "Budget"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: BudgetInput,
      success: BudgetFull,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "budgets:write")
      .annotate(OpenApi.Summary, "Update a budget")
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid budget"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "budgets:write")
      .annotate(OpenApi.Summary, "Delete a budget")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("events", "/:id/events", {
      params: OrgIdParams,
      success: Schema.Array(BudgetAlertEvent),
      error: NotFound,
    })
      .annotate(RequiredPermission, "budgets:read")
      .annotate(OpenApi.Summary, "Alert event history for a budget")
      .annotate(SuccessDescription, "Events"),
    // `costs:write` for the annotation it creates (the documented gate, and
    // what anomaly explanations need), plus `budgets:read` to address the
    // budget, checked in the handler: the annotation takes one permission.
    HttpApiEndpoint.post("note", "/:id/events/:eventId/note", {
      params: { ...OrgIdParams, eventId: Uuid },
      payload: BudgetAlertNoteInput,
      success: BudgetAlertNoteResult,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Explain a fired budget alert")
      .annotate(
        OpenApi.Description,
        "Saves a note on one firing (who and when are recorded), draws it on every cost chart as " +
          "an org-wide annotation at the day the alert fired, and posts it after the alert: a " +
          "reply in each Slack message's thread and a follow-up to the Teams webhooks it reached. " +
          "Sending again rewrites the note and rewords the same chart marker rather than adding " +
          "another; a marker somebody deleted is not recreated. Alerts that fired before notes " +
          "existed, or that quiet hours held, have no recorded chat messages to follow. Needs " +
          "`budgets:read` and `costs:write`.",
      )
      .annotate(SuccessDescription, "The event with its note, and where the follow-up was posted")
      .annotate(InvalidRequestMessage, "Invalid note"),
  )
  .prefix("/api/org/:orgId/budgets")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Budgets") {}

export class BudgetsApi extends withApiDefaults(HttpApi.make("budgets").add(BudgetsGroup)) {}

/** The service's refusals that are the caller's fault: 400 with its sentence. */
const writeRefusal = (error: unknown) =>
  error instanceof SavedCostFilterResolutionError ||
  error instanceof BudgetValidationError ||
  error instanceof AlertEmailRecipientsError
    ? new BadRequest({ error: error.message })
    : undefined;

const BudgetsHandlers = HttpApiBuilder.group(BudgetsApi, "budgets", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const budgets = yield* legacy(() => listBudgetsWithStatus(organizationId));
        return yield* respond(Schema.Array(BudgetWithStatus))(budgets);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        // A budget must not be born pointing at a saved filter that does not
        // resolve: it would error every evaluation from day one.
        const created = yield* legacyTry(
          () => createBudget(organizationId, payload, session.userId ?? null),
          writeRefusal,
        );
        return yield* respond(BudgetFull)(created);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const budget = yield* legacy(() => getBudgetWithStatus(organizationId, params.id));
        if (!budget) return yield* notFound();
        return yield* respond(BudgetWithStatus)(budget);
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const updated = yield* legacyTry(
          () => updateBudget(organizationId, params.id, payload),
          writeRefusal,
        );
        if (!updated) return yield* notFound();
        return yield* respond(BudgetFull)(updated);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => softDeleteBudget(organizationId, params.id));
        if (!deleted) return yield* notFound();
        return ok;
      }),
    )
    .handle("events", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const events = yield* legacy(() => listBudgetEvents(organizationId, params.id));
        if (!events) return yield* notFound();
        return yield* respond(Schema.Array(BudgetAlertEvent))(events);
      }),
    )
    .handle("note", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* requirePermission("budgets:read");
        const { organizationId, session } = yield* OrgPrincipal;
        const result = yield* legacyTry(
          () =>
            noteBudgetAlertEvent(
              organizationId,
              params.id,
              params.eventId,
              payload.note,
              session.userId ?? null,
            ),
          (error) =>
            error instanceof BudgetAlertNoteError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        if (!result) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "budget_alert.note",
            entityType: "budget",
            entityId: params.id,
            metadata: {
              eventId: result.id,
              month: result.month,
              thresholdType: result.thresholdType,
              thresholdPercent: result.thresholdPercent,
              note: result.note?.text ?? null,
              annotationId: result.note?.annotationId ?? null,
            },
          }),
        );
        return yield* respond(BudgetAlertNoteResult)(result);
      }),
    ),
);

export const budgetsDomain = makeDomain("budgets", BudgetsApi, BudgetsHandlers);
