/**
 * Virtual tags: `/api/org/:orgId/virtual-tags`, the endpoint definitions.
 *
 * The org's rule-based computed tags. Reads ride `costs:read`, like every cost
 * surface: a virtual tag is part of the explanation for every figure grouped
 * or filtered by it. Writes ride `costs:write`, the scope cost centres and
 * allocation rules already use: a virtual tag adds a way to slice spend and
 * never changes how much there is (splits are weighted so totals are
 * conserved), which is the line between `costs:write` and the
 * `org:settings:write` that billing rules need.
 *
 * The body is the shared schema the virtual tag editor validates with
 * (`@infrawrench/ui/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { IsoDate, VirtualTagInput, VirtualTagRule } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";

const VirtualTagCurrencyStats = Schema.Struct({
  currency: Schema.String,
  total: Schema.Finite,
  unmatched: Schema.Finite.annotate({ description: "Spend no rule matched." }),
  byRule: Schema.Array(Schema.Finite).annotate({
    description: "Spend each rule claimed, in rule order.",
  }),
  topValues: Schema.Array(Schema.Struct({ value: Schema.String, amount: Schema.Finite })),
}).annotate({ identifier: "VirtualTagCurrencyStats" });

export const VirtualTagStats = Schema.Struct({
  from: Schema.NullOr(IsoDate),
  to: Schema.NullOr(IsoDate),
  currencies: Schema.Array(VirtualTagCurrencyStats),
  metricFallbackDays: Schema.Int.annotate({
    description: "Days a metric split carried weights forward or split evenly.",
  }),
  distinctValues: Schema.Int,
}).annotate({ identifier: "VirtualTagStats" });

export const VirtualTag = Schema.Struct({
  id: Uuid,
  key: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  defaultValue: Schema.NullOr(Schema.String),
  rules: Schema.Array(VirtualTagRule),
  status: Schema.Struct({
    state: Schema.Literals(["pending", "processing", "ready", "failed"]),
    processedAt: Schema.NullOr(IsoDateTime),
    error: Schema.NullOr(Schema.String),
    stats: Schema.NullOr(VirtualTagStats),
  }).annotate({
    description:
      "The background evaluation over stored history. Queries never wait on it: a saved rule " +
      "applies to every read immediately; this is the account of what the rules do.",
  }),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "VirtualTag" });

export class VirtualTagsGroup extends HttpApiGroup.make("virtualTags")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(VirtualTag),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List virtual tags")
      .annotate(
        OpenApi.Description,
        "Virtual tags are tags the organisation computes from its own ordered rules: merge " +
          "`env`/`Environment`/`ENV` into one key, assign values by any cost filter, split shared " +
          "spend by percentage or by a business metric, with optional start and end dates per " +
          "rule. They work as the `virtual_tag` cost dimension everywhere a tag does.\n\n" +
          "**They are computed at query time and never written into stored cost data**, and " +
          "splits are weighted so a total never changes.",
      )
      .annotate(SuccessDescription, "Virtual tags, by key"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: VirtualTagInput,
      success: VirtualTag,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a virtual tag")
      .annotate(
        OpenApi.Description,
        "Queues the background evaluation over stored history at once.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid virtual tag"),
    HttpApiEndpoint.post("preview", "/preview", {
      params: OrgParams,
      payload: VirtualTagInput,
      success: VirtualTagStats,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Preview an unsaved virtual tag")
      .annotate(
        OpenApi.Description,
        "Evaluates a definition over the trailing 30 days without storing it: spend per rule, " +
          "unmatched spend and the top values. Validates exactly as a save would.",
      )
      .annotate(SuccessDescription, "Evaluation")
      .annotate(InvalidRequestMessage, "Invalid virtual tag"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: VirtualTag,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a virtual tag")
      .annotate(SuccessDescription, "The tag"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: VirtualTagInput,
      success: VirtualTag,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update a virtual tag")
      .annotate(
        OpenApi.Description,
        "A full replace, rule order included. The key cannot change (400). Saving re-queues the " +
          "background evaluation.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid virtual tag"),
    HttpApiEndpoint.post("reprocess", "/:id/reprocess", {
      params: OrgIdParams,
      success: VirtualTag,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Re-run a virtual tag's evaluation")
      .annotate(SuccessDescription, "Queued"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [NotFound, Conflict],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a virtual tag")
      .annotate(
        OpenApi.Description,
        "Refused with a 409 that names every other virtual tag, saved filter, budget, report, dashboard card, " +
          "change alert, allocation rule, cost export or business metric still referencing the " +
          "key: deleting it would make those fail rather than quietly widen to all spend.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/virtual-tags")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Virtual Tags") {}

export class VirtualTagsApi extends withApiDefaults(
  HttpApi.make("virtual-tags").add(VirtualTagsGroup),
) {}
