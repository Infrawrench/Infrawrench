/**
 * Extended support: `/api/org/:orgId/extended-support`, the handlers.
 *
 * The list is server-core's computation over synced versions plus the billed
 * overlay (`services/extended-support.ts`). `?refresh=true` bypasses the short
 * billing cache; any other value reads it.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  ExtendedSupportSettingsError,
  getExtendedSupportSettings,
  updateExtendedSupportSettings,
  type ExtendedSupportSettingsPatch,
  type ExtendedSupportSettingsRecord,
} from "@infrawrench/server-core/extended-support/settings";
import { listExtendedSupportWithBilling } from "../../../services/extended-support";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest } from "../../errors";
import { legacy, legacyTry } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ExtendedSupportApi, ExtendedSupportListResponse, ExtendedSupportSettings } from "./api";

function toWire(s: ExtendedSupportSettingsRecord) {
  return {
    enabled: s.enabled,
    leadDays: s.leadDays,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

const ExtendedSupportHandlers = HttpApiBuilder.group(
  ExtendedSupportApi,
  "extendedSupport",
  (handlers) =>
    handlers
      .handle("list", ({ query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const refresh = query.refresh === "true";
          const list = yield* legacy(() =>
            listExtendedSupportWithBilling(organizationId, { refresh }),
          );
          return yield* respond(ExtendedSupportListResponse)(list);
        }),
      )
      .handle("getSettings", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const settings = yield* legacy(() => getExtendedSupportSettings(organizationId));
          return yield* respond(ExtendedSupportSettings)(toWire(settings));
        }),
      )
      /** Every field optional, so one toggle can be saved alone. `lastNotifiedAt` is the poller's. */
      .handleRaw("updateSettings", ({ request }) =>
        Effect.gen(function* () {
          const read = yield* readObjectBody(request);
          if (!read.ok) return yield* badRequest(read.error);
          const body = read.body;
          const patch: ExtendedSupportSettingsPatch = {};
          const enabled = body["enabled"];
          if (enabled !== undefined) {
            if (!Predicate.isBoolean(enabled)) {
              return yield* badRequest("enabled must be a boolean");
            }
            patch.enabled = enabled;
          }
          const leadDays = body["leadDays"];
          if (leadDays !== undefined) {
            if (!Predicate.isNumber(leadDays)) {
              return yield* badRequest("leadDays must be a number");
            }
            patch.leadDays = leadDays;
          }
          if (Object.keys(patch).length === 0) return yield* badRequest("No settings supplied");

          const { organizationId } = yield* OrgPrincipal;
          const saved = yield* legacyTry(
            () => updateExtendedSupportSettings(organizationId, patch),
            (error) =>
              error instanceof ExtendedSupportSettingsError
                ? new BadRequest({ error: error.message })
                : undefined,
          );
          return yield* respond(ExtendedSupportSettings)(toWire(saved));
        }),
      ),
);

export const extendedSupportDomain = makeDomain(
  "extendedSupport",
  ExtendedSupportApi,
  ExtendedSupportHandlers,
);
