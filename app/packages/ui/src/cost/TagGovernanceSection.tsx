import { useEffect, useState } from "react";

import { formatMoney, taggedSpendPercent } from "@infrawrench/client-core";
import type {
  ShowbackReport,
  TagComplianceReport,
  UntaggedSpendReport,
} from "@infrawrench/client-core";
import type { CostsClient } from "./types.js";

/**
 * Tag governance on the Costs panel: per-account compliance with the org's
 * tag policy, spend not carrying the required keys, and the showback split by
 * cost centre. Read-only here — the policy, centres, and rules are edited in
 * org settings (web) — so the section renders for every host that wires the
 * three read calls, desktop included.
 */
export function TagGovernanceSection({ client }: { client: CostsClient }) {
  const [compliance, setCompliance] = useState<TagComplianceReport | null>(null);
  const [untagged, setUntagged] = useState<UntaggedSpendReport | null>(null);
  const [showback, setShowback] = useState<ShowbackReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wired = Boolean(client.getTagCompliance && client.getUntaggedSpend && client.getShowback);

  useEffect(() => {
    if (!wired) return;
    let cancelled = false;
    Promise.all([client.getTagCompliance!(), client.getUntaggedSpend!(), client.getShowback!()])
      .then(([complianceNext, untaggedNext, showbackNext]) => {
        if (cancelled) return;
        setCompliance(complianceNext);
        setUntagged(untaggedNext);
        setShowback(showbackNext);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, wired]);

  if (!wired) return null;

  const hasPolicy = (compliance?.policy.requiredTags.length ?? 0) > 0;
  const centresWithSpend = (showback?.centres ?? []).filter(
    (c) => Object.keys(c.totals).length > 0 || c.costCentreId !== null,
  );
  const hasShowback = centresWithSpend.length > 0;

  if (error === null && compliance === null) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-on-surface">Tags &amp; allocation</h2>
        <p role="status" className="text-sm text-on-surface-faint">
          Loading tag governance…
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-on-surface">Tags &amp; allocation</h2>

      {error !== null && (
        <div role="alert" className="text-sm text-red-500">
          Couldn&rsquo;t load tag governance — {error}
        </div>
      )}

      {error === null && !hasPolicy && !hasShowback && (
        <p className="text-sm text-on-surface-faint">
          No tag policy or cost centres configured. An org admin can require tags like{" "}
          <code className="text-on-surface-secondary">owner</code> and{" "}
          <code className="text-on-surface-secondary">env</code> on every resource, and map spend to
          cost centres, under Settings → Tag Policy.
        </p>
      )}

      {hasPolicy && untagged && (
        <div className="rounded-xl border border-border bg-surface-raised p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-on-surface">Untagged spend</h3>
            <span className="text-xs text-on-surface-faint">
              last 30 days · requires {untagged.requiredKeys.join(", ")}
            </span>
          </div>
          {untagged.currencies.length === 0 && (
            <p className="text-sm text-on-surface-faint">No spend collected in this period.</p>
          )}
          {untagged.currencies.map((currency) => {
            const pct = taggedSpendPercent(untagged, currency);
            return (
              <div key={currency} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-on-surface">
                  {formatMoney(untagged.untaggedTotals[currency] ?? 0, currency)}{" "}
                  <span className="text-on-surface-faint">
                    of {formatMoney(untagged.totals[currency] ?? 0, currency)} missing a required
                    tag
                  </span>
                </span>
                {pct !== null && (
                  <span className="text-xs text-on-surface-secondary">{pct}% fully tagged</span>
                )}
              </div>
            );
          })}
          {untagged.topUntagged.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-on-surface-faint">
              {untagged.topUntagged.slice(0, 5).map((row) => (
                <li
                  key={`${row.accountId}:${row.service}:${row.currency}`}
                  className="flex justify-between gap-3"
                >
                  <span className="truncate">
                    {row.accountLabel}
                    {row.service ? ` · ${row.service}` : ""}
                  </span>
                  <span>{formatMoney(row.amount, row.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {hasPolicy && compliance && (
        <div className="rounded-xl border border-border bg-surface-raised p-4 flex flex-col gap-2">
          <h3 className="text-sm font-medium text-on-surface">Tag compliance by account</h3>
          {compliance.accounts.length === 0 && (
            <p className="text-sm text-on-surface-faint">No accounts connected.</p>
          )}
          <ul className="flex flex-col gap-1.5">
            {compliance.accounts.map((account) => (
              <li key={account.accountId} className="flex items-center gap-3 text-sm">
                <span className="flex-1 truncate text-on-surface">{account.displayName}</span>
                {account.score === null ? (
                  <span
                    className="text-xs text-on-surface-faint"
                    title="No resource on this account exposes a tags/labels field"
                  >
                    no taggable resources
                  </span>
                ) : (
                  <>
                    <span className="w-28 h-1.5 rounded-full bg-surface-sunken overflow-hidden">
                      <span
                        className={`block h-full rounded-full ${
                          account.score >= 90
                            ? "bg-emerald-500"
                            : account.score >= 50
                              ? "bg-amber-500"
                              : "bg-red-500"
                        }`}
                        style={{ width: `${account.score}%` }}
                      />
                    </span>
                    <span className="w-24 text-right text-xs text-on-surface-secondary">
                      {account.score}% ({account.compliant}/{account.evaluated})
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasShowback && showback && (
        <div className="rounded-xl border border-border bg-surface-raised p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-on-surface">Showback by cost centre</h3>
            <span className="text-xs text-on-surface-faint">last 30 days</span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {showback.centres.map((centre) => (
              <li
                key={centre.costCentreId ?? "__unallocated__"}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <span
                  className={
                    centre.costCentreId === null
                      ? "text-on-surface-faint italic"
                      : "text-on-surface"
                  }
                >
                  {centre.name}
                </span>
                <span className="text-on-surface-secondary">
                  {Object.keys(centre.totals).length === 0
                    ? "—"
                    : Object.entries(centre.totals)
                        .map(([currency, amount]) => formatMoney(amount, currency))
                        .join(" + ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
