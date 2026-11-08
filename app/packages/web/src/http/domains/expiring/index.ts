/**
 * Expiry radar: `/api/org/:orgId/expiring`, the handlers.
 *
 * The feed is assembled in server-core (`expiry/feed.ts`) so the web API, the
 * MCP tool, the weekly digest and the poller's alert pass share one
 * computation: a read over already-synced state, no provider API calls.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { listExpiring } from "@infrawrench/server-core/expiry/feed";
import {
  getExpirySettings,
  updateExpirySettings,
  type ExpirySettingsPatch,
  type ExpirySettingsRecord,
} from "@infrawrench/server-core/expiry/settings";
import {
  BadRequest,
  badRequest,
  ExpiringApi,
  ExpiryAlertSettings,
  ExpiryListResponse,
} from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy, legacyTry } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

function toWire(s: ExpirySettingsRecord) {
  return {
    enabled: s.enabled,
    leadDays: s.leadDays,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

const ExpiringHandlers = HttpApiBuilder.group(ExpiringApi, "expiring", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const feed = yield* legacy(() => listExpiring(organizationId));
        return yield* respond(ExpiryListResponse)(feed);
      }),
    )
    .handle("getSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getExpirySettings(organizationId));
        return yield* respond(ExpiryAlertSettings)(toWire(settings));
      }),
    )
    /**
     * Every field is optional so a single toggle can be saved on its own.
     * Bounds live in server-core so the API and the poller cannot disagree
     * about a valid lead time. `lastNotifiedAt` is the poller's cooldown claim.
     */
    .handleRaw("updateSettings", ({ request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const patch: ExpirySettingsPatch = {};
        const enabled = body["enabled"];
        if (enabled !== undefined) {
          if (!Predicate.isBoolean(enabled)) return yield* badRequest("enabled must be a boolean");
          patch.enabled = enabled;
        }
        const leadDays = body["leadDays"];
        if (leadDays !== undefined) {
          if (!Predicate.isNumber(leadDays)) return yield* badRequest("leadDays must be a number");
          patch.leadDays = leadDays;
        }
        if (Object.keys(patch).length === 0) return yield* badRequest("No settings supplied");

        const { organizationId } = yield* OrgPrincipal;
        const saved = yield* legacyTry(
          () => updateExpirySettings(organizationId, patch),
          (error) =>
            new BadRequest({
              error:
                error instanceof Error ? error.message : "Failed to save expiry alert settings",
            }),
        );
        return yield* respond(ExpiryAlertSettings)(toWire(saved));
      }),
    ),
);

export const expiringDomain = makeDomain("expiring", ExpiringApi, ExpiringHandlers);
