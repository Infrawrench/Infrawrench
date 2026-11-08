/**
 * Provider status correlation: `/api/org/:orgId/status-incidents`, the
 * handler.
 *
 * All the work (matching cached provider incidents against the org's
 * resources, counting overlapping changes) lives in server-core
 * `status/match.ts` so the poller's notifier, the MCP tool, and this route
 * share one implementation.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { getOrgStatusIncidents } from "@infrawrench/server-core/status/match";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { OrgStatusIncidentsResponse, StatusIncidentsApi } from "./api";

const StatusIncidentsHandlers = HttpApiBuilder.group(
  StatusIncidentsApi,
  "statusIncidents",
  (handlers) =>
    handlers.handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const incidents = yield* legacy(() => getOrgStatusIncidents(organizationId));
        return yield* respond(OrgStatusIncidentsResponse)({ incidents });
      }),
    ),
);

export const statusIncidentsDomain = makeDomain(
  "status-incidents",
  StatusIncidentsApi,
  StatusIncidentsHandlers,
);
