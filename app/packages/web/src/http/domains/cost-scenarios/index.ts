/**
 * Scenario models: `/api/org/:orgId/cost-scenarios`, the handlers.
 *
 * The logic lives in services/cost-scenarios.ts so the MCP tools drive
 * exactly the same code path; these handlers are transport only. See that
 * service for why a referenced model cannot be deleted.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  BadRequest,
  CostScenarioModel,
  CostScenarioModelList,
  CostScenarioNameTaken,
  CostScenarioReferents,
  CostScenariosApi,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import {
  CostScenarioInUseError,
  CostScenarioLimitError,
  CostScenarioNameConflictError,
  createCostScenarioModel,
  getCostScenarioModel,
  listCostScenarioModels,
  listCostScenarioReferents,
  softDeleteCostScenarioModel,
  updateCostScenarioModel,
} from "../../../services/cost-scenarios";
import { makeDomain } from "../../domain";
import { HttpFailure } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/**
 * A write, its refusals mapped as the Hono route's `writeError` did: a name
 * collision is a 409, and any other error the service throws (the limits, the
 * per-kind field rules) a 400 with its message.
 */
const scenarioWrite = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(fn, (error) => {
    if (error instanceof CostScenarioNameConflictError) {
      return new CostScenarioNameTaken({ error: error.message });
    }
    if (error instanceof CostScenarioLimitError) return new BadRequest({ error: error.message });
    if (error instanceof Error) return new BadRequest({ error: error.message });
    return undefined;
  });

const CostScenariosHandlers = HttpApiBuilder.group(CostScenariosApi, "costScenarios", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const models = yield* legacy(() => listCostScenarioModels(organizationId));
        return yield* respond(CostScenarioModelList)({ models });
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* scenarioWrite(() =>
          createCostScenarioModel(organizationId, payload, session.userId ?? null),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_scenario.create",
            entityType: "cost_scenario",
            entityId: created.id,
            metadata: { name: created.name, adjustments: created.adjustments.length },
          }),
        );
        return yield* respond(CostScenarioModel)(created);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const model = yield* legacy(() => getCostScenarioModel(organizationId, params.id));
        if (!model) return yield* notFound();
        return yield* respond(CostScenarioModel)(model);
      }),
    )
    /**
     * Replace the whole model. The high-leverage write: every chart drawing
     * this model and every budget measuring its forecast thresholds against it
     * uses the new numbers on its next evaluation. The audit entry records the
     * adjustment count and the currency for that reason: "who changed the
     * assumptions the prod budget pages on" has to be answerable.
     */
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const updated = yield* scenarioWrite(() =>
          updateCostScenarioModel(organizationId, params.id, payload),
        );
        if (!updated) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_scenario.update",
            entityType: "cost_scenario",
            entityId: updated.id,
            metadata: {
              name: updated.name,
              currency: updated.currency,
              adjustments: updated.adjustments.length,
            },
          }),
        );
        return yield* respond(CostScenarioModel)(updated);
      }),
    )
    /**
     * Soft delete, refused with a 409 while any budget, report or dashboard
     * graph references the model; the body lists the referents. Neither
     * dropping a chart's assumptions nor moving a budget's thresholds is ever
     * a side effect of a delete.
     */
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(async () => {
          try {
            return await softDeleteCostScenarioModel(organizationId, params.id);
          } catch (error) {
            // The referents ride an already-shaped response, exactly as the service gave them.
            if (error instanceof CostScenarioInUseError) {
              throw new HttpFailure(409, { error: error.message, referents: error.referents });
            }
            throw error;
          }
        });
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_scenario.delete",
            entityType: "cost_scenario",
            entityId: params.id,
            metadata: {},
          }),
        );
        return ok;
      }),
    )
    /**
     * Every budget, report and dashboard graph referencing this model. What a
     * delete would be refused over, and what an editor names before letting
     * somebody change the assumptions.
     */
    .handle("referents", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const model = yield* legacy(() => getCostScenarioModel(organizationId, params.id));
        if (!model) return yield* notFound();
        const referents = yield* legacy(() => listCostScenarioReferents(organizationId, params.id));
        return yield* respond(CostScenarioReferents)({ referents });
      }),
    ),
);

export const costScenariosDomain = makeDomain(
  "cost-scenarios",
  CostScenariosApi,
  CostScenariosHandlers,
);
