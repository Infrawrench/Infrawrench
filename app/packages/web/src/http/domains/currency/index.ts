/**
 * Currency: `/api/org/:orgId/currency`, the handlers. The logic lives in
 * server-core's `cost/currency-settings` and `cost/fx-feed*`, run through
 * `legacy` inside the request's scopes.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  EXCHANGE_RATE_CSV_TEMPLATE,
  EXCHANGE_RATE_CSV_TEMPLATE_FILENAME,
} from "@infrawrench/client-core";
import {
  CurrencySettingsError,
  deleteOrgExchangeRate,
  getOrgCurrencyConfig,
  importOrgExchangeRates,
  lookupOrgExchangeRate,
  setOrgCurrencySettings,
  upsertOrgExchangeRate,
} from "@infrawrench/server-core/cost/currency-settings";
import { getFxFeedSnapshot, getFxFeedStatus } from "@infrawrench/server-core/cost/fx-feed-store";
import { feedRateFor, publicationIndexFor } from "@infrawrench/server-core/cost/fx-feed";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  CurrencyApi,
  CurrencyConfig,
  CurrencySettings,
  ExchangeRate,
  ExchangeRateImportRefusalBody,
  ExchangeRateImportResult,
  ExchangeRateLookup,
  FxFeedRates,
} from "./api";

/** A rate or setting the service refused (an unknown currency, a pair to itself). */
const settingsRefusal = (error: unknown) =>
  error instanceof CurrencySettingsError ? new BadRequest({ error: error.message }) : undefined;

const today = () => new Date().toISOString().slice(0, 10);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z]{3}$/;

const CurrencyHandlers = HttpApiBuilder.group(CurrencyApi, "currency", (handlers) =>
  handlers
    .handle("get", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const config = yield* legacy(() => getOrgCurrencyConfig(organizationId));
        return yield* respond(CurrencyConfig)(config);
      }),
    )
    /**
     * The rate a day of spend would convert at under this org's rules (stated
     * rate first, then the feed when automatic rates are on), its source and
     * date, and a sentence explaining why. `to` defaults to the display
     * currency. The parameters are read as they arrived; the service refuses
     * a code it does not know.
     */
    .handle("lookup", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const from: string = query.from ?? "";
        const to: string | undefined = query.to || undefined;
        const date: string = query.date || today();
        const lookup = yield* legacyTry(
          () => lookupOrgExchangeRate(organizationId, { from, to, date }),
          settingsRefusal,
        );
        return yield* respond(ExchangeRateLookup)(lookup);
      }),
    )
    /**
     * The automatic feed's state plus every rate it holds for one day,
     * expressed as "1 unit of each currency in `base`" (default: the display
     * currency, else EUR). The feed is global, so this reveals nothing
     * org-specific.
     */
    .handle("feed", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const date: string = query.date || today();
        if (!ISO_DAY.test(date)) return yield* badRequest("date must be YYYY-MM-DD");
        const requested: string = query.base ?? "";
        const requestedBase = requested.trim().toUpperCase();
        if (requestedBase && !CODE.test(requestedBase)) {
          return yield* badRequest("base must be a three-letter currency code");
        }
        const body = yield* legacy(async () => {
          const [status, snapshot, config] = await Promise.all([
            getFxFeedStatus(),
            getFxFeedSnapshot(),
            requestedBase ? Promise.resolve(null) : getOrgCurrencyConfig(organizationId),
          ]);
          const base = requestedBase || config?.displayCurrency || "EUR";
          const index = publicationIndexFor(snapshot, date);
          const rateDate = index >= 0 ? (snapshot.dates[index] ?? null) : null;
          const rates = status.currencies
            .filter((code) => code !== base)
            .flatMap((code) => {
              const found = feedRateFor(snapshot, code, base, date);
              return found ? [{ currency: code, rate: found.rate }] : [];
            });
          return { ...status, date, base, rateDate, rates };
        });
        return yield* respond(FxFeedRates)(body);
      }),
    )
    /**
     * `displayCurrency: null` turns conversion off everywhere without touching
     * the rate table, so an org can turn it back on without re-typing what it
     * stated. `autoRates` and `rateBasis` omitted keep the stored value.
     */
    .handle("update", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const saved = yield* legacyTry(
          () => setOrgCurrencySettings(organizationId, payload),
          settingsRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "currency_settings.update",
            entityType: "currency_settings",
            entityId: organizationId,
            metadata: {
              displayCurrency: saved.displayCurrency,
              autoRates: saved.autoRates,
              rateBasis: saved.rateBasis,
            },
          }),
        );
        return yield* respond(CurrencySettings)(saved);
      }),
    )
    /**
     * An upsert keyed on (from, to, effectiveFrom): one rate per pair per day,
     * and correcting a typo means "this is the rate", not "add a second one
     * and let the reader guess which applied".
     */
    .handle("upsertRate", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const rate = yield* legacyTry(
          () => upsertOrgExchangeRate(organizationId, payload, session.userId),
          settingsRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "exchange_rate.upsert",
            entityType: "exchange_rate",
            entityId: rate.id,
            metadata: {
              fromCurrency: rate.fromCurrency,
              toCurrency: rate.toCurrency,
              rate: rate.rate,
              effectiveFrom: rate.effectiveFrom,
              effectiveTo: rate.effectiveTo,
            },
          }),
        );
        return yield* respond(ExchangeRate)(rate);
      }),
    )
    // The settings page builds the same file locally from the client-core
    // constant; this serves the CLI and anyone scripting against the API.
    .handle("rateTemplate", () =>
      Effect.succeed(
        HttpServerResponse.text(EXCHANGE_RATE_CSV_TEMPLATE, {
          contentType: "text/csv; charset=utf-8",
          headers: {
            "content-disposition": `attachment; filename="${EXCHANGE_RATE_CSV_TEMPLATE_FILENAME}"`,
          },
        }),
      ),
    )
    /**
     * Preview first: `dryRun: true` classifies every row and writes nothing.
     * An upload with an invalid row writes nothing unless the caller passes
     * `skipInvalid`. A whole-file problem is a 400 with the result as the
     * body, so a client can show the same message either way. Same permission
     * and audit stance as the single-rate PUT.
     */
    .handle("importRates", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const result = yield* legacy(() =>
          importOrgExchangeRates(organizationId, payload, session.userId),
        );
        if (result.fileError) {
          return yield* respond(ExchangeRateImportRefusalBody, { status: 400 })({
            ...result,
            error: result.fileError,
          });
        }
        if (result.applied && result.counts.create + result.counts.update > 0) {
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "exchange_rate.import",
              entityType: "exchange_rate",
              entityId: organizationId,
              metadata: {
                created: result.counts.create,
                updated: result.counts.update,
                unchanged: result.counts.unchanged,
                skippedInvalid: result.counts.error,
                // The pairs touched, not every row: enough to find the upload in the
                // log without copying a 2,000-row file into it.
                pairs: [
                  ...new Set(
                    result.rows.flatMap((r) =>
                      (r.action === "create" || r.action === "update") && r.rate
                        ? [`${r.rate.fromCurrency}>${r.rate.toCurrency}`]
                        : [],
                    ),
                  ),
                ].slice(0, 50),
              },
            }),
          );
        }
        return yield* respond(ExchangeRateImportResult)(result);
      }),
    )
    .handle("deleteRate", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => deleteOrgExchangeRate(organizationId, params.rateId));
        if (!deleted) return yield* notFound("Exchange rate not found");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "exchange_rate.delete",
            entityType: "exchange_rate",
            entityId: params.rateId,
            metadata: {},
          }),
        );
        return { ok: true };
      }),
    ),
);

export const currencyDomain = makeDomain("currency", CurrencyApi, CurrencyHandlers);
