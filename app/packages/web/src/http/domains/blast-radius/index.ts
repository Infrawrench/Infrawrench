/**
 * Blast radius: `/api/org/:orgId/blast-radius`, the handlers.
 *
 * The handler never fails for a partial answer; the service turns each
 * unavailable source into an entry in the report's `unchecked` list instead.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { badRequest, BlastRadiusApi, BlastRadiusReport } from "@infrawrench/api-contract";
import { getBlastRadius } from "../../../services/blast-radius";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const BlastRadiusHandlers = HttpApiBuilder.group(BlastRadiusApi, "blastRadius", (handlers) =>
  handlers.handle("get", ({ query }) =>
    Effect.gen(function* () {
      const resourceId = query.resourceId.trim();
      if (!resourceId) return yield* badRequest("Missing resourceId");
      const { organizationId } = yield* OrgPrincipal;
      const report = yield* legacy(() => getBlastRadius(organizationId, resourceId));
      return yield* respond(BlastRadiusReport)(report);
    }),
  ),
);

export const blastRadiusDomain = makeDomain("blast-radius", BlastRadiusApi, BlastRadiusHandlers);
