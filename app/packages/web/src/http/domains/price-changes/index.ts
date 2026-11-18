/**
 * Price changes: `/api/org/:orgId/price-changes`, the handlers.
 *
 * The org list reads what the poller's daily scan stored
 * (`server-core/price-changes/`); the catalog list reads the pricing
 * warehouse directly, cached for an hour. Neither runs plugin code, so both
 * serve from the edge.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { PRICE_CHANGE_LIMITS } from "@infrawrench/client-core";
import {
  listCatalogPriceChanges,
  listPriceChanges,
} from "@infrawrench/server-core/price-changes/feed";
import {
  getPriceChangeSettings,
  PriceChangeSettingsError,
  updatePriceChangeSettings,
  type PriceChangeSettingsRecord,
} from "@infrawrench/server-core/price-changes/settings";
import {
  BadRequest,
  badRequest,
  CatalogPriceChangeResponse,
  notFound,
  PriceChangeListResponse,
  PriceChangesApi,
  PriceChangeScenarioResponse,
  PriceChangeSettings,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import {
  createPriceChangeScenario,
  PriceChangeScenarioError,
} from "../../../services/price-change-scenario";
import { CostScenarioLimitError } from "../../../services/cost-scenarios";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

function toWire(s: PriceChangeSettingsRecord) {
  return {
    enabled: s.enabled,
    minMonthlyImpactCents: s.minMonthlyImpactCents,
    minPercent: s.minPercent,
    registerExpected: s.registerExpected,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

/** A whole number of days within `bounds`, the default when absent, or a 400. */
const parseDays = Effect.fnUntraced(function* (
  raw: string | undefined,
  bounds: { min: number; max: number; default: number },
) {
  if (raw === undefined || raw === "") return bounds.default;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < bounds.min || days > bounds.max) {
    return yield* badRequest(`days must be a whole number from ${bounds.min} to ${bounds.max}`);
  }
  return days;
});

const PriceChangesHandlers = HttpApiBuilder.group(PriceChangesApi, "priceChanges", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const days = yield* parseDays(query.days, PRICE_CHANGE_LIMITS.listDays);
        const list = yield* legacy(() => listPriceChanges(organizationId, { days }));
        return yield* respond(PriceChangeListResponse)(list);
      }),
    )
    .handle("catalog", ({ query }) =>
      Effect.gen(function* () {
        const days = yield* parseDays(query.days, PRICE_CHANGE_LIMITS.catalogDays);
        const platform = query.platform?.trim() || undefined;
        if (platform !== undefined && !/^[a-z0-9-]{1,40}$/.test(platform)) {
          return yield* badRequest("platform must be a warehouse platform id such as ec2");
        }
        const list = yield* legacy(() =>
          listCatalogPriceChanges({ days, ...(platform ? { platform } : {}) }),
        );
        return yield* respond(CatalogPriceChangeResponse)(list);
      }),
    )
    .handle("getSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getPriceChangeSettings(organizationId));
        return yield* respond(PriceChangeSettings)(toWire(settings));
      }),
    )
    .handle("updateSettings", ({ payload }) =>
      Effect.gen(function* () {
        if (Object.keys(payload).length === 0) return yield* badRequest("No settings supplied");
        const { organizationId, session } = yield* OrgPrincipal;
        const saved = yield* legacyTry(
          () => updatePriceChangeSettings(organizationId, payload),
          (error) =>
            error instanceof PriceChangeSettingsError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "price_change_settings.update",
            entityType: "price_change_settings",
            entityId: organizationId,
            metadata: { ...payload },
          }),
        );
        return yield* respond(PriceChangeSettings)(toWire(saved));
      }),
    )
    .handle("createScenario", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const result = yield* legacyTry(
          () => createPriceChangeScenario(organizationId, params.changeId, session.userId ?? null),
          (error) =>
            error instanceof PriceChangeScenarioError || error instanceof CostScenarioLimitError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        if (!result) return yield* notFound("Price change not found");
        if (result.created) {
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_scenario.create",
              entityType: "cost_scenario",
              entityId: result.scenarioModelId,
              metadata: { priceChangeId: params.changeId },
            }),
          );
        }
        return yield* respond(PriceChangeScenarioResponse)(result);
      }),
    ),
);

export const priceChangesDomain = makeDomain(
  "priceChanges",
  PriceChangesApi,
  PriceChangesHandlers,
);
