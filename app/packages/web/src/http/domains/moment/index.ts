/**
 * The moment view: `GET /api/org/:orgId/moment`, the handler. Thin: the
 * union itself (nine feeds, per-feed permission gating, per-feed
 * partial-failure tolerance) lives in `services/moment.ts`, shared with the
 * `what_changed` MCP tool.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { badRequest, MomentApi, MomentResponse } from "@infrawrench/api-contract";
import {
  computeMoment,
  MOMENT_FEED_PERMISSIONS,
  parseMomentTimestamp,
} from "../../../services/moment";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { missingPermission, OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const MomentHandlers = HttpApiBuilder.group(MomentApi, "moment", (handlers) =>
  handlers.handle("get", ({ query }) =>
    Effect.gen(function* () {
      const { organizationId, permissions } = yield* OrgPrincipal;
      // A caller who can read nothing gets the same 403 the change feed gives.
      const anyFeedReadable = Object.values(MOMENT_FEED_PERMISSIONS).some((permission) =>
        hasPermission(permissions, permission),
      );
      if (!anyFeedReadable) return yield* missingPermission("resources:read");

      let at: Date | undefined;
      if (query.at !== undefined) {
        // Offset-less timestamps are pinned to UTC (shared with `what_changed`)
        // so the same URL means the same window wherever the server runs.
        const parsed = parseMomentTimestamp(query.at);
        if (parsed === null) return yield* badRequest("Invalid 'at' timestamp");
        at = parsed;
      }
      let windowMinutes: number | undefined;
      if (query.window !== undefined) {
        windowMinutes = Number.parseInt(query.window, 10);
        if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
          return yield* badRequest("Invalid 'window': expected a positive number of minutes");
        }
      }

      const response = yield* legacy(() =>
        computeMoment(organizationId, { at, windowMinutes, permissions }),
      );
      return yield* respond(MomentResponse)(response);
    }),
  ),
);

export const momentDomain = makeDomain("moment", MomentApi, MomentHandlers);
