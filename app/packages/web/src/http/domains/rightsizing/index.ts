/**
 * Right-sizing: `/api/org/:orgId/rightsizing`, the handler. Resources whose
 * plugin declares `rightsizing` and whose stored p95 CPU/memory over the last
 * 14 days sits under the thresholds, each matched with the cheapest catalog
 * size that still clears headroom. Recomputed on demand with a short
 * in-memory cache; `?refresh=true` bypasses it (the section's Refresh button).
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { RightsizingApi, RightsizingListResponse } from "@infrawrench/api-contract";
import { listRightsizing } from "../../../services/rightsizing";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const RightsizingHandlers = HttpApiBuilder.group(RightsizingApi, "rightsizing", (handlers) =>
  handlers.handle("list", ({ query }) =>
    Effect.gen(function* () {
      const { organizationId } = yield* OrgPrincipal;
      const refresh = query.refresh === "true";
      const list = yield* legacy(() => listRightsizing(organizationId, { refresh }));
      return yield* respond(RightsizingListResponse)(list);
    }),
  ),
);

export const rightsizingDomain = makeDomain("rightsizing", RightsizingApi, RightsizingHandlers);
