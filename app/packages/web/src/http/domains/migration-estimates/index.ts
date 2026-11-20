/**
 * Migration estimates: `/api/org/:orgId/migration-estimates`, the handlers.
 *
 * Transport only: the matching and pricing is the server-core service, the
 * pure parts are in client-core, storage is server-core's store. Every call
 * that reaches a plugin (price catalogs, size pickers, estimates, Terraform)
 * runs inside one `legacy` call so the egress scope covers it, and the
 * current-cost read runs in the caller's cost visibility scope.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  createMigrationEstimate,
  deleteMigrationEstimate,
  getMigrationEstimate,
  getMigrationEstimateService,
  listMigrationEstimates,
  MigrationEstimateInputError,
  MigrationEstimateLimitError,
  MigrationEstimateSourceNotFoundError,
  updateMigrationEstimate,
} from "@infrawrench/server-core/migration-estimate";
import {
  migrationScenarioInput,
  type MigrationEstimate as MigrationEstimateRecord,
  type MigrationEstimateInput,
} from "@infrawrench/client-core";
import {
  badRequest,
  MigrationEstimate,
  MigrationEstimateResult,
  MigrationEstimatesApi,
  MigrationScenarioCreated,
  MigrationTargets,
  MigrationTerraformResult,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import {
  CostScenarioLimitError,
  CostScenarioNameConflictError,
  createCostScenarioModel,
} from "../../../services/cost-scenarios";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** The request names something the estimate cannot use (HTTP 400). */
class EstimateRefused extends Schema.TaggedError<EstimateRefused>()("EstimateRefused", {
  message: Schema.String,
}) {}

/** The source (a service) does not exist (HTTP 404). */
class SourceMissing extends Schema.TaggedError<SourceMissing>()("SourceMissing", {
  message: Schema.String,
}) {}

/** The service's thrown errors, as typed failures at the promise boundary. */
const estimating = <A>(run: () => Promise<A>) =>
  legacyTry(run, (error) =>
    error instanceof MigrationEstimateInputError ||
    error instanceof MigrationEstimateLimitError ||
    error instanceof CostScenarioNameConflictError ||
    error instanceof CostScenarioLimitError
      ? new EstimateRefused({ message: error.message })
      : error instanceof MigrationEstimateSourceNotFoundError
        ? new SourceMissing({ message: error.message })
        : undefined,
  );

const refusedAsBadRequest = (refusal: EstimateRefused) => Effect.fail(badRequest(refusal.message));
const missingAsNotFound = (missing: SourceMissing) => Effect.fail(notFound(missing.message));

const audit = Effect.fn("migrationEstimates.audit")(function* (
  action: "create" | "update" | "delete" | "scenario",
  estimateId: string,
  metadata: Record<string, unknown>,
) {
  const { organizationId, session } = yield* OrgPrincipal;
  yield* fireAndForget(() =>
    logAudit({
      organizationId,
      userId: session.userId,
      action: `migration_estimate.${action}`,
      entityType: "migration_estimate",
      entityId: estimateId,
      metadata,
    }),
  );
});

/** A target the estimate can price on; checked before anything is stored. */
const checkTarget = Effect.fn("migrationEstimates.checkTarget")(function* (pluginId: string) {
  const { organizationId } = yield* OrgPrincipal;
  const targets = yield* legacy(() => getMigrationEstimateService().targets(organizationId));
  if (!targets.some((t) => t.pluginId === pluginId)) {
    return yield* new EstimateRefused({
      message: `"${pluginId}" is not a provider an estimate can target.`,
    });
  }
});

const inputOf = (record: MigrationEstimateRecord): MigrationEstimateInput => ({
  name: record.name,
  source: record.source,
  targetPluginId: record.targetPluginId,
  targetRegion: record.targetRegion,
  overrides: record.overrides,
});

const loadSaved = Effect.fn("migrationEstimates.loadSaved")(function* (id: string) {
  const { organizationId } = yield* OrgPrincipal;
  const saved = yield* legacy(() => getMigrationEstimate(organizationId, id));
  if (!saved) return yield* notFound();
  return saved;
});

const MigrationEstimatesHandlers = HttpApiBuilder.group(
  MigrationEstimatesApi,
  "migrationEstimates",
  Effect.fn(function* (handlers) {
    return handlers.handleAll({
      targets: Effect.fn("migrationEstimates.targets")(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const providers = yield* legacy(() =>
          getMigrationEstimateService().targets(organizationId),
        );
        return yield* respond(MigrationTargets)({ providers });
      }),
      preview: Effect.fn("migrationEstimates.preview")(
        function* ({ payload }) {
          const { organizationId } = yield* OrgPrincipal;
          const result = yield* estimating(() =>
            getMigrationEstimateService().compute(organizationId, payload),
          );
          return yield* respond(MigrationEstimateResult)(result);
        },
        Effect.catchTag("EstimateRefused", refusedAsBadRequest),
        Effect.catchTag("SourceMissing", missingAsNotFound),
      ),
      list: Effect.fn("migrationEstimates.list")(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const estimates = yield* legacy(() => listMigrationEstimates(organizationId));
        return yield* respond(Schema.Array(MigrationEstimate))(estimates);
      }),
      create: Effect.fn("migrationEstimates.create")(
        function* ({ payload }) {
          const { organizationId, session } = yield* OrgPrincipal;
          yield* checkTarget(payload.targetPluginId);
          const created = yield* estimating(() =>
            createMigrationEstimate(organizationId, payload, session.userId ?? null),
          );
          yield* audit("create", created.id, {
            name: created.name,
            targetPluginId: created.targetPluginId,
          });
          return yield* respond(MigrationEstimate)(created);
        },
        Effect.catchTag("EstimateRefused", refusedAsBadRequest),
        Effect.catchTag("SourceMissing", missingAsNotFound),
      ),
      get: Effect.fn("migrationEstimates.get")(function* ({ params }) {
        const saved = yield* loadSaved(params.id);
        return yield* respond(MigrationEstimate)(saved);
      }),
      update: Effect.fn("migrationEstimates.update")(
        function* ({ params, payload }) {
          const { organizationId } = yield* OrgPrincipal;
          yield* checkTarget(payload.targetPluginId);
          const updated = yield* legacy(() =>
            updateMigrationEstimate(organizationId, params.id, payload),
          );
          if (!updated) return yield* notFound();
          yield* audit("update", updated.id, {
            name: updated.name,
            targetPluginId: updated.targetPluginId,
          });
          return yield* respond(MigrationEstimate)(updated);
        },
        Effect.catchTag("EstimateRefused", refusedAsBadRequest),
      ),
      delete: Effect.fn("migrationEstimates.delete")(function* ({ params }) {
        const { organizationId } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => deleteMigrationEstimate(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* audit("delete", params.id, {});
        return ok;
      }),
      result: Effect.fn("migrationEstimates.result")(
        function* ({ params }) {
          const { organizationId } = yield* OrgPrincipal;
          const saved = yield* loadSaved(params.id);
          const result = yield* estimating(() =>
            getMigrationEstimateService().compute(organizationId, inputOf(saved), {
              estimateId: saved.id,
            }),
          );
          return yield* respond(MigrationEstimateResult)(result);
        },
        Effect.catchTag("EstimateRefused", refusedAsBadRequest),
        Effect.catchTag("SourceMissing", missingAsNotFound),
      ),
      terraform: Effect.fn("migrationEstimates.terraform")(
        function* ({ params }) {
          const { organizationId } = yield* OrgPrincipal;
          const saved = yield* loadSaved(params.id);
          const terraform = yield* estimating(async () => {
            const service = getMigrationEstimateService();
            const result = await service.compute(organizationId, inputOf(saved), {
              estimateId: saved.id,
            });
            return service.terraform(result);
          });
          if (!terraform) {
            return yield* badRequest("The target provider has no Terraform export.");
          }
          return yield* respond(MigrationTerraformResult)(terraform);
        },
        Effect.catchTag("EstimateRefused", refusedAsBadRequest),
        Effect.catchTag("SourceMissing", missingAsNotFound),
      ),
      scenario: Effect.fn("migrationEstimates.scenario")(
        function* ({ params, payload }) {
          const { organizationId, session } = yield* OrgPrincipal;
          const saved = yield* loadSaved(params.id);
          const result = yield* estimating(() =>
            getMigrationEstimateService().compute(organizationId, inputOf(saved), {
              estimateId: saved.id,
            }),
          );
          const input = migrationScenarioInput(result, {
            name: payload.name,
            startDate: payload.startDate,
          });
          if (!input) {
            return yield* badRequest(
              "This estimate has no single-currency change to state: no row is priced on both " +
                "sides, or the figures are in currencies without an exchange rate.",
            );
          }
          const model = yield* estimating(() =>
            createCostScenarioModel(organizationId, input, session.userId ?? null),
          );
          yield* audit("scenario", saved.id, { scenarioModelId: model.id });
          return yield* respond(MigrationScenarioCreated)({
            scenarioModelId: model.id,
            name: model.name,
            currency: model.currency,
            monthlyDelta: result.totals.comparable?.pairedDelta ?? 0,
          });
        },
        Effect.catchTag("EstimateRefused", refusedAsBadRequest),
        Effect.catchTag("SourceMissing", missingAsNotFound),
      ),
    });
  }),
);

export const migrationEstimatesDomain = makeDomain(
  "migration-estimates",
  MigrationEstimatesApi,
  MigrationEstimatesHandlers,
);
