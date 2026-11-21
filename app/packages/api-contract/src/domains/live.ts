/**
 * Live updates: the endpoint definitions.
 *
 * One route hands out tickets for live-update topics (client-core `live.ts`
 * has the design); the handler owns the gate. A ticket for the `neon` driver carries a sealed,
 * 60-second Neon Realtime capability: a bearer credential, so the route is a
 * POST and the answer is never cached. The gate depends on the topic, so it is
 * listed in the topic's description rather than as `x-required-permission`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { LIVE_TOPICS } from "@infrawrench/client-core";
import { SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { OrgParams } from "../http/schemas/common";

export const LiveTopicName = Schema.Literals(LIVE_TOPICS).annotate({
  description:
    "What to watch. `jit-requests` and `access-requests` need `access:read`, " +
    "`workflow-approvals` `workflows:read`, `change-freezes` `freezes:read`, " +
    "`account-resources` (with `accountId`) and `resource` (with `resourceId`) " +
    "`resources:read`, and `ci-runs` `ci:read`.",
});

export const LiveTicketRequest = Schema.Struct({
  topic: LiveTopicName,
  accountId: Schema.optionalKey(
    Schema.String.annotate({ description: "The account, for `account-resources`." }),
  ),
  resourceId: Schema.optionalKey(
    Schema.String.annotate({ description: "The resource, for `resource`." }),
  ),
  workflowId: Schema.optionalKey(
    Schema.String.annotate({
      description: "Narrow `workflow-approvals` to one workflow's pending approvals.",
    }),
  ),
}).annotate({ identifier: "LiveTicketRequest" });

export const LiveSealedQuery = Schema.Struct({
  capability: Schema.String.annotate({
    description: "Opaque encrypted capability. A bearer credential: keep it out of URLs and logs.",
  }),
  queryFingerprint: Schema.String.annotate({
    description: "Stable identity of the query; a renewal carries the same one.",
  }),
  expiresAt: Schema.Finite.annotate({
    description: "Unix milliseconds. Ask for a fresh ticket shortly before this to renew.",
  }),
}).annotate({ identifier: "LiveSealedQuery" });

export const LiveTicket = Schema.Union([
  Schema.Struct({
    driver: Schema.Literal("poll").annotate({
      description: "No push channel is configured: refetch on your own interval.",
    }),
  }),
  Schema.Struct({
    driver: Schema.Literal("neon").annotate({
      description:
        "Subscribe to `query` at `url` with the Neon Realtime client and refetch whenever its " +
        "result changes. The result carries ids and statuses only, never the data itself.",
    }),
    url: Schema.String.annotate({ description: "The Neon Realtime WebSocket URL." }),
    query: LiveSealedQuery,
  }),
]).annotate({
  identifier: "LiveTicket",
  description:
    "How to learn that a topic changed. Clients should treat an unknown `driver` as `poll`.",
});

export class LiveGroup extends HttpApiGroup.make("live")
  .add(
    HttpApiEndpoint.post("ticket", "/tickets", {
      params: OrgParams,
      payload: LiveTicketRequest,
      success: LiveTicket,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(OpenApi.Summary, "Get a live-update ticket")
      .annotate(
        OpenApi.Description,
        "A ticket for watching one topic: either `poll` (no push channel on this server) or a " +
          "sealed Neon Realtime query scoped to the organization. Each topic needs the read " +
          "permission of the list it signals; a ticket expires after about a minute and is " +
          "renewed by asking again, which checks the permission again.",
      )
      .annotate(SuccessDescription, "The ticket"),
  )
  .prefix("/api/org/:orgId/live")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Live updates") {}

export class LiveApi extends withApiDefaults(HttpApi.make("live").add(LiveGroup)) {}
