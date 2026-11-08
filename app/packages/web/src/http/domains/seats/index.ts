/**
 * SaaS seats: `/api/org/:orgId/seats`, the handlers.
 *
 * The list is server-core's computation over the stored inventory the
 * poller's seats pass collects (`seats/feed.ts`). Removal goes through the
 * plugin, behind the change freeze, and records the realized saving; it and
 * the threshold change are audited.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { listSeats } from "@infrawrench/server-core/seats/feed";
import { requestSeatRefresh } from "@infrawrench/server-core/seats/collect";
import { removeSeat, SeatRemovalError } from "@infrawrench/server-core/seats/remove";
import {
  checkInactiveDays,
  getSeatSettings,
  SeatSettingsError,
  updateSeatSettings,
} from "@infrawrench/server-core/seats/settings";
import { logAudit } from "../../../services/audit";
import { requireNoChangeFreeze } from "../../change-freeze";
import { makeDomain } from "../../domain";
import { BadRequest, HttpFailure } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { inputRefusal, invalidBody, readObjectBody } from "../../object-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  SeatListResponse,
  SeatRefreshResponse,
  SeatRemovalResponse,
  SeatsApi,
  SeatSettings,
} from "./api";

const SeatsHandlers = HttpApiBuilder.group(SeatsApi, "seats", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const seats = yield* legacy(() => listSeats(organizationId));
        return yield* respond(SeatListResponse)(seats);
      }),
    )
    /** Make every seat-capable account due for collection now. */
    .handle("refresh", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const queued = yield* legacy(() => requestSeatRefresh(organizationId));
        return yield* respond(SeatRefreshResponse)({ queued });
      }),
    )
    .handle("getSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getSeatSettings(organizationId));
        return yield* respond(SeatSettings)(settings);
      }),
    )
    .handleRaw("updateSettings", ({ request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* invalidBody(read.error);
        const raw = read.body["inactiveDays"];
        if (raw === undefined) return yield* invalidBody("No settings supplied");

        const { organizationId, session } = yield* OrgPrincipal;
        // server-core owns the bound and its sentence.
        const next = yield* legacyTry(
          async () => updateSeatSettings(organizationId, { inactiveDays: checkInactiveDays(raw) }),
          (error) =>
            error instanceof SeatSettingsError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "seats.settings_updated",
            entityType: "organization",
            entityId: organizationId,
            metadata: { inactiveDays: next.inactiveDays },
          }),
        );
        return yield* respond(SeatSettings)(next);
      }),
    )
    /** Remove a seat flagged as inactive or duplicated, through the plugin. */
    .handle("remove", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const seatId = params.seatId;
        yield* requireNoChangeFreeze(request, {
          action: "seat.remove",
          entityType: "seat",
          entityId: seatId,
        });
        const outcome = yield* legacyTry(
          () => removeSeat(organizationId, seatId, session.userId ?? null),
          (error) =>
            error instanceof SeatRemovalError && error.status !== 502
              ? inputRefusal({ status: error.status, message: error.message })
              : undefined,
        ).pipe(
          // The provider refusing the removal answers 502 with its sentence, as before.
          Effect.catchDefect((defect) =>
            Effect.die(
              defect instanceof SeatRemovalError
                ? new HttpFailure(defect.status, { error: defect.message })
                : defect,
            ),
          ),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "seat.removed",
            entityType: "seat",
            entityId: seatId,
            metadata: {
              accountId: outcome.seat.accountId,
              pluginId: outcome.seat.pluginId,
              product: outcome.seat.product,
              seatType: outcome.seat.seatType,
              memberId: outcome.seat.memberId,
              finding: outcome.finding.kind,
              effective: outcome.effective,
            },
          }),
        );
        return yield* respond(SeatRemovalResponse)({
          effective: outcome.effective,
          message: outcome.message,
        });
      }),
    ),
);

export const seatsDomain = makeDomain("seats", SeatsApi, SeatsHandlers);
