import { useCallback, useEffect, useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import type {
  ExchangeRate,
  ExchangeRateInput,
  OrgCurrencyConfig,
  OrgCurrencySettings,
} from "@infrawrench/client-core";
import { normalizeCurrencyCode } from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

/**
 * Currency — the org's display currency and the exchange rates it states.
 *
 * ## Why its own section rather than a card on Notifications
 *
 * Notifications is about where alerts go. This is about what the numbers mean.
 * It also carries two editors (a currency picker and a full CRUD table over
 * rows with dates), which is a page's worth of surface rather than a card's,
 * and it is gated on `org:settings:write` like Tag Policy — its nearest sibling
 * in kind, an org-level policy that changes how every cost surface reports.
 * It sits next to Tag Policy in the sidebar for that reason.
 *
 * The copy does a job here. A finance user arriving at this page needs to know
 * three things before they type anything: that nothing converts until they opt
 * in, that the rates are theirs and we will not fetch any, and that a currency
 * they forget to price is shown separately rather than dropped. All three are
 * on the page, not in the docs.
 */
export function CurrencySection() {
  const gt = useGT();
  const { orgId, api, has } = useSettingsHost();
  const canEdit = has("org:settings:write");

  const [displayCurrency, setDisplayCurrency] = useState<string | null>(null);
  const [draftCurrency, setDraftCurrency] = useState("");
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const config = await api.get<OrgCurrencyConfig>(`/api/org/${orgId}/currency`);
      setDisplayCurrency(config.displayCurrency);
      setDraftCurrency(config.displayCurrency ?? "");
      setRates(config.rates);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load currency settings"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId, gt]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveCurrency(next: string | null) {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.put<OrgCurrencySettings>(`/api/org/${orgId}/currency`, {
        displayCurrency: next,
      });
      setDisplayCurrency(saved.displayCurrency);
      setDraftCurrency(saved.displayCurrency ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save display currency"));
    } finally {
      setSaving(false);
    }
  }

  async function removeRate(rate: ExchangeRate) {
    if (
      !window.confirm(
        gt(
          "Delete the {from} → {to} rate effective {effectiveFrom}?\n\nDays it covered will fall back to the next-older rate, or be reported unconverted if there is none. No spend is lost either way.",
          { from: rate.fromCurrency, to: rate.toCurrency, effectiveFrom: rate.effectiveFrom },
        ),
      )
    ) {
      return;
    }
    try {
      await api.delete(`/api/org/${orgId}/currency/rates/${rate.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete rate"));
    }
  }

  /**
   * Rates whose `toCurrency` is not the current display currency are dead
   * weight — nothing reads them — so say so rather than letting someone assume
   * their EUR spend is being converted by a EUR→GBP row.
   */
  const staleRates = useMemo(
    () => (displayCurrency ? rates.filter((r) => r.toCurrency !== displayCurrency) : []),
    [rates, displayCurrency],
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("Currency")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            Spend is collected and stored in the currency each provider bills in, and is never
            merged &mdash; that stays the default. Set a display currency here and Infrawrench will
            convert the others into it, using only the exchange rates you state below.{" "}
            <strong className="text-on-surface-secondary">We never fetch live rates.</strong> A
            finance team reconciles against the rate their accounting system booked the period at,
            not today&rsquo;s market quote, so the rates have to be yours. Converted figures are
            labelled as converted everywhere they appear.
          </p>
        </T>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : (
        <div className="space-y-8">
          <section className="border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
            <h2 className="text-sm font-semibold">{gt("Display currency")}</h2>
            <p className="text-xs text-on-surface-muted">
              {gt(
                "Leave this empty to turn conversion off entirely. Nothing else on this page has any effect while it is empty, and every cost surface shows one figure per currency, as it does today.",
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={draftCurrency}
                disabled={!canEdit}
                maxLength={3}
                onChange={(e) => setDraftCurrency(e.target.value.toUpperCase())}
                placeholder="USD"
                aria-label={gt("Display currency")}
                className="w-24 px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60 uppercase"
              />
              {canEdit && (
                <>
                  <button
                    type="button"
                    onClick={() => void saveCurrency(normalizeCurrencyCode(draftCurrency))}
                    disabled={saving || normalizeCurrencyCode(draftCurrency) === null}
                    className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {saving ? gt("Saving…") : gt("Save")}
                  </button>
                  {displayCurrency && (
                    <button
                      type="button"
                      onClick={() => void saveCurrency(null)}
                      disabled={saving}
                      className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
                    >
                      {gt("Turn conversion off")}
                    </button>
                  )}
                </>
              )}
            </div>
            <p className="text-xs text-on-surface-faint">
              {displayCurrency
                ? gt(
                    "Converting into {currency}. Spend already in {currency} is passed through untouched; any other currency without a rate below is shown separately, never folded in or dropped.",
                    { currency: displayCurrency },
                  )
                : gt(
                    "Conversion is off. Cost graphs, budgets, showback and the weekly digest all report one figure per currency.",
                  )}
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{gt("Exchange rates")}</h2>
            <T>
              <p className="text-xs text-on-surface-muted">
                One rate per currency pair per effective date. A day&rsquo;s spend converts at the
                rate with the latest effective date on or before that day, so restating a rate does
                not rewrite periods you have already closed. Rates are used in one hop only &mdash;
                Infrawrench never inverts a rate or chains two through a third currency, because
                either would produce a number you never stated.
              </p>
            </T>

            {staleRates.length > 0 && (
              <div
                role="status"
                className="px-3 py-2 text-sm rounded-lg border border-amber-500/40 bg-amber-500/10"
              >
                <p className="text-warning">
                  {staleRates.length === 1
                    ? gt("One rate is not used")
                    : gt("{count} rates are not used", { count: staleRates.length })}
                </p>
                <p className="mt-1 text-xs text-on-surface-secondary">
                  {staleRates.length === 1
                    ? gt(
                        "It converts to a currency that is not your display currency ({currency}), so nothing reads it.",
                        { currency: displayCurrency },
                      )
                    : gt(
                        "They convert to a currency that is not your display currency ({currency}), so nothing reads them.",
                        { currency: displayCurrency },
                      )}
                </p>
              </div>
            )}

            {rates.length === 0 ? (
              <p className="text-sm text-on-surface-muted">
                {gt(
                  "No rates yet. Until you add one, every currency other than {currency} is reported on its own.",
                  { currency: displayCurrency ?? gt("your display currency") },
                )}
              </p>
            ) : (
              <div className="border border-border rounded-xl overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border text-xs text-on-surface-muted">
                      <th scope="col" className="text-left px-4 py-2 font-medium">
                        {gt("From")}
                      </th>
                      <th scope="col" className="text-left px-4 py-2 font-medium">
                        {gt("To")}
                      </th>
                      <th scope="col" className="text-right px-4 py-2 font-medium">
                        {gt("Rate")}
                      </th>
                      <th scope="col" className="text-left px-4 py-2 font-medium">
                        {gt("Effective from")}
                      </th>
                      {canEdit && <th scope="col" className="px-4 py-2" />}
                    </tr>
                  </thead>
                  <tbody>
                    {rates.map((rate) => (
                      <tr
                        key={rate.id}
                        className="border-b border-border/50 hover:bg-surface-raised/50"
                      >
                        <td className="px-4 py-2 text-sm text-on-surface-secondary">
                          {rate.fromCurrency}
                        </td>
                        <td className="px-4 py-2 text-sm text-on-surface-secondary">
                          {rate.toCurrency}
                          {displayCurrency && rate.toCurrency !== displayCurrency && (
                            <span className="ml-2 text-xs text-warning">{gt("unused")}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right text-sm tabular-nums text-on-surface-secondary">
                          {rate.rate}
                        </td>
                        <td className="px-4 py-2 text-sm text-on-surface-tertiary">
                          {rate.effectiveFrom}
                        </td>
                        {canEdit && (
                          <td className="px-4 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => void removeRate(rate)}
                              className="text-xs text-danger hover:text-danger-strong"
                            >
                              {gt("Remove")}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {canEdit && (
              <NewRateForm
                defaultTo={displayCurrency ?? ""}
                onSubmit={async (input) => {
                  // An upsert: same pair and date replaces, so editing a rate is
                  // re-adding it with the corrected number.
                  await api.put(`/api/org/${orgId}/currency/rates`, input);
                  await load();
                }}
                onError={setError}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * Add (or correct) one rate. Doubles as the editor: submitting the same pair
 * and effective date replaces the stored rate, which is what "fix the typo"
 * means for a table where two rates on one day would be ambiguous.
 */
function NewRateForm({
  defaultTo,
  onSubmit,
  onError,
}: {
  defaultTo: string;
  onSubmit: (input: ExchangeRateInput) => Promise<void>;
  onError: (message: string) => void;
}) {
  const gt = useGT();
  const [fromCurrency, setFromCurrency] = useState("");
  /**
   * `null` until the user types a destination, so the field tracks the org's
   * display currency while it is still loading and stops the moment they take
   * it over. Derived rather than synced by an effect: the effect version
   * rendered once with the stale value before correcting itself.
   */
  const [toCurrencyDraft, setToCurrencyDraft] = useState<string | null>(null);
  const toCurrency = toCurrencyDraft ?? defaultTo;
  const [rate, setRate] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const inputClass =
    "px-2.5 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong";

  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  const ready =
    from !== null && to !== null && from !== to && Number(rate) > 0 && effectiveFrom !== "";

  async function submit() {
    if (!ready) return;
    setSubmitting(true);
    try {
      await onSubmit({ fromCurrency: from, toCurrency: to, rate: rate.trim(), effectiveFrom });
      setFromCurrency("");
      setRate("");
      setEffectiveFrom("");
    } catch (e) {
      onError(e instanceof Error ? e.message : gt("Failed to save rate"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-border/50">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-on-surface-tertiary">{gt("From")}</span>
        <input
          type="text"
          value={fromCurrency}
          maxLength={3}
          onChange={(e) => setFromCurrency(e.target.value.toUpperCase())}
          placeholder="EUR"
          className={`${inputClass} w-20 uppercase`}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-on-surface-tertiary">{gt("To")}</span>
        <input
          type="text"
          value={toCurrency}
          maxLength={3}
          onChange={(e) => setToCurrencyDraft(e.target.value.toUpperCase())}
          placeholder="USD"
          className={`${inputClass} w-20 uppercase`}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-on-surface-tertiary">{gt("Rate")}</span>
        <input
          type="text"
          inputMode="decimal"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          placeholder="1.0850"
          className={`${inputClass} w-32 tabular-nums`}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-on-surface-tertiary">{gt("Effective from")}</span>
        <input
          type="date"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
          className={inputClass}
        />
      </label>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={submitting || !ready}
        className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
      >
        {submitting ? gt("Saving…") : gt("Add rate")}
      </button>
      <p className="basis-full text-xs text-on-surface-faint">
        {gt("1 {from} = {rate} {to}. Re-adding the same pair and date replaces the stored rate.", {
          from: from ?? gt("FROM"),
          rate: rate || "?",
          to: to ?? gt("TO"),
        })}
      </p>
    </div>
  );
}
