/**
 * Paging providers (PagerDuty, incident.io, any plugin with the paging
 * capability), the endpoint definitions. Two groups on the org tree:
 *
 * - `/api/org/:orgId/paging-providers`: the per-account settings and the
 *   pickers the routing editor needs. Configuration is `org:settings:write`,
 *   the alert-routing stance; the "who is on call right now" preview is
 *   `team:read`, the on-call stance.
 * - `/api/org/:orgId/paging-incidents`: the provider incidents mirrored into
 *   Infrawrench, read with `incidents:read` and acknowledged or resolved with
 *   `incidents:write`, the split declared incidents use.
 *
 * The inbound webhook (`/api/paging-webhooks/:token`) is not here: it is
 * public, authenticated by the provider's signature over the raw body, and
 * stays on Hono in `api/routes/paging-providers.ts`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  PaymentRequired,
  ServiceUnavailable,
  Unauthorized,
} from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams } from "../../schemas/common";
import { enumQuery, numericQuery } from "../../schemas/query";

const message = Schema.String.annotate({ description: "Human-readable error message" });

/** A 500, which the hand-written spec listed on every operation here. */
export class ServerError extends Schema.Error<ServerError>("infrawrench/http/paging/ServerError")(
  { error: message },
  { httpApiStatus: 500, identifier: "Error" },
) {}

/** What the route answers when the provider failed in a way that is not the caller's fault. */
export class BadGateway extends Schema.Error<BadGateway>("infrawrench/http/paging/BadGateway")(
  { error: message },
  { httpApiStatus: 502, identifier: "Error" },
) {}

/** The error slots the hand-written spec spread onto every operation, plus the 502 the routes send. */
const PagingErrors = [
  BadRequest,
  Unauthorized,
  PaymentRequired,
  Forbidden,
  NotFound,
  Conflict,
  ServerError,
  BadGateway,
  ServiceUnavailable,
] as const;

/** Unformatted, as the hand-written spec had them: these paths never documented a uuid. */
const AccountParams = {
  orgId: Schema.String,
  accountId: Schema.String.annotate({ description: "A connected account whose plugin can page" }),
} as const;

const PagingProviderSettings = Schema.Struct({
  inboundEnabled: Schema.Boolean.annotate({
    description: "Mirror this account's incidents into Infrawrench.",
  }),
  webhookConfigured: Schema.Boolean.annotate({
    description: "A webhook (subscribed by Infrawrench, or a pasted signing secret) is in place.",
  }),
  webhookUrl: Schema.NullOr(Schema.String).annotate({
    description:
      "The URL a manually configured webhook must point at. Null until inbound is enabled, or when the deployment has no public URL.",
  }),
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  lastSyncError: Schema.NullOr(Schema.String),
}).annotate({ identifier: "PagingProviderSettings" });

const PagingProviderAccount = Schema.Struct({
  accountId: Schema.String,
  displayName: Schema.String,
  pluginId: Schema.String.annotate({ examples: ["pagerduty"] }),
  targetLabel: Schema.String.annotate({ examples: ["Service"] }),
  targetDescription: Schema.NullOr(Schema.String),
  supportsAcknowledgeEvent: Schema.Boolean.annotate({
    description: "Whether an Infrawrench acknowledgement is written back as an event.",
  }),
  onCallSourceLabel: Schema.NullOr(Schema.String),
  incidents: Schema.NullOr(
    Schema.Struct({
      label: Schema.String,
      canAcknowledge: Schema.Boolean,
      canResolve: Schema.Boolean,
    }),
  ),
  webhookMode: Schema.NullOr(Schema.Literals(["managed", "manual"])).annotate({
    description:
      "`managed`: Infrawrench subscribes the webhook through the provider's API. `manual`: the user adds the URL in the provider's dashboard and pastes its signing secret.",
  }),
  webhookSetupHelp: Schema.NullOr(Schema.String),
  settings: PagingProviderSettings,
}).annotate({ identifier: "PagingProviderAccount" });

export const PagingProvidersResponse = Schema.Struct({
  accounts: Schema.Array(PagingProviderAccount),
}).annotate({ identifier: "PagingProvidersResponse" });

const PagingProviderSettingsInput = Schema.Struct({
  inboundEnabled: Schema.Boolean,
  webhookSecret: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(512))).annotate({
      description:
        "For a `manual` webhook only: the signing secret copied from the provider. `null` forgets it; omit to keep the stored one. Never returned.",
    }),
  ),
}).annotate({ identifier: "PagingProviderSettingsInput" });

const PagingDestinationAccount = Schema.Struct({
  accountId: Schema.String,
  displayName: Schema.String,
  pluginId: Schema.String,
  targetLabel: Schema.String,
  onCallSourceLabel: Schema.NullOr(Schema.String),
  targets: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.NullOr(Schema.String),
    }),
  ),
  onCallSources: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      kind: Schema.Literals(["schedule", "escalation-policy"]),
    }),
  ),
  error: Schema.NullOr(Schema.String).annotate({
    description: "Why this account's lists could not be loaded; the other accounts still load.",
  }),
}).annotate({ identifier: "PagingDestinationAccount" });

export const PagingDestinationsResponse = Schema.Struct({
  accounts: Schema.Array(PagingDestinationAccount),
}).annotate({ identifier: "PagingDestinationsResponse" });

const PagingEventRecord = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  targetId: Schema.String,
  dedupKey: Schema.String,
  trigger: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["triggered", "acknowledged", "resolved"]),
  pendingAction: Schema.NullOr(Schema.Literals(["trigger", "acknowledge", "resolve"])),
  attempts: Schema.Int,
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  sentAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "PagingEventRecord" });

export const PagingEventsResponse = Schema.Struct({
  events: Schema.Array(PagingEventRecord),
}).annotate({ identifier: "PagingEventsResponse" });

export const PagingProviderSettingsResult = Schema.Struct({
  account: PagingProviderAccount,
  warning: Schema.NullOr(Schema.String),
}).annotate({ identifier: "PagingProviderSettingsResult" });

export const PagingSyncResult = Schema.Struct({ synced: Schema.Int }).annotate({
  identifier: "PagingSyncResult",
});

export const PagingOnCallNowResponse = Schema.Struct({
  people: Schema.Array(
    Schema.Struct({
      name: Schema.NullOr(Schema.String),
      email: Schema.NullOr(Schema.String),
      memberUserId: Schema.NullOr(Schema.String),
      until: Schema.NullOr(IsoDateTime),
      level: Schema.NullOr(Schema.Int),
    }),
  ),
}).annotate({ identifier: "PagingOnCallNowResponse" });

export const PagerIncident = Schema.Struct({
  id: Schema.String.annotate({ description: "Infrawrench's id for the mirrored incident." }),
  accountId: Schema.String,
  accountName: Schema.String,
  pluginId: Schema.String,
  externalId: Schema.String,
  reference: Schema.NullOr(Schema.String).annotate({ examples: ["#1234"] }),
  title: Schema.String,
  status: Schema.Literals(["triggered", "acknowledged", "resolved"]),
  statusLabel: Schema.NullOr(Schema.String),
  urgency: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  serviceName: Schema.NullOr(Schema.String),
  assignees: Schema.Array(
    Schema.Struct({ name: Schema.NullOr(Schema.String), email: Schema.NullOr(Schema.String) }),
  ),
  createdAt: IsoDateTime,
  updatedAt: Schema.NullOr(IsoDateTime),
  resolvedAt: Schema.NullOr(IsoDateTime),
  fromInfrawrench: Schema.Boolean.annotate({
    description: "True when an Infrawrench alert opened this incident.",
  }),
  canAcknowledge: Schema.Boolean,
  canResolve: Schema.Boolean,
}).annotate({ identifier: "PagerIncident" });

export const PagerIncidentsResponse = Schema.Struct({
  incidents: Schema.Array(PagerIncident),
}).annotate({ identifier: "PagerIncidentsResponse" });

export class PagingProvidersGroup extends HttpApiGroup.make("pagingProviders")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: PagingProvidersResponse,
      error: PagingErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List paging provider accounts and their settings")
      .annotate(SuccessDescription, "Accounts whose plugin can page, with their inbound settings"),
    HttpApiEndpoint.get("destinations", "/destinations", {
      params: OrgParams,
      success: PagingDestinationsResponse,
      error: PagingErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List the targets and on-call sources a routing rule can name")
      .annotate(
        OpenApi.Description,
        "Listed live from each provider, so a destination is picked by name. A failure is reported per account in `error` rather than failing the response.",
      )
      .annotate(SuccessDescription, "Per-account pickers"),
    // Any `limit` is accepted (an unreadable one means the default 50); the
    // store clamps it to 1..200, which is the range documented.
    HttpApiEndpoint.get("events", "/events", {
      params: OrgParams,
      query: {
        // NaN is wanted: an unreadable limit means the default, never a 400.
        // @effect-diagnostics-next-line schemaNumber:off
        limit: Schema.optionalKey(Schema.NumberFromString),
      },
      success: PagingEventsResponse,
      error: PagingErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List upstream alerts Infrawrench opened")
      .annotate(
        OpenApi.Description,
        "One row per (account, target, dedup key): a trigger, its acknowledgement and its resolution are one alert upstream. `pendingAction` is set while a send is queued or being retried.",
      )
      .annotate(SuccessDescription, "Newest first")
      .annotate(
        OpenApi.Transform,
        numericQuery({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
      ),
    HttpApiEndpoint.put("settings", "/:accountId/settings", {
      params: AccountParams,
      payload: PagingProviderSettingsInput,
      success: PagingProviderSettingsResult,
      error: PagingErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Configure incident mirroring for a paging provider account")
      .annotate(
        OpenApi.Description,
        "Turning inbound on with a `managed` webhook subscribes one through the provider's API; turning it off removes the subscription and forgets the mirrored incidents. A webhook that cannot be subscribed is reported in `warning` and mirroring falls back to reconciling on a timer.",
      )
      .annotate(SuccessDescription, "The account with its new settings"),
    HttpApiEndpoint.post("sync", "/:accountId/sync", {
      params: AccountParams,
      success: PagingSyncResult,
      error: PagingErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Reconcile an account's incidents now")
      .annotate(SuccessDescription, "How many incidents the provider returned"),
    HttpApiEndpoint.get("onCall", "/:accountId/on-call/:sourceId", {
      params: { ...AccountParams, sourceId: Schema.String },
      success: PagingOnCallNowResponse,
      error: PagingErrors,
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "Who is on call on a provider schedule or escalation policy")
      .annotate(
        OpenApi.Description,
        "Takes `team:read`, like the rotation preview. Each person is matched to an organization member by email; `memberUserId` is null for somebody who is on call upstream but not a member here.",
      )
      .annotate(SuccessDescription, "The people on call now, first escalation level first"),
  )
  .prefix("/api/org/:orgId/paging-providers")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Paging providers") {}

const acknowledgeOrResolveDescription =
  "Written to the provider as the acting member where the provider records who acted (PagerDuty's `From` header), falling back to the account's default user. The returned state is the provider's answer, not an assumption.";

const IncidentActionParams = { orgId: Schema.String, id: Schema.String } as const;

export class PagingIncidentsGroup extends HttpApiGroup.make("pagingIncidents")
  .add(
    // Anything but `all` lists the open ones, as it always has.
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: { status: Schema.optionalKey(Schema.String) },
      success: PagerIncidentsResponse,
      error: PagingErrors,
    })
      .annotate(RequiredPermission, "incidents:read")
      .annotate(OpenApi.Summary, "List incidents mirrored from paging providers")
      .annotate(
        OpenApi.Description,
        "Only accounts with inbound mirroring turned on contribute. Open incidents by default; `status=all` includes resolved ones. These are a provider's pages, distinct from incidents declared in Infrawrench (`/incidents`).",
      )
      .annotate(SuccessDescription, "Newest first")
      .annotate(OpenApi.Transform, enumQuery({ status: ["open", "all"] })),
    HttpApiEndpoint.post("acknowledge", "/:id/acknowledge", {
      params: IncidentActionParams,
      success: PagerIncident,
      error: PagingErrors,
    })
      .annotate(RequiredPermission, "incidents:write")
      .annotate(OpenApi.Summary, "Acknowledge a provider incident")
      .annotate(OpenApi.Description, acknowledgeOrResolveDescription)
      .annotate(SuccessDescription, "The incident's new state"),
    HttpApiEndpoint.post("resolve", "/:id/resolve", {
      params: IncidentActionParams,
      success: PagerIncident,
      error: PagingErrors,
    })
      .annotate(RequiredPermission, "incidents:write")
      .annotate(OpenApi.Summary, "Resolve a provider incident")
      .annotate(OpenApi.Description, acknowledgeOrResolveDescription)
      .annotate(SuccessDescription, "The incident's new state"),
  )
  .prefix("/api/org/:orgId/paging-incidents")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Paging providers") {}

export class PagingProvidersApi extends withApiDefaults(
  HttpApi.make("paging-providers").add(PagingProvidersGroup).add(PagingIncidentsGroup),
) {}
