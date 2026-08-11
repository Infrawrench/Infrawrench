import { useMemo, useState } from "react";
import {
  QUOTA_SEVERITIES,
  QUOTA_SEVERITY_LABELS,
  formatDaysToExhaustion,
  formatQuotaAmount,
  formatQuotaUtilization,
  renderableHelpUrl,
  type QuotaAccountStatus,
  type QuotaListResponse,
  type QuotaRow,
  type QuotaSeverity,
} from "@infrawrench/client-core";

/**
 * Every URL on this screen originates in a plugin — a quota's `docsUrl`, the
 * manifest's `increaseUrl`, a failure's help link — and every one of them ends
 * up either in an anchor's `href` or at the host's `onOpenExternal`, which is
 * `window.open` on web and `shell.openExternal` on desktop.
 *
 * The server already refuses to store or serve an unsafe one. This is the
 * second end of the same check, and it is here rather than assumed away
 * because the server's guarantee is about *this* build of the server: a row
 * written before the rule existed, a future writer of the poll table, or a
 * desktop pointed at an older cloud all deliver values this component would
 * otherwise hand straight to a navigation sink. Refusing to render a link we
 * cannot validate costs a link; trusting the other end costs a click.
 */
function quotaLinkUrl(url: string | null | undefined): string | null {
  return renderableHelpUrl(url);
}

export interface QuotasSectionProps {
  /**
   * The feed, or null while the first load is in flight. Hosts fetch (web:
   * `/quotas`, desktop: IPC) and hand the response over — this component never
   * talks to a network.
   */
  data: QuotaListResponse | null;
  /**
   * Load or refresh failure. With `data` still present the last feed stays on
   * screen under a banner — a failed refresh must not blank a drawn list.
   */
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** Open a provider docs/increase page. Omitted, the link is not rendered. */
  onOpenExternal?: ((url: string) => void) | undefined;
}

type GroupBy = "account" | "service" | "severity";

const GROUP_OPTIONS: Array<{ key: GroupBy; label: string }> = [
  { key: "account", label: "Account" },
  { key: "service", label: "Service" },
  { key: "severity", label: "Severity" },
];

/** Pill tones per bucket, matching the ExpirySection recipe. */
const SEVERITY_BADGE_CLASSES: Record<QuotaSeverity, string> = {
  exhausted: "bg-red-500/10 text-red-400",
  critical: "bg-orange-500/10 text-orange-400",
  trending: "bg-amber-500/10 text-amber-400",
  ok: "bg-surface-overlay text-on-surface-tertiary",
};

/**
 * Bar fills. The `ok` bar is deliberately a muted neutral rather than green:
 * green reads as an assertion that everything is fine, and a bar the radar has
 * simply not found a problem with is not the same claim.
 */
const SEVERITY_BAR_CLASSES: Record<QuotaSeverity, string> = {
  exhausted: "bg-red-500",
  critical: "bg-orange-500",
  trending: "bg-amber-500",
  ok: "bg-on-surface-faint",
};

const SEVERITY_TEXT_CLASSES: Record<QuotaSeverity, string> = {
  exhausted: "text-red-400",
  critical: "text-orange-400",
  trending: "text-amber-400",
  ok: "text-on-surface-tertiary",
};

interface QuotaGroup {
  key: string;
  title: string;
  subtitle: string | null;
  rows: QuotaRow[];
}

function buildGroups(rows: QuotaRow[], groupBy: GroupBy): QuotaGroup[] {
  const groups = new Map<string, QuotaGroup>();
  for (const row of rows) {
    let key: string;
    let title: string;
    let subtitle: string | null = null;
    if (groupBy === "account") {
      key = row.accountId;
      title = row.accountName;
      subtitle = row.pluginId;
    } else if (groupBy === "service") {
      key = `${row.pluginId}:${row.service}`;
      title = row.service;
      subtitle = row.pluginId;
    } else {
      key = row.severity;
      title = QUOTA_SEVERITY_LABELS[row.severity];
    }
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { key, title, subtitle, rows: [row] });
  }

  // Rows arrive pre-sorted worst-first, so insertion order already ranks
  // account/service groups by their most urgent row. Severity groups follow
  // the escalation order instead — "At the limit" belongs on top.
  if (groupBy === "severity") {
    return QUOTA_SEVERITIES.flatMap((s) => {
      const group = groups.get(s);
      return group ? [group] : [];
    });
  }
  return [...groups.values()];
}

/**
 * The utilisation bar.
 *
 * Two details that carry the meaning:
 *
 * - The **threshold marker** is drawn on every bar, so a row's colour is never
 *   the only evidence of where the line is — a reader can see that 74% is
 *   close to their 80% without reading the settings page.
 * - An **over-quota** bar fills completely and says so in the figure beside
 *   it, rather than overflowing its track. The number is where over-100% is
 *   reported; the bar is a bar.
 */
function UtilizationBar({ row, threshold }: { row: QuotaRow; threshold: number }) {
  const pct = Math.min(1, Math.max(0, row.utilization)) * 100;
  const markerPct = Math.min(100, Math.max(0, threshold * 100));
  return (
    <div
      className="relative h-2 w-full min-w-24 overflow-hidden rounded-full bg-surface-overlay"
      role="img"
      aria-label={`${formatQuotaUtilization(row.utilization)} of the limit used`}
    >
      <div
        className={`h-full rounded-full ${SEVERITY_BAR_CLASSES[row.severity]}`}
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute inset-y-0 w-px bg-on-surface-faint/60"
        style={{ left: `${markerPct}%` }}
        title={`Alert threshold — ${formatQuotaUtilization(threshold)}`}
      />
    </div>
  );
}

/**
 * The honesty panel: accounts whose collection is failing, and providers that
 * cannot report quotas at all.
 *
 * Rendered above the table rather than below it, and never collapsed, because
 * an empty or short list *is* the thing these explain. A reader who does not
 * see this cannot tell "nothing is near a limit" from "nothing was collected".
 */
function CoverageNotes({
  accounts,
  unsupportedPluginIds,
}: {
  accounts: QuotaAccountStatus[];
  unsupportedPluginIds: string[];
}) {
  const failing = accounts.filter((a) => a.lastError !== null);
  const pending = accounts.filter((a) => a.lastError === null && a.lastPolledAt === null);
  const partial = accounts.filter((a) => a.partial && a.lastError === null);

  if (
    failing.length === 0 &&
    pending.length === 0 &&
    partial.length === 0 &&
    unsupportedPluginIds.length === 0
  ) {
    return null;
  }

  return (
    <div className="mb-4 flex flex-col gap-2 text-xs">
      {failing.map((account) => (
        <p key={account.accountId} role="alert" className="text-red-400">
          <span className="font-medium">{account.accountName}</span> — quotas could not be read:{" "}
          {account.lastError}
          {quotaLinkUrl(account.lastErrorHelpUrl) && (
            <>
              {" "}
              <a
                href={quotaLinkUrl(account.lastErrorHelpUrl)!}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {account.lastErrorHelpLabel ?? "How to fix this"}
              </a>
            </>
          )}
        </p>
      ))}
      {pending.length > 0 && (
        <p className="text-on-surface-faint">
          Not collected yet: {pending.map((a) => a.accountName).join(", ")}. The first reading lands
          within a few hours of adding an account.
        </p>
      )}
      {partial.length > 0 && (
        <p className="text-on-surface-faint">
          {partial.map((a) => a.accountName).join(", ")} report a representative subset of their
          provider&apos;s quotas, not all of them — an absent row means unmeasured, not headroom.
        </p>
      )}
      {unsupportedPluginIds.length > 0 && (
        <p className="text-on-surface-faint">
          No quota API: {unsupportedPluginIds.join(", ")}. Their limits exist but are not readable —
          nothing is shown for them rather than zero.
        </p>
      )}
    </div>
  );
}

/**
 * The Quota radar: how close every account is to the limits its provider
 * enforces, with the trend that says whether it is getting closer. Shared by
 * the web and desktop Quotas screens.
 *
 * The screen's whole reason for existing is that quota exhaustion is currently
 * discovered mid-incident: the provider does not warn you, and the console
 * shows the limit only if you go looking for it per-service per-region.
 */
export function QuotasSection({ data, error, onRetry, onOpenExternal }: QuotasSectionProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>("account");
  const [onlyAtRisk, setOnlyAtRisk] = useState(false);

  const visible = useMemo(
    () => (data ? (onlyAtRisk ? data.rows.filter((r) => r.severity !== "ok") : data.rows) : []),
    [data, onlyAtRisk],
  );
  const groups = useMemo(() => buildGroups(visible, groupBy), [visible, groupBy]);
  const counts = useMemo(() => {
    const out: Record<QuotaSeverity, number> = { exhausted: 0, critical: 0, trending: 0, ok: 0 };
    for (const row of data?.rows ?? []) out[row.severity] += 1;
    return out;
  }, [data]);

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">Quotas</h1>
      <p className="text-sm text-on-surface-muted mb-6">
        How close each account is to the limits its provider enforces. Both the used figure and the
        limit come from the provider — nothing is assumed from published defaults, so an approved
        increase shows as the headroom you actually have.
      </p>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-red-500">
          Couldn&apos;t load the quota radar — {error}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              Retry
            </button>
          )}
        </div>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Reading collected quotas…
        </p>
      )}
      {error != null && data !== null && (
        <p role="alert" className="mb-4 text-xs text-red-400">
          Couldn&apos;t refresh — showing the last loaded readings. {error}
        </p>
      )}

      {data !== null && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {QUOTA_SEVERITIES.map((severity) => (
              <span
                key={severity}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${SEVERITY_BADGE_CLASSES[severity]}`}
              >
                <span className="tabular-nums">{counts[severity]}</span>
                {severity === "critical"
                  ? `Over ${formatQuotaUtilization(data.threshold)}`
                  : QUOTA_SEVERITY_LABELS[severity]}
              </span>
            ))}
          </div>

          <CoverageNotes
            accounts={data.accounts}
            unsupportedPluginIds={data.unsupportedPluginIds}
          />

          {data.rows.length === 0 ? (
            <p className="text-sm text-on-surface-faint">
              No quota readings yet. Quotas are collected a few times a day from the providers that
              expose them — AWS, GCP, DigitalOcean and Kubernetes today. An account on a provider
              with no quota API contributes nothing here rather than a reassuring zero.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div
                  role="group"
                  aria-label="Group quotas by"
                  className="flex items-center gap-1 text-xs"
                >
                  <span className="text-on-surface-faint mr-1">Group by</span>
                  <div className="flex rounded-lg border border-border overflow-hidden">
                    {GROUP_OPTIONS.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => setGroupBy(option.key)}
                        aria-pressed={groupBy === option.key}
                        className={`px-2.5 py-1 transition-colors ${
                          groupBy === option.key
                            ? "bg-surface-overlay text-on-surface"
                            : "text-on-surface-tertiary hover:text-on-surface-secondary"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setOnlyAtRisk((v) => !v)}
                  aria-pressed={onlyAtRisk}
                  className="rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary hover:text-on-surface-secondary transition-colors"
                >
                  {onlyAtRisk ? "Showing at risk only" : "Show all"}
                </button>
              </div>

              {visible.length === 0 ? (
                <p className="text-sm text-on-surface-faint">
                  Nothing is at or heading for a limit. {data.rows.length} quota
                  {data.rows.length === 1 ? "" : "s"} tracked.
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  {groups.map((group) => (
                    <div key={group.key} className="flex flex-col gap-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="text-sm font-medium text-on-surface">
                          {group.title}
                          {group.subtitle && (
                            <span className="ml-2 font-normal text-on-surface-tertiary">
                              {group.subtitle}
                            </span>
                          )}
                        </h2>
                        <span className="text-xs text-on-surface-faint">
                          {group.rows.length} quota{group.rows.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="border border-border rounded-xl overflow-hidden">
                        <table className="w-full text-sm">
                          <tbody>
                            {group.rows.map((row) => (
                              <tr
                                key={`${row.accountId}:${row.key}`}
                                className="border-b border-border last:border-b-0"
                              >
                                <td className="px-4 py-2.5 font-medium text-on-surface">
                                  {row.name}
                                  {row.region && (
                                    <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[11px] font-normal text-on-surface-tertiary">
                                      {row.region}
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2.5 whitespace-nowrap text-xs text-on-surface-tertiary">
                                  {groupBy === "account" ? row.service : row.accountName}
                                </td>
                                <td className="px-3 py-2.5 w-full">
                                  <UtilizationBar row={row} threshold={data.threshold} />
                                </td>
                                <td className="px-3 py-2.5 whitespace-nowrap text-right tabular-nums text-on-surface-secondary">
                                  {formatQuotaAmount(row.used, row.unit)}
                                  <span className="text-on-surface-faint">
                                    {" "}
                                    / {formatQuotaAmount(row.limit, row.unit)}
                                  </span>
                                </td>
                                <td
                                  className={`px-3 py-2.5 whitespace-nowrap text-right tabular-nums font-medium ${SEVERITY_TEXT_CLASSES[row.severity]}`}
                                >
                                  {formatQuotaUtilization(row.utilization)}
                                </td>
                                <td className="px-3 py-2.5 whitespace-nowrap text-right text-xs">
                                  {row.trend.daysToExhaustion !== null ? (
                                    <span
                                      className={SEVERITY_TEXT_CLASSES[row.severity]}
                                      title={`Fitted over ${row.trend.points} readings from the last 14 days.`}
                                    >
                                      full {formatDaysToExhaustion(row.trend.daysToExhaustion)}
                                    </span>
                                  ) : (
                                    <span
                                      className="text-on-surface-faint"
                                      title={
                                        row.trend.perDay === null
                                          ? "Not enough history to fit a trend yet — this is not a statement that the quota is safe."
                                          : "Flat or falling over the last 14 days."
                                      }
                                    >
                                      {row.trend.perDay === null ? "no trend yet" : "not rising"}
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 whitespace-nowrap text-right">
                                  {row.adjustable === false ? (
                                    <span
                                      className="text-[11px] text-on-surface-faint"
                                      title="The provider does not accept increase requests for this quota — the workload has to change instead."
                                    >
                                      hard limit
                                    </span>
                                  ) : quotaLinkUrl(row.docsUrl) && onOpenExternal ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const url = quotaLinkUrl(row.docsUrl);
                                        if (url) onOpenExternal(url);
                                      }}
                                      className="text-[11px] text-on-surface-tertiary underline hover:text-on-surface-secondary"
                                    >
                                      {row.adjustable === true ? "Request increase" : "Docs"}
                                    </button>
                                  ) : null}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <p className="mt-4 text-xs text-on-surface-faint">
                Readings are collected from your providers&apos; quota APIs a few times a day, so
                the figures are as fresh as the last pass. The trend is a least-squares fit over the
                last 14 days and only reports an exhaustion date inside 30 days — beyond that a line
                through provisioning history says nothing useful. The marker on each bar is your
                organization&apos;s {formatQuotaUtilization(data.threshold)} alert threshold.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
