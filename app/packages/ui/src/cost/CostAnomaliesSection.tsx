import { COST_ANOMALY_DIMENSION_LABELS } from "@infrawrench/client-core";
import { useEffect, useState } from "react";

import { formatMoney } from "./transform.js";
import type { CostAnomaly, CostsClient } from "./types.js";

/** How far back the section looks, in days. */
const WINDOW_DAYS = 30;

function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "+173%" over baseline; null when the baseline is zero. */
function deltaPercent(anomaly: CostAnomaly): string | null {
  if (anomaly.baselineCents <= 0) return null;
  const pct = ((anomaly.actualCents - anomaly.baselineCents) / anomaly.baselineCents) * 100;
  return `+${Math.round(pct)}%`;
}

export interface CostAnomaliesSectionProps {
  client: CostsClient;
}

/**
 * Recent spend anomalies — days where a provider's or service's spend cleared
 * the trailing-baseline threshold. Read-only: detection runs server-side after
 * each cost collection, so there is nothing to configure here beyond the
 * notification toggles in settings.
 */
export function CostAnomaliesSection({ client }: CostAnomaliesSectionProps) {
  const [anomalies, setAnomalies] = useState<CostAnomaly[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const listAnomalies = client.listAnomalies;
    if (!listAnomalies) return;
    let cancelled = false;
    // Awaited inside try/catch rather than chained off .catch(): a host's
    // implementation may throw *synchronously* (desktop's requires cloud mode
    // and throws when there is no active org), and a synchronous throw escapes
    // a promise chain entirely — straight past .catch() and into the nearest
    // error boundary, taking the app down.
    void (async () => {
      try {
        const rows = await listAnomalies(WINDOW_DAYS);
        if (!cancelled) {
          setAnomalies(rows);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (!client.listAnomalies) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-on-surface">Anomalies</h2>

      {error !== null && (
        <div role="alert" className="text-sm text-red-500">
          Couldn&rsquo;t load anomalies — {error}
        </div>
      )}

      {anomalies === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Loading anomalies…
        </p>
      )}

      {anomalies?.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          No spend anomalies in the last {WINDOW_DAYS} days. Detection compares each day&rsquo;s
          spend per provider and per service against its trailing 28-day baseline and flags
          statistically unusual spikes.
        </p>
      )}

      {anomalies !== null && anomalies.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-on-surface-faint">
                <th className="px-3 py-2 font-medium">Day</th>
                <th className="px-3 py-2 font-medium">What</th>
                <th className="px-3 py-2 font-medium text-right">Spend</th>
                <th className="px-3 py-2 font-medium text-right">Baseline / day</th>
                <th className="px-3 py-2 font-medium text-right">Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {anomalies.map((a) => {
                const delta = deltaPercent(a);
                return (
                  <tr key={a.id} className="text-on-surface-secondary">
                    <td className="whitespace-nowrap px-3 py-2">{formatDay(a.day)}</td>
                    <td className="px-3 py-2">
                      <span className="text-on-surface">{a.dimensionKey}</span>{" "}
                      <span className="text-xs text-on-surface-faint">
                        {COST_ANOMALY_DIMENSION_LABELS[a.dimension]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-on-surface">
                      {formatMoney(a.actualCents / 100, a.currency)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {formatMoney(a.baselineCents / 100, a.currency)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-red-500">
                      {delta ?? "new"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
