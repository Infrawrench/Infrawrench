/**
 * The cost routes, `/api/org/:orgId/costs`, the handlers. The services are
 * promise code and run through `legacy`, inside the caller's cost visibility
 * scope, which is what narrows a cost-scoped caller's answers; nothing here
 * reads or applies the scope itself.
 */
import { Clock, Effect, Predicate } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  COST_EFFICIENCY_LIMITS,
  EFFICIENCY_ALERT_KINDS,
  FOCUS_DEFAULT_DOWNLOAD_VERSION,
  type AlertEmailRecipients,
  type CostBasis,
  type EfficiencyAlertKind,
} from "@infrawrench/client-core";
import { validateAlertEmailRecipients } from "@infrawrench/server-core/alerts/email";
import { AlertEmailRecipientsError } from "@infrawrench/server-core/alerts/email-errors";
import { CostEfficiencySettings } from "@infrawrench/api-contract/schemas";
import {
  getOrgAnomalySettings,
  setOrgAnomalySettings,
} from "@infrawrench/server-core/cost/anomaly-settings";
import {
  getOrgEfficiencySettings,
  setOrgEfficiencySettings,
} from "@infrawrench/server-core/cost/efficiency-settings";
import { isSmsPagingConfigured } from "@infrawrench/server-core/twilio-pager";
import {
  badRequest,
  CostAnomaly,
  CostAnomalyList,
  CostAnomalySettingsView,
  CostDimensionValues,
  CostQueryResponse,
  CostsApi,
  CostStatus,
  EfficiencyAlertEvents,
  notFound,
  ShowbackReport,
  UntaggedSpendReport,
} from "@infrawrench/api-contract";
import { listEfficiencyAlerts } from "../../../services/efficiency-alerts";
import {
  CostQueryError,
  getOrgCostStatus,
  listCostDimensionValues,
  listCostTagKeys,
  listCostUsageUnits,
  listVirtualTagKeyOptions,
  runCostQuery,
} from "../../../services/cost-query";
import {
  acknowledgeCostAnomaly,
  CostAnomalyAcknowledgeError,
  listRecentCostAnomalies,
} from "../../../services/cost-anomalies";
import { logAudit } from "../../../services/audit";
import { focusExportFilename, streamFocusExport } from "../../../services/focus-export";
import { getUntaggedSpendReport } from "../../../services/tag-policy";
import { getShowbackReport } from "../../../services/showback";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry, LegacyScopes, runInLegacyScopes } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const asCostQueryError = (error: unknown) => (error instanceof CostQueryError ? error : undefined);

/**
 * A refused cost query: its sentence, plus `queryError` (the offset, the span
 * length and the valid alternatives) for a query-language parse failure, so a
 * client can underline the mistake. Sent as the route always built it.
 */
const queryRefused = (error: CostQueryError) =>
  HttpServerResponse.jsonUnsafe(
    { error: error.message, ...(error.queryError ? { queryError: error.queryError } : {}) },
    { status: 400 },
  );

/** A settings body's email recipients, checked and normalized; a refusal is the 400. */
const checkedRecipients = (organizationId: string, recipients: AlertEmailRecipients | undefined) =>
  legacyTry(
    () => validateAlertEmailRecipients(organizationId, recipients),
    (error) => (error instanceof AlertEmailRecipientsError ? badRequest(error.message) : undefined),
  );

const isEfficiencyAlertKind = (value: string): value is EfficiencyAlertKind =>
  EFFICIENCY_ALERT_KINDS.some((kind) => kind === value);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * `?from&to`, defaulting to the trailing 30 days; null when either is not a
 * `YYYY-MM-DD` day or they are inverted.
 */
const parseRange = Effect.fnUntraced(function* (query: {
  readonly from?: string;
  readonly to?: string;
}) {
  const now = yield* Clock.currentTimeMillis;
  const from = query.from ?? new Date(now - 29 * DAY_MS).toISOString().slice(0, 10);
  const to = query.to ?? new Date(now).toISOString().slice(0, 10);
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  return { from, to };
});

const invalidRange = () => badRequest("from/to must be YYYY-MM-DD with from <= to");

/**
 * `?basis=amortized|blended`. Anything else (absent, or a typo) reads as cash,
 * the basis these reports have always been computed on: a typo silently
 * changing which money is reported would be worse than ignoring it.
 */
const parseBasis = (basis: string | undefined): CostBasis | undefined =>
  basis === "amortized" || basis === "blended" ? basis : undefined;

/** The CSV chunks as a byte stream, each pulled inside the request's scopes. */
const csvStream = (chunks: AsyncIterable<string>) =>
  Effect.gen(function* () {
    // The rows are read lazily, after the handler has returned, so each pull
    // re-enters the caller's scopes rather than whichever the stream runs in.
    const scopes = yield* LegacyScopes;
    const encoder = new TextEncoder();
    const iterator = chunks[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await runInLegacyScopes(scopes, () => iterator.next());
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (e) {
          controller.error(e);
        }
      },
      async cancel() {
        // The client went away: stop reading, which releases the ClickHouse
        // result set in the row stream's `finally`.
        await runInLegacyScopes(scopes, () => iterator.return?.());
      },
    });
  });

const CostsHandlers = HttpApiBuilder.group(CostsApi, "costs", (handlers) =>
  handlers
    // Aggregate cost series for a graph. The filter comes structurally or as
    // query-language text, never both; a parse failure carries `queryError`.
    .handle("query", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        return yield* legacyTry(() => runCostQuery(organizationId, payload), asCostQueryError).pipe(
          Effect.flatMap(respond(CostQueryResponse)),
          Effect.catch((error) => Effect.succeed(queryRefused(error))),
        );
      }),
    )
    // The rows a cost query selects, as a FOCUS CSV download. Validated before
    // the first byte, so a bad range or filter is a 400 rather than a
    // truncated 200; streamed after that.
    .handle("focusExport", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const chunks = yield* legacyTry(
          () => streamFocusExport(organizationId, payload),
          asCostQueryError,
        ).pipe(Effect.result);
        if (chunks._tag === "Failure") return queryRefused(chunks.failure);
        const body = yield* csvStream(chunks.success);
        return HttpServerResponse.raw(
          new Response(body, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="${focusExportFilename(payload)}"`,
              // Says which header the body carries, so a client never has to
              // guess from the version it asked for.
              "X-Focus-Version": payload.version ?? FOCUS_DEFAULT_DOWNLOAD_VERSION,
              "Cache-Control": "no-store",
            },
          }),
        );
      }),
    )
    // Picker values. `tag-keys` applies the org's tag key settings (preferred
    // first, hidden left out unless `includeHidden=true`); `usage-units` and
    // `virtual-tag-keys` are pseudo-dimensions answered the same way.
    .handle("dimensions", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const send = respond(CostDimensionValues);
        if (query.dimension === "tag-keys") {
          const includeHidden = query.includeHidden === "true";
          const values = yield* legacy(() => listCostTagKeys(organizationId, { includeHidden }));
          return yield* send({ values });
        }
        // The units a usage budget can count, as providers reported them.
        if (query.dimension === "usage-units") {
          return yield* send({ values: yield* legacy(() => listCostUsageUnits(organizationId)) });
        }
        // The org's virtual tag keys, labelled with their names, for the
        // `virtual_tag` group-by and filter pickers.
        if (query.dimension === "virtual-tag-keys") {
          const values = yield* legacy(() => listVirtualTagKeyOptions(organizationId));
          return yield* send({ values });
        }
        const values = yield* legacyTry(
          () => listCostDimensionValues(organizationId, query.dimension ?? "", query.tagKey),
          (error) => (error instanceof CostQueryError ? badRequest(error.message) : undefined),
        );
        return yield* send({ values });
      }),
    )
    // Spend anomalies the poller's daily pass detected, newest day first.
    .handle("anomalies", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const days = query.days === undefined ? 30 : Number(query.days);
        if (!Number.isInteger(days) || days < 1 || days > 90) {
          return yield* badRequest("days must be an integer between 1 and 90");
        }
        const anomalies = yield* legacy(() =>
          listRecentCostAnomalies(organizationId, days, { backfillContributors: true }),
        );
        return yield* respond(CostAnomalyList)({ anomalies });
      }),
    )
    // Explain a finding: the sentence goes on the anomaly and on the
    // annotation that draws it on every chart covering that day. It does not
    // suppress anything.
    .handle("acknowledgeAnomaly", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const anomaly = yield* legacyTry(
          () =>
            acknowledgeCostAnomaly(
              organizationId,
              params.anomalyId,
              payload.explanation,
              session.userId ?? null,
            ),
          // An empty sentence, or one past the annotation ceiling.
          (error) =>
            error instanceof CostAnomalyAcknowledgeError ? badRequest(error.message) : undefined,
        );
        if (!anomaly) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_anomaly.acknowledge",
            entityType: "cost_anomaly",
            entityId: anomaly.id,
            metadata: {
              day: anomaly.day,
              dimension: anomaly.dimension,
              dimensionKey: anomaly.dimensionKey,
              explanation: anomaly.acknowledgement?.explanation ?? null,
              annotationId: anomaly.acknowledgement?.annotationId ?? null,
            },
          }),
        );
        return yield* respond(CostAnomaly)(anomaly);
      }),
    )
    // The detection thresholds, plus whether an SMS would actually reach
    // anybody: the Twilio routes that know are `org:settings:write`.
    .handle("anomalySettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const [settings, smsConfigured] = yield* legacy(() =>
          Promise.all([
            getOrgAnomalySettings(organizationId),
            isSmsPagingConfigured(organizationId),
          ]),
        );
        return yield* respond(CostAnomalySettingsView)({ ...settings, smsConfigured });
      }),
    )
    .handle("updateAnomalySettings", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const emailRecipients = yield* checkedRecipients(organizationId, payload.emailRecipients);
        const input = emailRecipients === undefined ? payload : { ...payload, emailRecipients };
        const [settings, smsConfigured] = yield* legacy(() =>
          Promise.all([
            setOrgAnomalySettings(organizationId, input),
            isSmsPagingConfigured(organizationId),
          ]),
        );
        return yield* respond(CostAnomalySettingsView)({ ...settings, smsConfigured });
      }),
    )
    // What the three efficiency detectors fired, newest first, in one feed.
    .handle("efficiencyAlerts", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rawKind = query.kind;
        if (rawKind !== undefined && !isEfficiencyAlertKind(rawKind)) {
          return yield* badRequest(`kind must be one of ${EFFICIENCY_ALERT_KINDS.join(", ")}`);
        }
        const limit =
          query.limit === undefined
            ? COST_EFFICIENCY_LIMITS.defaultEventsLimit
            : Number(query.limit);
        if (
          !Number.isInteger(limit) ||
          limit < COST_EFFICIENCY_LIMITS.minEventsLimit ||
          limit > COST_EFFICIENCY_LIMITS.maxEventsLimit
        ) {
          return yield* badRequest(
            `limit must be an integer between ${COST_EFFICIENCY_LIMITS.minEventsLimit} and ` +
              `${COST_EFFICIENCY_LIMITS.maxEventsLimit}`,
          );
        }
        const events = yield* legacy(() =>
          listEfficiencyAlerts(organizationId, { kind: rawKind, limit }),
        );
        return yield* respond(EfficiencyAlertEvents)({ events });
      }),
    )
    .handle("efficiencyAlertSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getOrgEfficiencySettings(organizationId));
        return yield* respond(CostEfficiencySettings)(settings);
      }),
    )
    .handle("updateEfficiencyAlertSettings", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const emailRecipients = yield* checkedRecipients(organizationId, payload.emailRecipients);
        const input = emailRecipients === undefined ? payload : { ...payload, emailRecipients };
        const settings = yield* legacy(() => setOrgEfficiencySettings(organizationId, input));
        return yield* respond(CostEfficiencySettings)(settings);
      }),
    )
    // Spend on rows missing a required tag key; empty without a tag policy.
    .handle("untagged", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const range = yield* parseRange(query);
        if (!range) return yield* invalidRange();
        const report = yield* legacy(() =>
          getUntaggedSpendReport(organizationId, range.from, range.to, parseBasis(query.basis)),
        );
        return yield* respond(UntaggedSpendReport)(report);
      }),
    )
    // Spend per cost centre through the allocation rules. `?currency=` opts
    // into conversion and `?adjusted=true` into the billing rules.
    .handle("showback", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const range = yield* parseRange(query);
        if (!range) return yield* invalidRange();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const currency = new URL(request.url, "http://localhost").searchParams.get("currency");
        const report = yield* legacy(() =>
          getShowbackReport(
            organizationId,
            range.from,
            range.to,
            parseBasis(query.basis),
            Predicate.isString(currency) ? currency : undefined,
            query.adjusted === "true",
          ),
        );
        return yield* respond(ShowbackReport)(report);
      }),
    )
    // Per-account cost capability and collection state.
    .handle("status", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const accounts = yield* legacy(() => getOrgCostStatus(organizationId));
        return yield* respond(CostStatus)({ accounts });
      }),
    ),
);

export const costsDomain = makeDomain("costs", CostsApi, CostsHandlers);
