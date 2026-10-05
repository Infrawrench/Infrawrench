import { T, Var, useGT } from "gt-react";
import {
  COST_CHARGE_TYPE_LABELS,
  type CostChargeType,
  type PricingEffect,
  type PricingPreviewResult,
  type RerateCoverage,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";

/** Money in its own currency, falling back to a plain figure for odd codes. */
export function formatPricingMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function signed(amount: number, currency: string): string {
  const text = formatPricingMoney(amount, currency);
  return amount > 0 ? `+${text}` : text;
}

/**
 * The effect list: every rule or setting that moved money, in the order the
 * money moved, with what it did per currency. Shared by the preview, the
 * invoice derivation and the customer editor so "which rule changed what"
 * reads the same everywhere.
 */
export function PricingEffectsList({ effects }: { effects: readonly PricingEffect[] }) {
  const gt = useGT();
  const gtData = useDataString();
  if (effects.length === 0) {
    return <p className="text-xs text-on-surface-muted">{gt("Nothing changed any amount.")}</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {effects.map((effect) => (
        <li key={effect.key} className="flex items-baseline justify-between gap-3">
          <span className="text-on-surface-secondary">{gtData(effect.label)}</span>
          <span className="tabular-nums text-on-surface">
            {Object.entries(effect.totals)
              .map(([currency, amount]) => signed(amount, currency))
              .join(" · ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * How much in-scope usage was re-rated from a provider list price, and how
 * much fell back to the uplift. Stated as a share, because "re-rated to public
 * pricing" means something different at 98% coverage than at 20%.
 */
export function RerateCoverageView({ coverage }: { coverage: RerateCoverage }) {
  const gt = useGT();
  const entries = Object.entries(coverage.byCurrency);
  if (entries.length === 0) {
    return <p className="text-xs text-on-surface-muted">{gt("No usage in scope to re-rate.")}</p>;
  }
  return (
    <div className="flex flex-col gap-1 text-xs">
      {entries.map(([currency, c]) => {
        const total = c.listPriced + c.fallback;
        const share = total === 0 ? 0 : Math.round((c.listPriced / total) * 100);
        return (
          <div key={currency} className="flex flex-col gap-0.5">
            <T>
              <span className="text-on-surface-secondary">
                <Var>{share}</Var>% of in-scope usage re-rated from a provider list price (
                <Var>{formatPricingMoney(c.listPriced, currency)}</Var> collected, listing at{" "}
                <Var>{formatPricingMoney(c.listTotal, currency)}</Var>);{" "}
                <Var>{formatPricingMoney(c.fallback, currency)}</Var> had no list price and was
                uplifted instead.
              </span>
            </T>
            <div
              className="h-1.5 w-full overflow-hidden rounded bg-surface-sunken"
              role="img"
              aria-label={gt("{share}% re-rated from a list price", { share })}
            >
              <div className="h-full bg-info" style={{ width: `${share}%` }} />
            </div>
          </div>
        );
      })}
      {coverage.services.length > 0 && (
        <details>
          <summary className="cursor-pointer text-on-surface-muted">{gt("By service")}</summary>
          <table className="mt-1 w-full text-left">
            <thead className="text-on-surface-muted">
              <tr>
                <th className="font-normal">{gt("Service")}</th>
                <th className="text-right font-normal">{gt("List-priced")}</th>
                <th className="text-right font-normal">{gt("Fallback")}</th>
              </tr>
            </thead>
            <tbody>
              {coverage.services.map((s) => (
                <tr key={`${s.pluginId}/${s.service}/${s.currency}`}>
                  <td className="text-on-surface-secondary">
                    {s.pluginId} {s.service}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatPricingMoney(s.listPriced, s.currency)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatPricingMoney(s.fallback, s.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

/** The full answer to "what would this do to last month". */
export function PricingPreviewView({ result }: { result: PricingPreviewResult }) {
  const gt = useGT();
  const gtData = useDataString();
  const currencies = [
    ...new Set([
      ...Object.keys(result.collected),
      ...Object.keys(result.before),
      ...Object.keys(result.after),
    ]),
  ].sort();

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-3">
      <T>
        <p className="text-xs text-on-surface-muted">
          Priced <Var>{result.from}</Var> to <Var>{result.to}</Var> over{" "}
          <Var>{result.lineCount}</Var> grouped cost lines. Nothing was saved. Without: current
          rules, minus this one. With: including it or the settings being tried.
        </p>
      </T>

      {currencies.length === 0 ? (
        <p className="text-xs text-on-surface-muted">{gt("No spend in scope for that month.")}</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-on-surface-muted">
            <tr>
              <th className="font-normal">{gt("Currency")}</th>
              <th className="text-right font-normal">{gt("Collected")}</th>
              <th className="text-right font-normal">{gt("Without")}</th>
              <th className="text-right font-normal">{gt("With")}</th>
              <th className="text-right font-normal">{gt("Difference")}</th>
            </tr>
          </thead>
          <tbody>
            {currencies.map((currency) => {
              const before = result.before[currency] ?? 0;
              const after = result.after[currency] ?? 0;
              return (
                <tr key={currency}>
                  <td>{currency}</td>
                  <td className="text-right tabular-nums">
                    {formatPricingMoney(result.collected[currency] ?? 0, currency)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatPricingMoney(before, currency)}
                  </td>
                  <td className="text-right tabular-nums">{formatPricingMoney(after, currency)}</td>
                  <td className="text-right tabular-nums">{signed(after - before, currency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {result.expressionFailures.length > 0 && (
        <ul role="alert" className="flex flex-col gap-0.5 text-xs text-warning">
          {result.expressionFailures.map((f) => (
            <li key={f.ruleId}>
              {gt("{name}: {count} line(s) kept their cost because {message}", {
                name: f.name,
                count: f.lines,
                message: f.message,
              })}
            </li>
          ))}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-warning">
          {result.warnings.map((w) => (
            <li key={w}>{gtData(w)}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-on-surface">
          {gt("What changed what, in order")}
        </span>
        <PricingEffectsList effects={result.effects} />
      </div>

      {result.coverage && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-on-surface">{gt("Re-rating coverage")}</span>
          <RerateCoverageView coverage={result.coverage} />
        </div>
      )}

      {result.changes.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-on-surface">{gt("Lines that moved most")}</span>
          <table className="w-full text-left text-xs">
            <thead className="text-on-surface-muted">
              <tr>
                <th className="font-normal">{gt("Service")}</th>
                <th className="font-normal">{gt("Account")}</th>
                <th className="font-normal">{gt("Charge type")}</th>
                <th className="text-right font-normal">{gt("Without")}</th>
                <th className="text-right font-normal">{gt("With")}</th>
              </tr>
            </thead>
            <tbody>
              {result.changes.map((c) => (
                <tr
                  key={`${c.pluginId}/${c.service}/${c.accountName}/${c.chargeType}/${c.currency}`}
                >
                  <td className="text-on-surface-secondary">
                    {c.pluginId} {c.service}
                  </td>
                  <td className="text-on-surface-secondary">{c.accountName}</td>
                  <td className="text-on-surface-secondary">
                    {gtData(
                      COST_CHARGE_TYPE_LABELS[c.chargeType as CostChargeType] ?? c.chargeType,
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatPricingMoney(c.before, c.currency)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatPricingMoney(c.after, c.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
