import { useMemo, useState } from "react";
import {
  POSTURE_CATEGORY_LABELS,
  POSTURE_SEVERITIES,
  POSTURE_SEVERITY_LABELS,
  postureFindingKey,
  type DismissedPostureFinding,
  type PostureFinding,
  type PostureListResponse,
  type PostureSeverity,
} from "@infrawrench/client-core";

export interface PostureSectionProps {
  /**
   * The computed findings, or null while the first load is in flight. Hosts
   * fetch (web: `/posture`, desktop: IPC or the local scan) and hand the
   * response over — this component never talks to a network.
   */
  data: PostureListResponse | null;
  /**
   * Load or refresh failure. With `data` still present the last findings stay
   * on screen under a banner — a failed refresh must not blank a drawn list.
   */
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** Jump to a finding's resource detail view. Omitted, names are plain text. */
  onOpenResource?: ((finding: PostureFinding) => void) | undefined;
  /**
   * Accept a finding, with the operator's optional note. Omitted, the section
   * is read-only — which is what a host without the permission passes, and
   * what local mode passed before it had a dismissal store.
   *
   * Rejecting the promise leaves the row in place and shows the message; the
   * host is responsible for refreshing on success.
   */
  onDismiss?: ((finding: PostureFinding, reason: string) => Promise<void>) | undefined;
  /** Undo a dismissal. Omitted, dismissed findings are listed but not undoable. */
  onRestore?: ((finding: PostureFinding) => Promise<void>) | undefined;
}

type GroupBy = "severity" | "category" | "account";

const GROUP_OPTIONS: Array<{ key: GroupBy; label: string }> = [
  { key: "severity", label: "Severity" },
  { key: "category", label: "Category" },
  { key: "account", label: "Account" },
];

/** Pill tones per bucket, matching the ExpirySection translucent-badge recipe. */
const SEVERITY_BADGE_CLASSES: Record<PostureSeverity, string> = {
  critical: "bg-red-500/10 text-red-400",
  high: "bg-orange-500/10 text-orange-400",
  medium: "bg-amber-500/10 text-amber-400",
  low: "bg-surface-overlay text-on-surface-tertiary",
};

interface PostureGroup {
  key: string;
  title: string;
  /** Secondary text after the title, e.g. the plugin name for account groups. */
  subtitle: string | null;
  findings: PostureFinding[];
}

function buildGroups(findings: PostureFinding[], groupBy: GroupBy): PostureGroup[] {
  const groups = new Map<string, PostureGroup>();
  // Findings arrive pre-sorted (worst first, then account, then name), so
  // insertion order already ranks category/account groups by their worst
  // finding, and severity groups fall out in escalation order.
  for (const finding of findings) {
    let key: string;
    let title: string;
    let subtitle: string | null = null;
    if (groupBy === "severity") {
      key = finding.severity;
      title = POSTURE_SEVERITY_LABELS[finding.severity];
    } else if (groupBy === "category") {
      key = finding.category;
      title = POSTURE_CATEGORY_LABELS[finding.category];
    } else {
      key = finding.accountId;
      title = finding.accountName;
      subtitle = finding.pluginName;
    }
    const existing = groups.get(key);
    if (existing) existing.findings.push(finding);
    else groups.set(key, { key, title, subtitle, findings: [finding] });
  }
  return [...groups.values()];
}

/** `"2 Mar 2026"` — a dismissal's age is what matters, not its minute. */
function formatDismissedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Posture checks: plugin-declared security rules evaluated over
 * already-synced resource fields — public buckets, world-open ingress,
 * unencrypted disks, stale credentials — ranked by severity. Shared by the
 * web and desktop Posture screens; the CLI prints the same findings as text.
 *
 * Findings can be accepted ("that bucket is public on purpose"), which moves
 * them into the dismissed list at the bottom and out of the alerts. The
 * suppression is deliberately visible and reversible: a silenced security
 * warning that leaves no trace is worse than a noisy one.
 */
export function PostureSection({
  data,
  error,
  onRetry,
  onOpenResource,
  onDismiss,
  onRestore,
}: PostureSectionProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>("severity");
  /** Key of the finding whose reason box is open, if any. */
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  /** Keys with a dismiss/restore call in flight — their buttons stay disabled. */
  const [pending, setPending] = useState<readonly string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  const groups = useMemo(() => (data ? buildGroups(data.findings, groupBy) : []), [data, groupBy]);

  const isPending = (finding: PostureFinding) => pending.includes(postureFindingKey(finding));

  async function run(finding: PostureFinding, action: () => Promise<void>): Promise<void> {
    const key = postureFindingKey(finding);
    setPending((keys) => [...keys, key]);
    setActionError(null);
    try {
      await action();
      setDismissing(null);
      setReason("");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending((keys) => keys.filter((k) => k !== key));
    }
  }

  const dismissed = data?.dismissed ?? [];

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">Posture</h1>
      <p className="text-sm text-on-surface-muted mb-6">
        Security checks your plugins declare, evaluated across every provider — public buckets,
        world-open firewall rules, unencrypted disks, stale credentials — read from the state your
        accounts last synced.
      </p>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-red-500">
          Couldn&apos;t load the posture findings — {error}{" "}
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
          Couldn&apos;t refresh — showing the last loaded findings. {error}
        </p>
      )}

      {data !== null && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {POSTURE_SEVERITIES.map((severity) => (
              <span
                key={severity}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${SEVERITY_BADGE_CLASSES[severity]}`}
              >
                <span className="tabular-nums">{data.counts[severity]}</span>
                {POSTURE_SEVERITY_LABELS[severity]}
              </span>
            ))}
            {data.dismissedCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-on-surface-tertiary">
                <span className="tabular-nums">{data.dismissedCount}</span>
                Dismissed
              </span>
            )}
          </div>

          {actionError != null && (
            <p role="alert" className="mb-4 text-xs text-red-400">
              {actionError}
            </p>
          )}

          {data.findings.length === 0 ? (
            <p className="text-sm text-on-surface-faint">
              {data.dismissedCount > 0
                ? "No open findings — everything currently flagged has been dismissed as an accepted risk. The dismissed list is below."
                : "No findings. Checks appear when a plugin declares posture rules over fields its listers sync — a bucket's public-access setting, a firewall's source ranges, a disk's encryption flag — so an empty list means nothing declared is flagged."}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div
                  role="group"
                  aria-label="Group findings by"
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
                        {group.findings.length} finding{group.findings.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="border border-border rounded-xl overflow-hidden">
                      <table className="w-full text-sm">
                        <tbody>
                          {group.findings.map((finding) => {
                            const key = postureFindingKey(finding);
                            return (
                              <tr
                                key={key}
                                className={`border-b border-border last:border-b-0 ${
                                  onOpenResource ? "cursor-pointer hover:bg-surface-raised" : ""
                                }`}
                                onClick={onOpenResource ? () => onOpenResource(finding) : undefined}
                                onKeyDown={
                                  onOpenResource
                                    ? (e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          onOpenResource(finding);
                                        }
                                      }
                                    : undefined
                                }
                                tabIndex={onOpenResource ? 0 : undefined}
                              >
                                <td className="px-4 py-2.5 whitespace-nowrap align-top font-medium text-on-surface">
                                  {finding.displayName}
                                </td>
                                <td className="px-3 py-2.5 whitespace-nowrap align-top">
                                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
                                    {finding.resourceTypeName}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                                  {finding.pluginName}
                                  <span className="text-on-surface-faint">
                                    {" "}
                                    · {finding.accountName}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 w-full align-top text-on-surface-secondary">
                                  <span className="font-medium text-on-surface">
                                    {finding.title}
                                  </span>
                                  <span className="block text-xs text-on-surface-tertiary">
                                    {finding.reason}
                                  </span>
                                  {/* The reason box lives inside the row's own
                                      cell so opening it never reflows the table. */}
                                  {dismissing === key && onDismiss && (
                                    <span
                                      className="mt-2 flex flex-wrap items-center gap-2"
                                      // The row is a click target; typing in
                                      // the box must not open the resource.
                                      onClick={(e) => e.stopPropagation()}
                                      onKeyDown={(e) => e.stopPropagation()}
                                    >
                                      <input
                                        type="text"
                                        autoFocus
                                        value={reason}
                                        onChange={(e) => setReason(e.target.value)}
                                        maxLength={500}
                                        placeholder="Why is this acceptable? (optional)"
                                        aria-label={`Reason for dismissing ${finding.title} on ${finding.displayName}`}
                                        className="min-w-56 flex-1 rounded-lg border border-border bg-surface-raised px-2 py-1 text-xs text-on-surface"
                                      />
                                      <button
                                        type="button"
                                        disabled={isPending(finding)}
                                        onClick={() =>
                                          void run(finding, () => onDismiss(finding, reason))
                                        }
                                        className="rounded-lg border border-border px-2 py-1 text-xs text-on-surface hover:bg-surface-overlay disabled:opacity-50"
                                      >
                                        {isPending(finding) ? "Dismissing…" : "Confirm"}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setDismissing(null);
                                          setReason("");
                                        }}
                                        className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
                                      >
                                        Cancel
                                      </button>
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 whitespace-nowrap align-top text-right">
                                  <span
                                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_BADGE_CLASSES[finding.severity]}`}
                                  >
                                    {POSTURE_SEVERITY_LABELS[finding.severity]}
                                  </span>
                                </td>
                                {onDismiss && (
                                  <td className="px-3 py-2.5 whitespace-nowrap align-top text-right">
                                    <button
                                      type="button"
                                      disabled={isPending(finding)}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setActionError(null);
                                        setReason("");
                                        setDismissing(dismissing === key ? null : key);
                                      }}
                                      className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
                                    >
                                      Dismiss
                                    </button>
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {dismissed.length > 0 && (
            <div className="mt-8">
              <button
                type="button"
                onClick={() => setShowDismissed((open) => !open)}
                aria-expanded={showDismissed}
                className="text-sm font-medium text-on-surface-secondary hover:text-on-surface"
              >
                {showDismissed ? "▾" : "▸"} Dismissed ({dismissed.length})
              </button>
              <p className="mt-1 text-xs text-on-surface-faint">
                Accepted risks. Still evaluated on every scan, but kept off the list above and out
                of the posture alerts until restored.
              </p>
              {showDismissed && (
                <div className="mt-3 border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <tbody>
                      {dismissed.map((finding: DismissedPostureFinding) => (
                        <tr
                          key={postureFindingKey(finding)}
                          className={`border-b border-border last:border-b-0 ${
                            onOpenResource ? "cursor-pointer hover:bg-surface-raised" : ""
                          }`}
                          onClick={onOpenResource ? () => onOpenResource(finding) : undefined}
                          onKeyDown={
                            onOpenResource
                              ? (e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onOpenResource(finding);
                                  }
                                }
                              : undefined
                          }
                          tabIndex={onOpenResource ? 0 : undefined}
                        >
                          <td className="px-4 py-2.5 whitespace-nowrap align-top font-medium text-on-surface-secondary">
                            {finding.displayName}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                            {finding.pluginName}
                            <span className="text-on-surface-faint"> · {finding.accountName}</span>
                          </td>
                          <td className="px-3 py-2.5 w-full align-top text-on-surface-tertiary">
                            <span className="font-medium">{finding.title}</span>
                            <span className="block text-xs text-on-surface-faint">
                              Dismissed {formatDismissedAt(finding.dismissal.dismissedAt)}
                              {finding.dismissal.dismissedBy
                                ? ` by ${finding.dismissal.dismissedBy}`
                                : ""}
                              {finding.dismissal.reason ? ` — ${finding.dismissal.reason}` : ""}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap align-top text-right">
                            <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-on-surface-tertiary">
                              {POSTURE_SEVERITY_LABELS[finding.severity]}
                            </span>
                          </td>
                          {onRestore && (
                            <td className="px-3 py-2.5 whitespace-nowrap align-top text-right">
                              <button
                                type="button"
                                disabled={isPending(finding)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void run(finding, () => onRestore(finding));
                                }}
                                className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
                              >
                                {isPending(finding) ? "Restoring…" : "Restore"}
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {(data.findings.length > 0 || dismissed.length > 0) && (
            <p className="mt-4 text-xs text-on-surface-faint">
              Findings come from declarative rules your plugins ship, evaluated over already-synced
              fields — nothing here contacts a provider. Critical and high findings feed the posture
              alerts.
            </p>
          )}
        </>
      )}
    </div>
  );
}
