/**
 * Orphans: `/api/org/:orgId/orphans`, the handler. Likely-wasted resources
 * (unattached volumes, unassigned IPs, ...) grouped by account, classified by
 * each resource type's declarative orphanRule over already-synced state. No
 * provider API calls; the cost annotation is best-effort from collected rows.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { listOrphans } from "../../../services/orphans";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { holdsPermission, OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { OrphanListResponse, OrphansApi } from "./api";

const OrphansHandlers = HttpApiBuilder.group(OrphansApi, "orphans", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const { organizationId } = yield* OrgPrincipal;
      // The trailing spend is what the cost routes guard with `costs:read`:
      // without it the rows come back with `cost: null`, not a 403.
      const includeCosts = yield* holdsPermission("costs:read");
      const orphans = yield* legacy(() => listOrphans(organizationId, { includeCosts }));
      return yield* respond(OrphanListResponse)(orphans);
    }),
  ),
);

export const orphansDomain = makeDomain("orphans", OrphansApi, OrphansHandlers);
