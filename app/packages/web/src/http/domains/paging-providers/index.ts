/**
 * Paging providers, the handlers for the org-tree groups. The server half
 * lives in `server-core/src/paging/providers.ts`; these only parse, gate and
 * audit. The inbound webhook stays on Hono (`api/routes/paging-providers.ts`).
 */
import { Effect, Layer, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { PagingProviderSettingsInput } from "@infrawrench/client-core";
import {
  PagingProviderError,
  actOnPagerIncident,
  listPagerIncidents,
  listPagingDestinations,
  listPagingEvents,
  listPagingProviders,
  previewProviderOnCall,
  syncPagingIncidents,
  updatePagingProviderSettings,
} from "@infrawrench/server-core/paging/providers";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { invalidBody, readObjectBody } from "../../object-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  BadGateway,
  PagerIncident,
  PagerIncidentsResponse,
  PagingDestinationsResponse,
  PagingEventsResponse,
  PagingOnCallNowResponse,
  PagingProviderSettingsResult,
  PagingProvidersApi,
  PagingProvidersResponse,
  PagingSyncResult,
} from "./api";

/**
 * A provider error as its status; anything else is the upstream's failure. A
 * provider's 401/403 means the account's key cannot do this: a 400 rather
 * than a 401, which the app would read as *our* session expiring. The store
 * only raises `PagingProviderError` with 400 or 404; any other status would
 * stay a defect and answer 500.
 */
const providerFailure = (error: unknown): BadRequest | NotFound | BadGateway | undefined => {
  if (error instanceof PagingProviderError) {
    if (error.status === 404) return new NotFound({ error: error.message });
    if (error.status === 400) return new BadRequest({ error: error.message });
    return undefined;
  }
  const status = Predicate.hasProperty(error, "status") ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403) {
    return new BadRequest({ error: `The provider refused the request: ${message}` });
  }
  if (status === 404) return new NotFound({ error: message });
  return new BadGateway({ error: message });
};

const PagingProvidersHandlers = HttpApiBuilder.group(
  PagingProvidersApi,
  "pagingProviders",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const accounts = yield* legacy(() => listPagingProviders(organizationId));
          return yield* respond(PagingProvidersResponse)({ accounts });
        }),
      )
      // The routing editor's pickers, listed live; a failure is reported per account.
      .handle("destinations", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const result = yield* legacy(() => listPagingDestinations(organizationId));
          return yield* respond(PagingDestinationsResponse)(result);
        }),
      )
      .handle("events", ({ query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const limit = query.limit ?? 50;
          const events = yield* legacy(() =>
            listPagingEvents(organizationId, Number.isFinite(limit) ? limit : 50),
          );
          return yield* respond(PagingEventsResponse)({ events });
        }),
      )
      // Turn incident mirroring on or off, and set up the webhook that feeds it.
      .handleRaw("settings", ({ params, request }) =>
        Effect.gen(function* () {
          const parsed = yield* readObjectBody(request);
          if (!parsed.ok) return yield* invalidBody(parsed.error);
          const { body } = parsed;
          const inboundEnabled = body["inboundEnabled"];
          if (!Predicate.isBoolean(inboundEnabled)) {
            return yield* invalidBody("inboundEnabled must be a boolean");
          }
          const input: PagingProviderSettingsInput = { inboundEnabled };
          if ("webhookSecret" in body) {
            const raw = body["webhookSecret"];
            if (raw !== null && !Predicate.isString(raw)) {
              return yield* invalidBody("webhookSecret must be a string or null");
            }
            if (Predicate.isString(raw) && raw.length > 512) {
              return yield* invalidBody("webhookSecret is too long");
            }
            input.webhookSecret = raw;
          }

          const { organizationId, session } = yield* OrgPrincipal;
          const result = yield* legacyTry(
            () => updatePagingProviderSettings(organizationId, params.accountId, input),
            providerFailure,
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId ?? null,
              action: "paging_provider.settings",
              entityType: "account",
              entityId: params.accountId,
              // Never the secret: only whether one was set or cleared.
              metadata: {
                inboundEnabled: input.inboundEnabled,
                ...(input.webhookSecret !== undefined
                  ? { webhookSecretSet: Boolean(input.webhookSecret) }
                  : {}),
              },
            }),
          );
          return yield* respond(PagingProviderSettingsResult)(result);
        }),
      )
      // Reconcile one account's incidents now rather than at the next tick.
      .handle("sync", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const synced = yield* legacyTry(
            () => syncPagingIncidents(organizationId, params.accountId),
            providerFailure,
          );
          return yield* respond(PagingSyncResult)({ synced });
        }),
      )
      .handle("onCall", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const result = yield* legacyTry(
            () => previewProviderOnCall(organizationId, params.accountId, params.sourceId),
            providerFailure,
          );
          return yield* respond(PagingOnCallNowResponse)(result);
        }),
      ),
);

const actOn = (action: "acknowledge" | "resolve", id: string) =>
  Effect.gen(function* () {
    const { organizationId, session } = yield* OrgPrincipal;
    const incident = yield* legacyTry(
      () => actOnPagerIncident(organizationId, id, action, session.email ?? null),
      providerFailure,
    );
    yield* fireAndForget(() =>
      logAudit({
        organizationId,
        userId: session.userId,
        action: `paging_incident.${action}`,
        entityType: "paging_incident",
        entityId: incident.id,
        metadata: {
          accountId: incident.accountId,
          externalId: incident.externalId,
          ...(incident.reference ? { reference: incident.reference } : {}),
        },
      }),
    );
    return yield* respond(PagerIncident)(incident);
  });

const PagingIncidentsHandlers = HttpApiBuilder.group(
  PagingProvidersApi,
  "pagingIncidents",
  (handlers) =>
    handlers
      .handle("list", ({ query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const status = query.status === "all" ? "all" : "open";
          const incidents = yield* legacy(() => listPagerIncidents(organizationId, { status }));
          return yield* respond(PagerIncidentsResponse)({ incidents });
        }),
      )
      .handle("acknowledge", ({ params }) => actOn("acknowledge", params.id))
      .handle("resolve", ({ params }) => actOn("resolve", params.id)),
);

export const pagingProvidersDomain = makeDomain(
  "paging-providers",
  PagingProvidersApi,
  Layer.mergeAll(PagingProvidersHandlers, PagingIncidentsHandlers),
);
