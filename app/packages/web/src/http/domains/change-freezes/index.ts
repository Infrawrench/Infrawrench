/**
 * Change freezes: `/api/org/:orgId/change-freezes`, the handlers.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  badRequest,
  ChangeFreeze,
  ChangeFreezesApi,
  ChangeFreezeStatus,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import {
  createChangeFreeze,
  deleteChangeFreeze,
  endChangeFreeze,
  getActiveChangeFreeze,
  listChangeFreezes,
  updateChangeFreeze,
  type ChangeFreezeInput,
  type ChangeFreezeRow,
} from "../../../services/change-freezes";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

function toWire(freeze: ChangeFreezeRow) {
  return {
    id: freeze.id,
    name: freeze.name,
    reason: freeze.reason,
    startsAt: freeze.startsAt.toISOString(),
    endsAt: freeze.endsAt ? freeze.endsAt.toISOString() : null,
    active: freeze.active,
    createdByUserId: freeze.createdByUserId,
    endedByUserId: freeze.endedByUserId,
    createdAt: freeze.createdAt.toISOString(),
    updatedAt: freeze.updatedAt.toISOString(),
  };
}

/** The decoded body as the service's input, refusing a window that ends before it starts. */
const freezeInput = Effect.fnUntraced(function* (body: {
  readonly name: string;
  readonly reason?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
}) {
  const startsAt = body.startsAt ? new Date(body.startsAt) : undefined;
  const endsAt = body.endsAt ? new Date(body.endsAt) : undefined;
  if (endsAt && endsAt <= (startsAt ?? new Date())) {
    return yield* badRequest("endsAt must be after startsAt");
  }
  const input: ChangeFreezeInput = {
    name: body.name,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
  };
  return input;
});

const ChangeFreezesHandlers = HttpApiBuilder.group(ChangeFreezesApi, "changeFreezes", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const freezes = yield* legacy(() => listChangeFreezes(organizationId));
        return yield* respond(Schema.Array(ChangeFreeze))(freezes.map(toWire));
      }),
    )
    .handle("status", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const freeze = yield* legacy(() => getActiveChangeFreeze(organizationId));
        return yield* respond(ChangeFreezeStatus)({ freeze: freeze ? toWire(freeze) : null });
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* freezeInput(payload);
        const freeze = yield* legacy(() =>
          createChangeFreeze(organizationId, input, session.userId ?? null),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "change_freeze.create",
            entityType: "change_freeze",
            entityId: freeze.id,
            metadata: {
              name: freeze.name,
              startsAt: freeze.startsAt.toISOString(),
              endsAt: freeze.endsAt ? freeze.endsAt.toISOString() : null,
            },
          }),
        );
        return yield* respond(ChangeFreeze)(toWire(freeze));
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* freezeInput(payload);
        const freeze = yield* legacy(() => updateChangeFreeze(organizationId, params.id, input));
        if (!freeze) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "change_freeze.update",
            entityType: "change_freeze",
            entityId: freeze.id,
            metadata: {
              name: freeze.name,
              endsAt: freeze.endsAt ? freeze.endsAt.toISOString() : null,
            },
          }),
        );
        return yield* respond(ChangeFreeze)(toWire(freeze));
      }),
    )
    .handle("end", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const freeze = yield* legacy(() =>
          endChangeFreeze(organizationId, params.id, session.userId ?? null),
        );
        if (!freeze) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "change_freeze.end",
            entityType: "change_freeze",
            entityId: freeze.id,
            metadata: { name: freeze.name },
          }),
        );
        return yield* respond(ChangeFreeze)(toWire(freeze));
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => deleteChangeFreeze(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "change_freeze.delete",
            entityType: "change_freeze",
            entityId: params.id,
          }),
        );
        return ok;
      }),
    ),
);

export const changeFreezesDomain = makeDomain(
  "change-freezes",
  ChangeFreezesApi,
  ChangeFreezesHandlers,
);
