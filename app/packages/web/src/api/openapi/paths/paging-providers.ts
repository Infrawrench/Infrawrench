import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

/**
 * Paging providers: PagerDuty, incident.io and any plugin with the paging
 * capability. Settings and pickers, the outbound event log, the mirrored
 * provider incidents, and the inbound webhook.
 */
export function registerPagingProviderPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const AccountIdParam = z.object({
    orgId: z.string(),
    accountId: z.string().openapi({ description: "A connected account whose plugin can page" }),
  });

  const PagingProviderSettings = strict({
    inboundEnabled: z.boolean().describe("Mirror this account's incidents into Infrawrench."),
    webhookConfigured: z
      .boolean()
      .describe("A webhook (subscribed by Infrawrench, or a pasted signing secret) is in place."),
    webhookUrl: z
      .string()
      .nullable()
      .describe(
        "The URL a manually configured webhook must point at. Null until inbound is enabled, or when the deployment has no public URL.",
      ),
    lastSyncedAt: IsoDateTime.nullable(),
    lastSyncError: z.string().nullable(),
  }).openapi("PagingProviderSettings");

  const PagingProviderAccount = strict({
    accountId: z.string(),
    displayName: z.string(),
    pluginId: z.string().openapi({ example: "pagerduty" }),
    targetLabel: z.string().openapi({ example: "Service" }),
    targetDescription: z.string().nullable(),
    supportsAcknowledgeEvent: z
      .boolean()
      .describe("Whether an Infrawrench acknowledgement is written back as an event."),
    onCallSourceLabel: z.string().nullable(),
    incidents: strict({
      label: z.string(),
      canAcknowledge: z.boolean(),
      canResolve: z.boolean(),
    }).nullable(),
    webhookMode: z
      .enum(["managed", "manual"])
      .nullable()
      .describe(
        "`managed`: Infrawrench subscribes the webhook through the provider's API. `manual`: the user adds the URL in the provider's dashboard and pastes its signing secret.",
      ),
    webhookSetupHelp: z.string().nullable(),
    settings: PagingProviderSettings,
  }).openapi("PagingProviderAccount");

  const PagingProvidersResponse = strict({
    accounts: z.array(PagingProviderAccount),
  }).openapi("PagingProvidersResponse");

  const PagingProviderSettingsInput = strict({
    inboundEnabled: z.boolean(),
    webhookSecret: z
      .string()
      .max(512)
      .nullable()
      .optional()
      .describe(
        "For a `manual` webhook only: the signing secret copied from the provider. `null` forgets it; omit to keep the stored one. Never returned.",
      ),
  }).openapi("PagingProviderSettingsInput");

  const PagingDestinationAccount = strict({
    accountId: z.string(),
    displayName: z.string(),
    pluginId: z.string(),
    targetLabel: z.string(),
    onCallSourceLabel: z.string().nullable(),
    targets: z.array(
      strict({ id: z.string(), name: z.string(), description: z.string().nullable() }),
    ),
    onCallSources: z.array(
      strict({
        id: z.string(),
        name: z.string(),
        kind: z.enum(["schedule", "escalation-policy"]),
      }),
    ),
    error: z
      .string()
      .nullable()
      .describe("Why this account's lists could not be loaded; the other accounts still load."),
  }).openapi("PagingDestinationAccount");

  const PagingEventRecord = strict({
    id: z.string(),
    accountId: z.string(),
    targetId: z.string(),
    dedupKey: z.string(),
    trigger: z.string(),
    title: z.string(),
    state: z.enum(["triggered", "acknowledged", "resolved"]),
    pendingAction: z.enum(["trigger", "acknowledge", "resolve"]).nullable(),
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    sentAt: IsoDateTime.nullable(),
  }).openapi("PagingEventRecord");

  const PagerIncident = strict({
    id: z.string().describe("Infrawrench's id for the mirrored incident."),
    accountId: z.string(),
    accountName: z.string(),
    pluginId: z.string(),
    externalId: z.string(),
    reference: z.string().nullable().openapi({ example: "#1234" }),
    title: z.string(),
    status: z.enum(["triggered", "acknowledged", "resolved"]),
    statusLabel: z.string().nullable(),
    urgency: z.string().nullable(),
    url: z.string().nullable(),
    serviceName: z.string().nullable(),
    assignees: z.array(strict({ name: z.string().nullable(), email: z.string().nullable() })),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime.nullable(),
    resolvedAt: IsoDateTime.nullable(),
    fromInfrawrench: z.boolean().describe("True when an Infrawrench alert opened this incident."),
    canAcknowledge: z.boolean(),
    canResolve: z.boolean(),
  }).openapi("PagerIncident");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/paging-providers",
    tags: ["Paging providers"],
    summary: "List paging provider accounts and their settings",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Accounts whose plugin can page, with their inbound settings",
        content: { "application/json": { schema: PagingProvidersResponse } },
      },
      ...ErrorResponses,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/paging-providers/destinations",
    tags: ["Paging providers"],
    summary: "List the targets and on-call sources a routing rule can name",
    description:
      "Listed live from each provider, so a destination is picked by name. A failure is reported per account in `error` rather than failing the response.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Per-account pickers",
        content: {
          "application/json": {
            schema: strict({ accounts: z.array(PagingDestinationAccount) }).openapi(
              "PagingDestinationsResponse",
            ),
          },
        },
      },
      ...ErrorResponses,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/paging-providers/events",
    tags: ["Paging providers"],
    summary: "List upstream alerts Infrawrench opened",
    description:
      "One row per (account, target, dedup key): a trigger, its acknowledgement and its resolution are one alert upstream. `pendingAction` is set while a send is queued or being retried.",
    request: {
      params: OrgIdParam,
      query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    },
    responses: {
      200: {
        description: "Newest first",
        content: {
          "application/json": {
            schema: strict({ events: z.array(PagingEventRecord) }).openapi("PagingEventsResponse"),
          },
        },
      },
      ...ErrorResponses,
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/paging-providers/{accountId}/settings",
    tags: ["Paging providers"],
    summary: "Configure incident mirroring for a paging provider account",
    description:
      "Turning inbound on with a `managed` webhook subscribes one through the provider's API; turning it off removes the subscription and forgets the mirrored incidents. A webhook that cannot be subscribed is reported in `warning` and mirroring falls back to reconciling on a timer.",
    request: {
      params: AccountIdParam,
      body: { content: { "application/json": { schema: PagingProviderSettingsInput } } },
    },
    responses: {
      200: {
        description: "The account with its new settings",
        content: {
          "application/json": {
            schema: strict({
              account: PagingProviderAccount,
              warning: z.string().nullable(),
            }).openapi("PagingProviderSettingsResult"),
          },
        },
      },
      ...ErrorResponses,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/paging-providers/{accountId}/sync",
    tags: ["Paging providers"],
    summary: "Reconcile an account's incidents now",
    request: { params: AccountIdParam },
    responses: {
      200: {
        description: "How many incidents the provider returned",
        content: {
          "application/json": {
            schema: strict({ synced: z.number().int() }).openapi("PagingSyncResult"),
          },
        },
      },
      ...ErrorResponses,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/paging-providers/{accountId}/on-call/{sourceId}",
    tags: ["Paging providers"],
    summary: "Who is on call on a provider schedule or escalation policy",
    description:
      "Takes `team:read`, like the rotation preview. Each person is matched to an organization member by email; `memberUserId` is null for somebody who is on call upstream but not a member here.",
    request: {
      params: AccountIdParam.extend({ sourceId: z.string() }),
    },
    responses: {
      200: {
        description: "The people on call now, first escalation level first",
        content: {
          "application/json": {
            schema: strict({
              people: z.array(
                strict({
                  name: z.string().nullable(),
                  email: z.string().nullable(),
                  memberUserId: z.string().nullable(),
                  until: IsoDateTime.nullable(),
                  level: z.number().int().nullable(),
                }),
              ),
            }).openapi("PagingOnCallNowResponse"),
          },
        },
      },
      ...ErrorResponses,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/paging-incidents",
    tags: ["Paging providers"],
    summary: "List incidents mirrored from paging providers",
    description:
      "Only accounts with inbound mirroring turned on contribute. Open incidents by default; `status=all` includes resolved ones. These are a provider's pages, distinct from incidents declared in Infrawrench (`/incidents`).",
    request: {
      params: OrgIdParam,
      query: z.object({ status: z.enum(["open", "all"]).optional() }),
    },
    responses: {
      200: {
        description: "Newest first",
        content: {
          "application/json": {
            schema: strict({ incidents: z.array(PagerIncident) }).openapi("PagerIncidentsResponse"),
          },
        },
      },
      ...ErrorResponses,
    },
  });

  for (const action of ["acknowledge", "resolve"] as const) {
    registry.registerPath({
      method: "post",
      path: `/api/org/{orgId}/paging-incidents/{id}/${action}`,
      tags: ["Paging providers"],
      summary:
        action === "acknowledge"
          ? "Acknowledge a provider incident"
          : "Resolve a provider incident",
      description:
        "Written to the provider as the acting member where the provider records who acted (PagerDuty's `From` header), falling back to the account's default user. The returned state is the provider's answer, not an assumption.",
      request: { params: z.object({ orgId: z.string(), id: z.string() }) },
      responses: {
        200: {
          description: "The incident's new state",
          content: { "application/json": { schema: PagerIncident } },
        },
        ...ErrorResponses,
      },
    });
  }

  registry.registerPath({
    method: "post",
    path: "/api/paging-webhooks/{token}",
    tags: ["Paging providers"],
    summary: "Inbound paging provider webhook",
    description:
      "Called by the provider, not by clients. The token in the path picks the account; the provider's signature, verified with the stored secret, authenticates the delivery. The payload is treated as a nudge: each incident it names is re-read from the provider's API.",
    security: [],
    request: { params: z.object({ token: z.string() }) },
    responses: {
      202: { description: "Accepted" },
      401: { description: "The signature did not verify" },
      404: { description: "Unknown token" },
    },
  });
}
