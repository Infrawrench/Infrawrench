import { useMemo, useState } from "react";
import {
  EXPIRY_KIND_LABELS,
  EXPIRY_SEVERITIES,
  type ExpiryItem,
  type ExpiryListResponse,
  type ExpirySeverity,
} from "@infrawrench/client-core";

export interface ExpirySectionProps {
  /**
   * The computed feed, or null while the first load is in flight. Hosts fetch
   * (web: `/expiring`, desktop: IPC or the local scan) and hand the response
   * over — this component never talks to a network.
   */
  data: ExpiryListResponse | null;
  /**
   * Load or refresh failure. With `data` still present the last feed stays on
   * screen under a banner — a failed refresh must not blank a drawn list.
   */
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** Jump to an item's resource detail view. Omitted, names are plain text. */
  onOpenResource?: ((item: ExpiryItem) => void) | undefined;
}

type GroupBy = "kind" | "account" | "severity";

const GROUP_OPTIONS: Array<{ key: GroupBy; label: string }> = [
  { key: "kind", label: "Kind" },
  { key: "account", label: "Account" },
  { key: "severity", label: "Severity" },
];

const SEVERITY_LABELS: Record<ExpirySeverity, string> = {
  expired: "Expired",
  critical: "Under 7 days",
  warning: "Under 30 days",
  upcoming: "Within lead time",
  ok: "Later",
};

/** Pill tones per bucket, matching ChangeKindBadge's translucent-badge recipe. */
const SEVERITY_BADGE_CLASSES: Record<ExpirySeverity, string> = {
  expired: "bg-red-500/10 text-red-400",
  critical: "bg-orange-500/10 text-orange-400",
  warning: "bg-amber-500/10 text-amber-400",
  upcoming: "bg-blue-500/10 text-blue-400",
  ok: "bg-surface-overlay text-on-surface-tertiary",
};

const SEVERITY_TEXT_CLASSES: Record<ExpirySeverity, string> = {
  expired: "text-red-400",
  critical: "text-orange-400",
  warning: "text-amber-400",
  upcoming: "text-blue-400",
  ok: "text-on-surface-tertiary",
};

/** "in 12d" / "due today" / "expired 3d ago" — the row's countdown text. */
export function formatDaysRemaining(daysRemaining: number): string {
  if (daysRemaining < 0) return `expired ${-daysRemaining}d ago`;
  if (daysRemaining === 0) return "due today";
  return `in ${daysRemaining}d`;
}

interface ExpiryGroup {
  key: string;
  title: string;
  /** Secondary text after the title, e.g. the plugin name for account groups. */
  subtitle: string | null;
  items: ExpiryItem[];
}

/** Chip text for the summary header; the lead bucket names the org's window. */
function severitySummaryLabel(severity: ExpirySeverity, leadDays: number): string {
  if (severity === "upcoming") return `Within ${leadDays}d lead`;
  return SEVERITY_LABELS[severity];
}

function buildGroups(items: ExpiryItem[], groupBy: GroupBy, soonestFirst: boolean): ExpiryGroup[] {
  // Copy-then-sort: the app targets ES2022, so no toSorted. Ties break on the
  // shared contract's secondary keys so the order is stable across refreshes.
  const sorted = [...items].sort((a, b) => {
    const byDue =
      a.dueAt.localeCompare(b.dueAt) ||
      a.displayName.localeCompare(b.displayName) ||
      a.fieldKey.localeCompare(b.fieldKey);
    return soonestFirst ? byDue : -byDue;
  });

  const groups = new Map<string, ExpiryGroup>();
  for (const item of sorted) {
    let key: string;
    let title: string;
    let subtitle: string | null = null;
    if (groupBy === "kind") {
      key = item.kind;
      title = EXPIRY_KIND_LABELS[item.kind];
    } else if (groupBy === "account") {
      key = item.accountId;
      title = item.accountName;
      subtitle = item.pluginName;
    } else {
      key = item.severity;
      title = SEVERITY_LABELS[item.severity];
    }
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, { key, title, subtitle, items: [item] });
  }

  // Items arrive pre-sorted, so insertion order already ranks kind/account
  // groups by their most urgent item. Severity groups follow the escalation
  // order instead — "Expired" belongs on top even when empty buckets skew the
  // due-date order.
  if (groupBy === "severity") {
    return EXPIRY_SEVERITIES.flatMap((s) => {
      const group = groups.get(s);
      return group ? [group] : [];
    });
  }
  return [...groups.values()];
}

/**
 * The Expiry radar: one cross-provider countdown of everything with a clock on
 * it — TLS certs, domain registrations, tokens, key ages — computed from
 * already-synced fields the plugins mark as expiry-bearing. Shared by the web
 * and desktop Expiring screens; the CLI prints the same feed as text.
 */
export function ExpirySection({ data, error, onRetry, onOpenResource }: ExpirySectionProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>("kind");
  const [soonestFirst, setSoonestFirst] = useState(true);

  const groups = useMemo(
    () => (data ? buildGroups(data.items, groupBy, soonestFirst) : []),
    [data, groupBy, soonestFirst],
  );

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">Expiring</h1>
      <p className="text-sm text-on-surface-muted mb-6">
        Certificates, domains, tokens and keys approaching their deadlines, across every provider —
        read from the state your accounts last synced.
      </p>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-red-500">
          Couldn&apos;t load the expiry feed — {error}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              Retry
            </button>
          )}
        </div>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Scanning synced resources…
        </p>
      )}
      {error != null && data !== null && (
        <p role="alert" className="mb-4 text-xs text-red-400">
          Couldn&apos;t refresh — showing the last loaded feed. {error}
        </p>
      )}

      {data !== null && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {EXPIRY_SEVERITIES.map((severity) => (
              <span
                key={severity}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${SEVERITY_BADGE_CLASSES[severity]}`}
              >
                <span className="tabular-nums">{data.counts[severity]}</span>
                {severitySummaryLabel(severity, data.leadDays)}
              </span>
            ))}
          </div>

          {data.items.length === 0 ? (
            <p className="text-sm text-on-surface-faint">
              Nothing is on the clock. Deadlines appear when a plugin marks a synced field as
              expiry-bearing — a certificate&apos;s not-after date, a domain&apos;s renewal date, a
              token&apos;s expiration or an access key&apos;s age — so an empty list means nothing
              tracked is due.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div
                  role="group"
                  aria-label="Group items by"
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
                  onClick={() => setSoonestFirst((v) => !v)}
                  className="rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary hover:text-on-surface-secondary transition-colors"
                >
                  {soonestFirst ? "Soonest first" : "Latest first"}
                </button>
              </div>

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
                        {group.items.length} deadline{group.items.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="border border-border rounded-xl overflow-hidden">
                      <table className="w-full text-sm">
                        <tbody>
                          {group.items.map((item) => (
                            <tr
                              key={`${item.resourceId}:${item.fieldKey}`}
                              className={`border-b border-border last:border-b-0 ${
                                onOpenResource ? "cursor-pointer hover:bg-surface-raised" : ""
                              }`}
                              onClick={onOpenResource ? () => onOpenResource(item) : undefined}
                              onKeyDown={
                                onOpenResource
                                  ? (e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        onOpenResource(item);
                                      }
                                    }
                                  : undefined
                              }
                              tabIndex={onOpenResource ? 0 : undefined}
                            >
                              <td className="px-4 py-2.5 whitespace-nowrap font-medium text-on-surface">
                                {item.displayName}
                              </td>
                              <td className="px-3 py-2.5 whitespace-nowrap">
                                <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
                                  {item.resourceTypeName}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 whitespace-nowrap text-xs text-on-surface-tertiary">
                                {item.pluginName}
                                <span className="text-on-surface-faint"> · {item.accountName}</span>
                              </td>
                              <td className="px-3 py-2.5 w-full text-on-surface-secondary">
                                {item.label}
                                {item.basis === "age" && (
                                  <span
                                    className="text-xs text-on-surface-faint"
                                    title="Deadline derived from a creation or rotation date plus an age budget, not a provider expiry date."
                                  >
                                    {" "}
                                    · age budget
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 whitespace-nowrap text-right">
                                <span className="text-on-surface-secondary">
                                  {new Date(item.dueAt).toLocaleDateString()}
                                </span>{" "}
                                <span className={`text-xs ${SEVERITY_TEXT_CLASSES[item.severity]}`}>
                                  {formatDaysRemaining(item.daysRemaining)}
                                </span>
                              </td>
                              <td className="px-4 py-2.5 whitespace-nowrap text-right">
                                <span
                                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_BADGE_CLASSES[item.severity]}`}
                                >
                                  {SEVERITY_LABELS[item.severity]}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>

              <p className="mt-4 text-xs text-on-surface-faint">
                Deadlines come from fields your plugins mark as expiry-bearing on already-synced
                resources — nothing here contacts a provider. &ldquo;Within {data.leadDays}d
                lead&rdquo; follows the organization&apos;s expiry-alert lead time.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
