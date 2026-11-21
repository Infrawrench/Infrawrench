/**
 * Live updates: `/api/org/:orgId/live`, the handler. A ticket names the driver
 * a client watches a topic with (client-core `live.ts`); the topics and their
 * change signals are server-core's `live/topics.ts`, the drivers
 * `live/backend.ts`.
 *
 * The gate is the topic's: the read permission of the list it signals,
 * checked here on every ticket, so a renewal after a role change is refused
 * the way the list itself would be. Sealing is local crypto, so this runs on
 * the edge like any other read.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type { LiveTopicParams } from "@infrawrench/client-core";
import { liveBackend } from "@infrawrench/server-core/live/backend";
import { liveTopicDefinition } from "@infrawrench/server-core/live/topics";
import { BadRequest, LiveApi, LiveTicket, NotFound } from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";

const LiveHandlers = HttpApiBuilder.group(LiveApi, "live", (handlers) =>
  handlers.handle("ticket", ({ payload }) =>
    Effect.gen(function* () {
      const { organizationId } = yield* OrgPrincipal;
      const definition = liveTopicDefinition(payload.topic);
      if (!definition) return yield* new BadRequest({ error: `Unknown topic: ${payload.topic}` });
      yield* requirePermission(definition.permission);

      const params: LiveTopicParams = {
        ...(payload.accountId !== undefined ? { accountId: payload.accountId } : {}),
        ...(payload.resourceId !== undefined ? { resourceId: payload.resourceId } : {}),
        ...(payload.workflowId !== undefined ? { workflowId: payload.workflowId } : {}),
      };
      const missing = definition.requires.filter((name) => !params[name]);
      if (missing.length > 0) {
        return yield* new BadRequest({
          error: `${payload.topic} needs ${missing.join(" and ")}`,
        });
      }

      const backend = liveBackend();
      // Polling seals nothing, so there is nothing to authorize.
      if (backend.kind === "poll") return yield* noStore(respond(LiveTicket)({ driver: "poll" }));

      const { authorize } = definition;
      if (authorize) {
        const allowed = yield* legacy(() => authorize(organizationId, params));
        if (!allowed) return yield* new NotFound({ error: "Not found" });
      }
      const ticket = yield* legacy(() => backend.ticket(definition.signal(organizationId, params)));
      return yield* noStore(respond(LiveTicket)(ticket));
    }),
  ),
);

/** A sealed query is a bearer credential: nothing on the way may keep a copy. */
const noStore = <E, R>(response: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.map(response, (r) => HttpServerResponse.setHeader(r, "cache-control", "no-store"));

export const liveDomain = makeDomain("live", LiveApi, LiveHandlers);
