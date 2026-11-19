/**
 * Heartbeat monitors: `/api/org/:orgId/heartbeats`, the handlers, plus the
 * public ping URL (`./ping.ts`). The deadline sweep runs in the poller
 * (`server-core/src/heartbeats/pass.ts`); these manage the rows, read the ping
 * history, and mine scheduled resources from the fields plugins flag.
 */
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  HeartbeatInputError,
  createHeartbeatRecord,
  deleteHeartbeatRecord,
  listHeartbeatPings,
  listHeartbeatRecords,
  rotateHeartbeatToken,
  toWireHeartbeat,
  updateHeartbeatRecord,
  type HeartbeatRecord,
} from "@infrawrench/server-core/heartbeats/store";
import { listHeartbeatSuggestions } from "@infrawrench/server-core/heartbeats/suggestions";
import {
  Heartbeat,
  HeartbeatList,
  HeartbeatPings,
  HeartbeatsApi,
  HeartbeatSuggestions,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { inputRefusals, refusalCall, refusalsOf } from "../../refusals";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { HeartbeatPingHandlers } from "./ping";

const heartbeatStore = refusalsOf(HeartbeatInputError, {
  logPrefix: "[heartbeats]",
  failure: "Heartbeat operation failed",
});

/**
 * Audit one write. The ping token is deliberately absent from the metadata:
 * it is a credential, and the audit log is readable by every admin.
 */
const audit = Effect.fn("heartbeats.audit")(function* (
  action: string,
  row: HeartbeatRecord,
  metadata: Record<string, unknown> = {},
) {
  const { organizationId, session } = yield* OrgPrincipal;
  yield* fireAndForget(() =>
    logAudit({
      organizationId,
      userId: session.userId,
      action,
      entityType: "heartbeat",
      entityId: row.id,
      metadata: { name: row.name, ...metadata },
    }),
  );
});

const HeartbeatsHandlers = HttpApiBuilder.group(HeartbeatsApi, "heartbeats", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rows = yield* legacy(() => listHeartbeatRecords(organizationId));
        return yield* respond(HeartbeatList)({ heartbeats: rows.map(toWireHeartbeat) });
      }),
    )
    .handle("suggestions", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const suggestions = yield* legacy(() =>
          listHeartbeatSuggestions(
            organizationId,
            query.resourceId ? { resourceId: query.resourceId } : {},
          ),
        );
        return yield* respond(HeartbeatSuggestions)({ suggestions });
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* refusalCall(heartbeatStore, inputRefusals, () =>
          createHeartbeatRecord(organizationId, payload, session.userId),
        );
        yield* audit("heartbeat.create", created, {
          scheduleKind: created.scheduleKind,
          cronExpression: created.cronExpression,
          intervalMinutes: created.intervalMinutes,
          graceMinutes: created.graceMinutes,
          resourceId: created.resourceId,
        });
        return yield* respond(Heartbeat, { status: 201 })(toWireHeartbeat(created));
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const updated = yield* refusalCall(heartbeatStore, inputRefusals, () =>
          updateHeartbeatRecord(organizationId, params.heartbeatId, payload),
        );
        yield* audit("heartbeat.update", updated, { patch: { ...payload } });
        return yield* respond(Heartbeat)(toWireHeartbeat(updated));
      }),
    )
    .handle("rotateToken", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rotated = yield* refusalCall(heartbeatStore, inputRefusals, () =>
          rotateHeartbeatToken(organizationId, params.heartbeatId),
        );
        yield* audit("heartbeat.rotate_token", rotated);
        return yield* respond(Heartbeat)(toWireHeartbeat(rotated));
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const deleted = yield* refusalCall(heartbeatStore, inputRefusals, () =>
          deleteHeartbeatRecord(organizationId, params.heartbeatId),
        );
        yield* audit("heartbeat.delete", deleted);
      }),
    )
    .handle("pings", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const pings = yield* refusalCall(heartbeatStore, inputRefusals, () =>
          listHeartbeatPings(organizationId, params.heartbeatId, query.limit ?? 100),
        );
        return yield* respond(HeartbeatPings)({ pings });
      }),
    ),
);

export const heartbeatsDomain = makeDomain(
  "heartbeats",
  HeartbeatsApi,
  Layer.mergeAll(HeartbeatsHandlers, HeartbeatPingHandlers),
);
