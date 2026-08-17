import { useCallback, useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import { formatAckRate, type NoiseReport, type NoisyFinding } from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

/**
 * The alert noise report, as a card on the Notifications page.
 *
 * It sits directly beneath the routing rules on purpose: this is a reading *of*
 * those rules, and the person who should see "nobody has ever acknowledged this
 * one" is the person looking at the rule that produced it.
 *
 * Nothing here mutates anything. The card names a rule and says what a person
 * might do; a button that muted an alert on this page's own heuristic would be
 * the fastest way to make the whole feature untrustworthy.
 */
export function AlertNoiseCard() {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [report, setReport] = useState<NoiseReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(30);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReport(
        await api.get<NoiseReport>(`/api/org/${orgId}/alert-rules/noise?windowDays=${windowDays}`),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load the alert noise report"));
    }
  }, [api, orgId, windowDays]);

  useEffect(() => {
    void load();
  }, [load]);

  function reasonLabel(finding: NoisyFinding): string {
    switch (finding.reason) {
      case "never-acknowledged":
        return gt("Never acknowledged");
      case "mostly-ignored":
        return gt("Mostly ignored");
      case "very-frequent":
        return gt("Too frequent to read");
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="text-sm font-medium text-on-surface">{gt("Is anybody reading these?")}</h3>
        <select
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          aria-label={gt("Window")}
          className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-on-surface"
        >
          <option value={7}>{gt("Last 7 days")}</option>
          <option value={30}>{gt("Last 30 days")}</option>
          <option value={90}>{gt("Last 90 days")}</option>
        </select>
      </div>

      <T>
        <p className="text-xs text-on-surface-muted">
          Routing decides where an alert goes. This is the other half: whether anybody acted on it.
          Only an explicit acknowledgement counts — a message that was sent is not a message that
          was read.
        </p>
      </T>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      {report === null && !error && (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Reading the delivery log…")}
        </p>
      )}

      {report !== null && (
        <>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <div className="flex items-baseline gap-1">
              <dt className="text-on-surface-faint">{gt("Delivered")}</dt>
              <dd className="tabular-nums text-on-surface">{report.totalDeliveries}</dd>
            </div>
            <div className="flex items-baseline gap-1">
              <dt className="text-on-surface-faint">{gt("Asked for a response")}</dt>
              <dd className="tabular-nums text-on-surface">{report.actionableDeliveries}</dd>
            </div>
            <div className="flex items-baseline gap-1">
              <dt className="text-on-surface-faint">{gt("Acknowledged")}</dt>
              <dd className="tabular-nums text-on-surface">{report.acknowledgedDeliveries}</dd>
            </div>
          </dl>

          {report.noisy.length === 0 ? (
            <p className="text-xs text-on-surface-faint">
              {report.totalDeliveries === 0
                ? gt("No alerts were delivered in this window.")
                : gt(
                    "Nothing looks like noise. Every rule that fires often enough to judge is being acted on.",
                  )}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {report.noisy.map((finding) => (
                <li key={finding.key} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium text-on-surface">{finding.label}</span>
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-warning">
                      {reasonLabel(finding)}
                    </span>
                    <span className="text-xs tabular-nums text-on-surface-tertiary">
                      {gt("{count} delivered · {rate} acknowledged", {
                        count: finding.count,
                        rate: formatAckRate(finding.acknowledgedRate),
                      })}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-on-surface-tertiary">{finding.suggestion}</p>
                </li>
              ))}
            </ul>
          )}

          {report.byRule.length > 0 && (
            <details className="text-xs text-on-surface-tertiary">
              <summary className="cursor-pointer">{gt("Every rule, loudest first")}</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {report.byRule.map((group) => (
                  <li key={group.key} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-on-surface">{group.label}</span>
                    <span className="tabular-nums">{group.count}</span>
                    <span className="text-on-surface-faint">
                      {gt("{rate} acknowledged", { rate: formatAckRate(group.acknowledgedRate) })}
                    </span>
                    {group.medianAckMinutes !== null && (
                      <span className="text-on-surface-faint">
                        {gt("median {minutes}m", {
                          minutes: Math.round(group.medianAckMinutes),
                        })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
