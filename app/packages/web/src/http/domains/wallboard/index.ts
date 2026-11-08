/**
 * Wallboard: `/api/org/:orgId/wallboard`, the handler. Purely a read over
 * already-stored state (`server-core/wallboard/feed.ts`): no provider API calls.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { getWallboard } from "@infrawrench/server-core/wallboard/feed";
import { WallboardApi, WallboardResponse } from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const WallboardHandlers = HttpApiBuilder.group(WallboardApi, "wallboard", (handlers) =>
  handlers.handle("get", () =>
    Effect.gen(function* () {
      const { organizationId } = yield* OrgPrincipal;
      const wall = yield* legacy(() => getWallboard(organizationId));
      return yield* respond(WallboardResponse)(wall);
    }),
  ),
);

export const wallboardDomain = makeDomain("wallboard", WallboardApi, WallboardHandlers);
