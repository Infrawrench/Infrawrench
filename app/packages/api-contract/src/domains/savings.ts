/**
 * Realized savings: `/api/org/:orgId/savings`, the endpoint definitions.
 *
 * What the actions people took actually saved, measured against each
 * resource's own pre-action spend. Reads are `costs:read`. Logging, editing
 * and removing an entry, and the org's tuning, are `costs:write`: the same
 * permission that guards cost annotations, which every entry leaves on the
 * charts. The findings workflow under `/savings/findings` is its own domain.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  REALIZED_SAVINGS_BASES,
  SAVINGS_EVENT_KINDS,
  SAVINGS_EVENT_SOURCES,
} from "@infrawrench/client-core";
import {
  pattern,
  RealizedSavingsSettings,
  SavingsEventAnnotation,
  SavingsEventInput,
} from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams } from "../http/schemas/common";
import { documentedAs } from "../http/schemas/documented";

/** A UTC day; described before the check, which would otherwise drop the description. */
const day = (description?: string) =>
  Schema.String.annotate({
    examples: ["2026-07-15"],
    ...(description === undefined ? {} : { description }),
  }).check(pattern(/^\d{4}-\d{2}-\d{2}$/));

const IsoDay = day();

const money = (description = "Currency units (not cents), in the row's currency.") =>
  Schema.Finite.annotate({ description });

const Money = money();

const SavingsEventKind = Schema.Literals(SAVINGS_EVENT_KINDS).annotate({
  identifier: "SavingsEventKind",
  description:
    "`rightsizing`: a resize to a smaller size; `orphan_deletion`: a resource the orphan " +
    "finder flags was deleted; `sleep_schedule`: a stretch of a sleep/wake schedule in force; " +
    "`commitment`: reservation and savings-plan discounts, derived from billing; `manual`: " +
    "logged by a person.",
});

const SavingsEventSource = Schema.Literals(SAVINGS_EVENT_SOURCES).annotate({
  identifier: "SavingsEventSource",
  description:
    "`in_app`: recorded when Infrawrench performed the action; `detected`: inferred from an " +
    "inventory diff on sync (the action was taken in the provider's console); `manual`; " +
    "`derived`: computed from billing with no stored event (commitments).",
});

const RealizedSavingsBasis = Schema.Literals(REALIZED_SAVINGS_BASES).annotate({
  identifier: "RealizedSavingsBasis",
  description:
    "`billing`: baseline and post-action spend both read from this resource's cost rows; " +
    "`estimate`: no per-resource billing, so the list-price estimate is accrued over elapsed " +
    "days; `manual`: the logged amount accrued; `unmeasured`: nothing to measure against " +
    "(never summed as zero).",
});

const SavingsShortfall = Schema.Struct({
  kind: Schema.Literals(["below_projection", "grew_back"]).annotate({
    description:
      "`below_projection`: the trailing realized rate is under the org's threshold share of " +
      "the projected rate; `grew_back`: post-action spend is above the pre-action baseline.",
  }),
  realizedPerDay: Money,
  projectedPerDay: Schema.NullOr(Money),
}).annotate({ identifier: "SavingsShortfall" });

const eventFields = {
  id: Schema.String.annotate({
    description: "A UUID for stored events; `commitment:<accountId>:<currency>` for derived rows.",
  }),
  kind: SavingsEventKind,
  source: SavingsEventSource,
  title: Schema.String,
  note: Schema.NullOr(Schema.String),
  occurredOn: day("The day the action took effect (UTC)."),
  endedOn: Schema.NullOr(IsoDay).annotate({
    description: "Last day in force, inclusive; null while it still is.",
  }),
  accountId: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  pluginId: Schema.NullOr(Schema.String),
  resourceTypeId: Schema.NullOr(Schema.String),
  resourceId: Schema.NullOr(Schema.String).annotate({
    description: "Kept after the resource is deleted.",
  }),
  resourceName: Schema.NullOr(Schema.String),
  costCentreId: Schema.NullOr(Schema.String).annotate({
    description: "Explicit attribution; null means attributed by the allocation rules.",
  }),
  projectedMonthlyAmount: Schema.NullOr(Money).annotate({
    description: "What the action was projected to save per month.",
  }),
  currency: Schema.NullOr(Schema.String),
  horizonMonths: Schema.NullOr(Schema.Int).annotate({
    description: "Per-entry horizon override; null uses the org setting.",
  }),
  costAnnotationId: Schema.NullOr(Schema.String).annotate({
    description: "The cost annotation marking the action on charts.",
  }),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

export const SavingsEvent = Schema.Struct(eventFields).annotate({ identifier: "SavingsEvent" });

const SavingsEventResult = Schema.Struct({
  ...eventFields,
  basis: RealizedSavingsBasis,
  status: Schema.Literals(["pending", "accruing", "complete", "ended"]),
  realizedCurrency: Schema.NullOr(Schema.String),
  baselinePerDay: Schema.NullOr(Money).annotate({
    description: "Spend per day before the action.",
  }),
  currentPerDay: Schema.NullOr(Money).annotate({
    description: "Spend per day over the trailing measured days since.",
  }),
  realizedToDate: Schema.NullOr(Money),
  realizedInRange: Schema.NullOr(Money),
  projectedInRange: Schema.NullOr(Money).annotate({
    description: "Projected over the same accrued days in the range.",
  }),
  accruedDays: Schema.Int,
  horizonEndsOn: Schema.NullOr(IsoDay).annotate({
    description: "Last day a one-off action accrues on; null for recurring ones.",
  }),
  attributedCostCentreId: Schema.NullOr(Schema.String),
  attributedCostCentreName: Schema.NullOr(Schema.String),
  shortfall: Schema.NullOr(SavingsShortfall),
  editable: Schema.Literals(["full", "annotate", "none"]).annotate({
    description:
      "`full`: a manual entry (PUT); `annotate`: an automatic event takes a note, a cost " +
      "centre, a horizon and an end date (PATCH); `none`: derived rows.",
  }),
}).annotate({ identifier: "SavingsEventResult" });

const Total = Schema.Struct({
  currency: Schema.String,
  realized: Money,
  projected: Money,
}).annotate({ identifier: "RealizedSavingsTotal" });

const Bucket = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  currency: Schema.String,
  realized: Money,
  projected: Money,
  events: Schema.Int,
}).annotate({ identifier: "RealizedSavingsBucket" });

const Month = Schema.Struct({
  month: Schema.String.annotate({ description: "YYYY-MM" }),
  currency: Schema.String,
  realized: Money,
  projected: Money,
}).annotate({ identifier: "RealizedSavingsMonth" });

export const RealizedSavingsReport = Schema.Struct({
  from: IsoDay,
  to: IsoDay,
  settings: RealizedSavingsSettings,
  totals: Schema.Array(Total),
  byMonth: Schema.Array(Month),
  byKind: Schema.Array(Bucket),
  byCostCentre: Schema.Array(Bucket),
  byAccount: Schema.Array(Bucket),
  events: Schema.Array(SavingsEventResult),
  shortfallCount: Schema.Int,
  unmeasuredCount: Schema.Int,
}).annotate({ identifier: "RealizedSavingsReport" });

export { RealizedSavingsSettings };

export class SavingsGroup extends HttpApiGroup.make("savings")
  .add(
    HttpApiEndpoint.get("realized", "/realized", {
      params: OrgParams,
      // Read as sent: an empty value means the default, and the report owns the range check.
      query: {
        from: Schema.optionalKey(
          documentedAs(
            day("Inclusive first day. Defaults to the first of the month 11 months back."),
          ),
        ),
        to: Schema.optionalKey(documentedAs(day("Inclusive last day. Defaults to yesterday."))),
      },
      success: RealizedSavingsReport,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Realized savings report")
      .annotate(
        OpenApi.Description,
        "What the actions taken actually saved, against each resource's own trailing daily spend " +
          "before the action, accrued day by day (one-off actions up to the horizon). Recomputed on " +
          "every read, so figures improve as restated billing lands. Days collection has not " +
          "covered are not accrued. Per-currency throughout; never converted or merged.",
      )
      .annotate(SuccessDescription, "The report"),
    HttpApiEndpoint.post("createEvent", "/events", {
      params: OrgParams,
      payload: SavingsEventInput,
      success: SavingsEvent,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Log a saving")
      .annotate(
        OpenApi.Description,
        "Record a saving by hand, with the monthly amount and the day it began. Leaves an org-wide " +
          "cost annotation on that day. Requires `costs:write`.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid saving"),
    HttpApiEndpoint.put("updateEvent", "/events/:id", {
      params: OrgIdParams,
      payload: SavingsEventInput,
      success: SavingsEvent,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Rewrite a manual saving")
      .annotate(
        OpenApi.Description,
        "Full replace of a manual entry. Automatic events are a 400; use PATCH.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid saving"),
    HttpApiEndpoint.patch("annotateEvent", "/events/:id", {
      params: OrgIdParams,
      payload: SavingsEventAnnotation,
      success: SavingsEvent,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Annotate a saving")
      .annotate(
        OpenApi.Description,
        "Add context to any event: a note, an explicit cost centre, a horizon override, or an end " +
          "date. The facts of an automatic event (what was done, when, the projection) stay as observed.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid change"),
    HttpApiEndpoint.delete("deleteEvent", "/events/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Remove a saving")
      .annotate(
        OpenApi.Description,
        "Hard delete, together with the cost annotation the event left on the charts.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: RealizedSavingsSettings,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get realized savings settings")
      .annotate(
        OpenApi.Description,
        "The org's horizon, shortfall threshold and baseline window; defaults when never saved.",
      )
      .annotate(SuccessDescription, "Settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: RealizedSavingsSettings,
      success: RealizedSavingsSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update realized savings settings")
      .annotate(
        OpenApi.Description,
        "Requires `costs:write`. Changes every figure in the report, retroactively.",
      )
      .annotate(SuccessDescription, "Saved")
      .annotate(InvalidRequestMessage, "Invalid savings settings"),
  )
  .prefix("/api/org/:orgId/savings")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Realized savings") {}

export class SavingsApi extends withApiDefaults(HttpApi.make("savings").add(SavingsGroup)) {}
