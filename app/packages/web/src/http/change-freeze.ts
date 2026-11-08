/**
 * The org change freeze, for HttpApi handlers. Call it after resolving and
 * authorizing the target and before the mutation. A freeze in effect fails with the 423
 * {@link ChangeFreezeBlocked}, unless the caller holds `freezes:override` and
 * sent `x-change-freeze-override: true`; blocks and overrides are both
 * audit-logged by the service.
 */
import { Effect } from "effect";
import type { HttpServerRequest } from "effect/http";
import { ChangeFreezeBlocked } from "@infrawrench/api-contract";
import {
  CHANGE_FREEZE_OVERRIDE_HEADER,
  evaluateChangeFreeze,
  type FreezeAuditTarget,
} from "../services/change-freezes";
import { legacy } from "./legacy";
import { OrgPrincipal } from "./principal";

export const requireNoChangeFreeze = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  target: FreezeAuditTarget,
) {
  const { organizationId, session, permissions } = yield* OrgPrincipal;
  const blocked = yield* legacy(() =>
    evaluateChangeFreeze(
      {
        organizationId,
        userId: session.userId,
        permissions,
        overrideHeader: request.headers[CHANGE_FREEZE_OVERRIDE_HEADER],
      },
      target,
    ),
  );
  if (blocked) return yield* new ChangeFreezeBlocked(blocked);
});
