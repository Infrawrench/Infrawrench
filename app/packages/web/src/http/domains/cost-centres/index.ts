/**
 * Cost centres: `/api/org/:orgId/cost-centres`, the handlers. The logic lives
 * in server-core's `cost/allocation`, run through `legacy` inside the
 * request's scopes.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  AllocationRuleError,
  CostCentreError,
  createAllocationRule,
  createCostCentre,
  deleteAllocationRule,
  deleteCostCentre,
  listAllocationRules,
  listCostCentres,
  swapAllocationRulePriorities,
  updateAllocationRule,
  updateCostCentre,
} from "@infrawrench/server-core/cost/allocation";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { AllocationRule, CostCentre, CostCentresApi } from "./api";

/**
 * A rejected placement (unknown parent, past the depth cap) is the caller's
 * mistake and carries the same message the UI greys the option out with.
 */
const centreRefusal = (error: unknown) =>
  error instanceof CostCentreError ? new BadRequest({ error: error.message }) : undefined;

const ruleRefusal = (error: unknown) =>
  error instanceof AllocationRuleError ? new BadRequest({ error: error.message }) : undefined;

const CostCentresHandlers = HttpApiBuilder.group(CostCentresApi, "costCentres", (handlers) =>
  handlers
    /**
     * Flat on the wire, with `parentId` on each row: clients build the tree
     * themselves, exactly like cost-report folders. A nested payload would
     * make "list the centres for a picker" the hard case.
     */
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const centres = yield* legacy(() => listCostCentres(organizationId));
        return yield* respond(Schema.Array(CostCentre))(centres);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const centre = yield* legacyTry(
          () => createCostCentre(organizationId, payload),
          centreRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_centre.create",
            entityType: "cost_centre",
            entityId: centre.id,
            metadata: { name: centre.name, parentId: centre.parentId },
          }),
        );
        return yield* respond(CostCentre)(centre);
      }),
    )
    // A move is this same update with a different `parentId`; omitting the
    // field leaves the centre where it is.
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const centre = yield* legacyTry(
          () => updateCostCentre(organizationId, params.id, payload),
          centreRefusal,
        );
        if (!centre) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_centre.update",
            entityType: "cost_centre",
            entityId: centre.id,
            metadata: { name: centre.name, parentId: centre.parentId },
          }),
        );
        return yield* respond(CostCentre)(centre);
      }),
    )
    // Children are re-parented onto the deleted centre's own parent, never
    // deleted and never promoted to the root; spend history is untouched.
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => deleteCostCentre(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_centre.delete",
            entityType: "cost_centre",
            entityId: params.id,
          }),
        );
        return ok;
      }),
    )
    .handle("listRules", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rules = yield* legacy(() => listAllocationRules(organizationId));
        return yield* respond(Schema.Array(AllocationRule))(rules);
      }),
    )
    .handle("swapRules", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        if (payload.aId === payload.bId) {
          return yield* badRequest("Cannot swap a rule with itself");
        }
        const rules = yield* legacy(() =>
          swapAllocationRulePriorities(organizationId, payload.aId, payload.bId),
        );
        if (!rules) return yield* notFound("One or both rules not found");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_allocation_rule.swap",
            entityType: "cost_allocation_rule",
            entityId: payload.aId,
            metadata: { aId: payload.aId, bId: payload.bId },
          }),
        );
        return yield* respond(Schema.Array(AllocationRule))(rules);
      }),
    )
    .handle("createRule", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        // Any other failure was answered as a 400 too, after logging it.
        const rule = yield* legacyTry(
          () => createAllocationRule(organizationId, payload),
          (error) => {
            const refusal = ruleRefusal(error);
            if (refusal) return refusal;
            console.error("[cost-centres] Failed to create allocation rule:", error);
            return new BadRequest({ error: "Failed to create allocation rule" });
          },
        );
        if (!rule) return yield* notFound("Cost centre not found");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_allocation_rule.create",
            entityType: "cost_allocation_rule",
            entityId: rule.id,
            metadata: { costCentreId: rule.costCentreId, match: rule.match },
          }),
        );
        return yield* respond(AllocationRule)(rule);
      }),
    )
    .handle("updateRule", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const rule = yield* legacyTry(
          () => updateAllocationRule(organizationId, params.id, payload),
          ruleRefusal,
        );
        if (!rule) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_allocation_rule.update",
            entityType: "cost_allocation_rule",
            entityId: rule.id,
            metadata: { costCentreId: rule.costCentreId, match: rule.match },
          }),
        );
        return yield* respond(AllocationRule)(rule);
      }),
    )
    .handle("deleteRule", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => deleteAllocationRule(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_allocation_rule.delete",
            entityType: "cost_allocation_rule",
            entityId: params.id,
          }),
        );
        return ok;
      }),
    ),
);

export const costCentresDomain = makeDomain("cost-centres", CostCentresApi, CostCentresHandlers);
