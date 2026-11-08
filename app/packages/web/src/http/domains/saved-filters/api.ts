/**
 * Saved cost filters: `/api/org/:orgId/saved-cost-filters`, the endpoint
 * definitions.
 *
 * A saved filter is a named, reusable `CostFilter[]` that graphs, reports and
 * budgets reference by id; the reference is resolved server-side at query
 * time, so editing the filter changes every referent at once. Reads are
 * `costs:read` and writes `costs:write`, like cost reports. DELETE is refused
 * with a 409 (body carries `referents`) while anything still points at the
 * filter. The body is the shared schema the filter editor validates with
 * (`@infrawrench/ui/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { SavedCostFilterInput, SavedCostFilterTerm } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";

export const SavedCostFilter = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  filters: Schema.Array(SavedCostFilterTerm),
  query: Schema.String.annotate({
    description: "The canonical cost-query-language rendering of `filters`, derived server-side.",
  }),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "SavedCostFilter" });

export const SavedCostFilterReferent = Schema.Struct({
  kind: Schema.Literals(["budget", "cost_report", "cost_graph_widget", "cost_visibility_scope"]),
  id: Uuid.annotate({ description: "Budget id, report id, or dashboard-widget id." }),
  name: Schema.String.annotate({ description: "Budget name, report name, or the widget's title." }),
  dashboardId: Schema.optionalKey(
    Uuid.annotate({ description: "Set for `cost_graph_widget` referents." }),
  ),
  dashboardName: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SavedCostFilterReferent" });

export const SavedCostFilterReferents = Schema.Struct({
  referents: Schema.Array(SavedCostFilterReferent),
});

/** A name collision: names are unique per organization, case-insensitively. */
export class SavedCostFilterNameTaken extends Schema.Error<SavedCostFilterNameTaken>(
  "infrawrench/http/savedCostFilters/NameTaken",
)(
  { error: Schema.String },
  {
    httpApiStatus: 409,
    identifier: "SavedCostFilterNameConflict",
    description: "A live saved filter already uses this name.",
  },
) {}

/** Refused while referenced; the body names every referent. */
export class SavedCostFilterInUse extends Schema.Error<SavedCostFilterInUse>(
  "infrawrench/http/savedCostFilters/InUse",
)(
  { error: Schema.String, referents: Schema.Array(SavedCostFilterReferent) },
  {
    httpApiStatus: 409,
    identifier: "SavedCostFilterInUse",
    description: "Still referenced: the body lists every referent.",
  },
) {}

export class SavedCostFiltersGroup extends HttpApiGroup.make("savedCostFilters")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(SavedCostFilter),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List saved cost filters")
      .annotate(
        OpenApi.Description,
        "Named, reusable cost filter sets. Graphs, reports and budgets reference one **by id** " +
          "(`savedFilterId` in their configs and in `POST /costs/query`), and the server resolves " +
          "the reference at query time; so editing a saved filter changes every referent at once, " +
          "and nothing ever holds a copy.",
      )
      .annotate(SuccessDescription, "Saved filters, alphabetically"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: SavedCostFilterInput,
      success: SavedCostFilter,
      error: [BadRequest, SavedCostFilterNameTaken],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a saved cost filter")
      .annotate(
        OpenApi.Description,
        "Names must be unique per organization (case-insensitively); they are how the CLI's " +
          "`--filter <name>` and humans address the filter. A name collision is a 409.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid saved filter"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: SavedCostFilter,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a saved cost filter")
      .annotate(SuccessDescription, "Saved filter"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: SavedCostFilterInput,
      success: SavedCostFilter,
      error: [BadRequest, NotFound, SavedCostFilterNameTaken],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update a saved cost filter")
      .annotate(
        OpenApi.Description,
        "Replaces the filter's name, description and terms. This is the high-leverage write: " +
          "every graph, report and budget referencing the filter runs the new terms on its next " +
          "query: re-scoping a referenced budget can change which alerts fire. " +
          "`GET /{id}/referents` names what a change will touch.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid saved filter"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [NotFound, SavedCostFilterInUse],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a saved cost filter")
      .annotate(
        OpenApi.Description,
        "Soft delete: **refused with a 409 while anything references the filter**, with the " +
          "referents in the body. Deleting a referenced filter would silently widen every " +
          "referent's scope to all spend; for a budget that can fire or suppress alerts, so " +
          "detaching the referents is a deliberate step, never a side effect of deletion.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("referents", "/:id/referents", {
      params: OrgIdParams,
      success: SavedCostFilterReferents,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List a saved filter's referents")
      .annotate(
        OpenApi.Description,
        "Every budget, cost report and dashboard cost graph referencing this filter; what an " +
          "edit will re-scope, and what a delete would be refused over.",
      )
      .annotate(SuccessDescription, "Referents (empty when nothing references the filter)"),
  )
  .prefix("/api/org/:orgId/saved-cost-filters")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Saved cost filters") {}

export class SavedCostFiltersApi extends withApiDefaults(
  HttpApi.make("saved-cost-filters").add(SavedCostFiltersGroup),
) {}
