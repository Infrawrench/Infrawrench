/**
 * Scenario models: `/api/org/:orgId/cost-scenarios`, the endpoint definitions.
 *
 * A scenario model is a named, reusable set of adjustments an org overlays on
 * a cost forecast: the known future cost a trend fit cannot see. Charts,
 * reports and budgets reference one by id; the reference is resolved
 * server-side at query time, so editing the model here changes every
 * projection built on it.
 *
 * Reads are `costs:read` and writes `costs:write`, like saved filters and
 * reports: a scenario is a statement about cost data, not dashboard
 * furniture. DELETE is refused with a 409 (body carries `referents`) while
 * anything still points at the model. The body is the shared schema the
 * scenario editor validates with (`@infrawrench/ui/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { CostScenarioAdjustment, CostScenarioModelInput } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";

export const CostScenarioModel = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  currency: Schema.String.annotate({
    description: "The one currency every amount in this model is denominated in.",
  }),
  adjustments: Schema.Array(CostScenarioAdjustment),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CostScenarioModel" });

export const CostScenarioModelList = Schema.Struct({ models: Schema.Array(CostScenarioModel) });

export const CostScenarioReferent = Schema.Struct({
  kind: Schema.Literals(["budget", "cost_report", "cost_graph_widget", "cost_forecast"]),
  id: Uuid.annotate({ description: "Budget id, report id, or dashboard-widget id." }),
  name: Schema.String,
  dashboardId: Schema.optionalKey(
    Uuid.annotate({ description: "Set for `cost_graph_widget` referents." }),
  ),
  dashboardName: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CostScenarioReferent" });

export const CostScenarioReferents = Schema.Struct({
  referents: Schema.Array(CostScenarioReferent),
});

/** A name collision: names are unique per organization, case-insensitively. */
export class CostScenarioNameTaken extends Schema.Error<CostScenarioNameTaken>(
  "infrawrench/http/costScenarios/NameTaken",
)(
  { error: Schema.String },
  {
    httpApiStatus: 409,
    identifier: "CostScenarioNameConflict",
    description: "A live scenario model already uses this name.",
  },
) {}

/** Refused while referenced; the body names every referent. */
export class CostScenarioInUse extends Schema.Error<CostScenarioInUse>(
  "infrawrench/http/costScenarios/InUse",
)(
  { error: Schema.String, referents: Schema.Array(CostScenarioReferent) },
  {
    httpApiStatus: 409,
    identifier: "CostScenarioInUse",
    description: "Still referenced: the body lists every referent.",
  },
) {}

export class CostScenariosGroup extends HttpApiGroup.make("costScenarios")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: CostScenarioModelList,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List scenario models")
      .annotate(
        OpenApi.Description,
        "Named, reusable sets of adjustments an organization overlays on a cost forecast; the " +
          "**known future cost a trend fit cannot see**. Pass an id as `POST /costs/query`'s " +
          "`scenarioModelId` (alongside `forecast: true`) to get the adjusted projection back " +
          "*beside* the unadjusted one, never instead of it.",
      )
      .annotate(SuccessDescription, "Scenario models, alphabetically"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CostScenarioModelInput,
      success: CostScenarioModel,
      error: [BadRequest, CostScenarioNameTaken],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a scenario model")
      .annotate(
        OpenApi.Description,
        "Names must be unique per organization (case-insensitively); the name is what a chart " +
          "prints under its scenario line and what the CLI's `--scenario <name>` addresses, so two " +
          "models sharing one would make both meaningless. A model needs at least one adjustment: " +
          "an empty model changes nothing, which is the same as applying no scenario.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid scenario model"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: CostScenarioModel,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a scenario model")
      .annotate(SuccessDescription, "Scenario model"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: CostScenarioModelInput,
      success: CostScenarioModel,
      error: [BadRequest, NotFound, CostScenarioNameTaken],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update a scenario model")
      .annotate(
        OpenApi.Description,
        "Replaces the whole model. This is the high-leverage write: every chart drawing it, and " +
          "**every budget whose forecast thresholds are measured against it**, uses the new " +
          "numbers on its next evaluation; which for a budget can change which alerts fire. " +
          "`GET /{id}/referents` names what a change will touch.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid scenario model"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [NotFound, CostScenarioInUse],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a scenario model")
      .annotate(
        OpenApi.Description,
        "Soft delete: **refused with a 409 while anything references the model**, with the " +
          "referents in the body. For a chart, deleting would silently drop the assumptions from a " +
          "projection somebody is reading; for a budget it would move the forecast thresholds back " +
          "to the bare trend, changing when people get paged. Detaching the referents is a " +
          "deliberate step, never a side effect of deletion.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("referents", "/:id/referents", {
      params: OrgIdParams,
      success: CostScenarioReferents,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List a scenario model's referents")
      .annotate(
        OpenApi.Description,
        "Every budget, cost report and dashboard cost graph referencing this model; what an " +
          "edit will change, and what a delete would be refused over. Budgets come first: they are " +
          "the referents that page people.",
      )
      .annotate(SuccessDescription, "Referents (empty when nothing references the model)"),
  )
  .prefix("/api/org/:orgId/cost-scenarios")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Scenario models") {}

export class CostScenariosApi extends withApiDefaults(
  HttpApi.make("cost-scenarios").add(CostScenariosGroup),
) {}
