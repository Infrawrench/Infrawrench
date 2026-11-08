/**
 * Cost centres: `/api/org/:orgId/cost-centres`, the endpoint definitions.
 *
 * Cost centres and the allocation rules that map spend onto them for
 * showback. Reads ride `costs:read` like the rest of the cost surface;
 * mutations ride `costs:write` (this shapes what the whole org's spend reports
 * say, the same reasoning as anomaly settings). The bodies are the shared
 * schemas the cost centre editor validates with (`@infrawrench/ui/schemas`).
 *
 * The showback report itself (`GET /costs/showback`) is a cost read and lives
 * with the other `/costs` routes.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  AllocationRuleInput,
  AllocationRuleMatch,
  CostCentreInput,
  minLength,
} from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";

export const CostCentre = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  parentId: Schema.NullOr(Uuid).annotate({
    description:
      "The centre this one sits under; null is a top-level centre. Nesting is a reporting " +
      "structure only: allocation still resolves each cost row to exactly one centre.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "CostCentre" });

export const AllocationRule = Schema.Struct({
  id: Uuid,
  costCentreId: Uuid,
  priority: Schema.Int,
  match: AllocationRuleMatch,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "AllocationRule" });

/** A rule id: checked non-empty, as the route's validator did, and documented as the UUID it is. */
const RuleId = Schema.String.check(minLength(1)).annotate({ format: "uuid" });

export const SwapAllocationRulesBody = Schema.Struct({ aId: RuleId, bId: RuleId }).annotate({
  identifier: "SwapAllocationRulesBody",
  description: "Two allocation rule ids in the same org whose priorities should be swapped.",
});

export class CostCentresGroup extends HttpApiGroup.make("costCentres")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(CostCentre),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List cost centres")
      .annotate(SuccessDescription, "Cost centres, name-sorted"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CostCentreInput,
      success: CostCentre,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a cost centre")
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid cost centre"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: CostCentreInput,
      success: CostCentre,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update or move a cost centre")
      .annotate(
        OpenApi.Description,
        "Renames, redescribes, and/or moves a centre. Moving is `parentId` changing; omitting " +
          "the field leaves the centre where it is. 400 when the move would cycle or breach the " +
          "depth cap.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid cost centre"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a cost centre (its allocation rules go with it)")
      .annotate(
        OpenApi.Description,
        "The centre's allocation rules are deleted with it, so the spend they claimed falls " +
          'through to the next matching rule or to "Unallocated". Child centres are not deleted: ' +
          "they are re-parented onto the deleted centre's own parent (a root's children become " +
          "roots), so a subtree keeps its shape and no ancestor's subtree total moves unexpectedly.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("listRules", "/rules", {
      params: OrgParams,
      success: Schema.Array(AllocationRule),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List allocation rules in evaluation order")
      .annotate(SuccessDescription, "Rules, ascending priority"),
    HttpApiEndpoint.post("createRule", "/rules", {
      params: OrgParams,
      payload: AllocationRuleInput,
      success: AllocationRule,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create an allocation rule")
      .annotate(
        OpenApi.Description,
        "Maps spend onto a cost centre. Rules evaluate first-match-wins by ascending priority " +
          "against each cost row's tags, account, provider, and service.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid allocation rule"),
    HttpApiEndpoint.post("swapRules", "/rules/swap", {
      params: OrgParams,
      payload: SwapAllocationRulesBody,
      success: Schema.Array(AllocationRule),
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Swap the priorities of two allocation rules")
      .annotate(
        OpenApi.Description,
        "Atomically swaps priorities so first-match-wins order can be edited without a " +
          "half-applied pair of independent updates.",
      )
      .annotate(SuccessDescription, "Full rule list after the swap, evaluation order")
      .annotate(InvalidRequestMessage, "Invalid swap request"),
    HttpApiEndpoint.put("updateRule", "/rules/:id", {
      params: OrgIdParams,
      payload: AllocationRuleInput,
      success: AllocationRule,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update an allocation rule")
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid allocation rule"),
    HttpApiEndpoint.delete("deleteRule", "/rules/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete an allocation rule")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/cost-centres")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost Centres") {}

export class CostCentresApi extends withApiDefaults(
  HttpApi.make("cost-centres").add(CostCentresGroup),
) {}
