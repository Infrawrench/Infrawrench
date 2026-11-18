/**
 * Quota radar: `/api/org/:orgId/quotas`, the handlers.
 *
 * The feed is assembled in server-core (`quotas/feed.ts`) so the web API, the
 * weekly digest and the poller's alert pass share one computation, and so
 * the page's severity buckets and the alert's are the same code. No provider
 * API calls happen here: the collection is the poller's `quotas/collect.ts`.
 * The feed carries the per-account collection status and the plugins that
 * cannot report quotas, because `rows: []` alone cannot tell "nothing is near
 * a limit" from "every collection is failing".
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { getQuotaFeed } from "@infrawrench/server-core/quotas/feed";
import { getResourceRunway, getRunwayFeed } from "@infrawrench/server-core/capacity/feed";
import {
  getQuotaSettings,
  updateQuotaSettings,
  type QuotaSettingsPatchInput,
  type QuotaSettingsRecord,
} from "@infrawrench/server-core/quotas/settings";
import {
  BadRequest,
  badRequest,
  QuotaAlertSettings,
  QuotaListResponse,
  QuotasApi,
  ResourceRunwayResponse,
  RunwayListResponse,
} from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy, legacyTry } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

function toWire(s: QuotaSettingsRecord) {
  return {
    enabled: s.enabled,
    threshold: s.threshold,
    runwayDays: s.runwayDays,
    allowanceThreshold: s.allowanceThreshold,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

const QuotasHandlers = HttpApiBuilder.group(QuotasApi, "quotas", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const feed = yield* legacy(() => getQuotaFeed(organizationId));
        return yield* respond(QuotaListResponse)(feed);
      }),
    )
    .handle("runway", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const feed = yield* legacy(() => getRunwayFeed(organizationId));
        return yield* respond(RunwayListResponse)(feed);
      }),
    )
    .handle("resourceRunway", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const runway = yield* legacy(() => getResourceRunway(organizationId, query.resourceId));
        return yield* respond(ResourceRunwayResponse)(runway);
      }),
    )
    .handle("getSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getQuotaSettings(organizationId));
        return yield* respond(QuotaAlertSettings)(toWire(settings));
      }),
    )
    /**
     * Every field is optional so a single toggle can be saved on its own.
     * Server-core owns the bounds and *rejects* rather than clamps: a form
     * that silently shows 0.5 after the user typed 0.4 reads as the setting
     * not having saved. `lastNotifiedAt` is the poller's cooldown claim.
     */
    .handleRaw("updateSettings", ({ request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const patch: QuotaSettingsPatchInput = {};
        const enabled = body["enabled"];
        if (enabled !== undefined) {
          if (!Predicate.isBoolean(enabled)) return yield* badRequest("enabled must be a boolean");
          patch.enabled = enabled;
        }
        const threshold = body["threshold"];
        if (threshold !== undefined) {
          if (!Predicate.isNumber(threshold)) {
            return yield* badRequest("threshold must be a number");
          }
          patch.threshold = threshold;
        }
        const runwayDays = body["runwayDays"];
        if (runwayDays !== undefined) {
          if (!Predicate.isNumber(runwayDays)) {
            return yield* badRequest("runwayDays must be a number");
          }
          patch.runwayDays = runwayDays;
        }
        const allowanceThreshold = body["allowanceThreshold"];
        if (allowanceThreshold !== undefined) {
          if (!Predicate.isNumber(allowanceThreshold)) {
            return yield* badRequest("allowanceThreshold must be a number");
          }
          patch.allowanceThreshold = allowanceThreshold;
        }
        if (Object.keys(patch).length === 0) return yield* badRequest("No settings supplied");

        // An API key's caller may name nobody; `updated_by_user_id` is a
        // nullable FK so that records "changed, by nobody we can name".
        const { organizationId, session } = yield* OrgPrincipal;
        const saved = yield* legacyTry(
          () => updateQuotaSettings(organizationId, patch, session.userId),
          (error) =>
            new BadRequest({
              error: error instanceof Error ? error.message : "Failed to save quota alert settings",
            }),
        );
        return yield* respond(QuotaAlertSettings)(toWire(saved));
      }),
    ),
);

export const quotasDomain = makeDomain("quotas", QuotasApi, QuotasHandlers);
