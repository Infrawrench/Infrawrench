import { useMemo, useState, type KeyboardEvent } from "react";
import {
  ACCESS_REVIEW_SEVERITIES,
  ACCESS_REVIEW_SEVERITY_LABELS,
  ACCESS_REVIEW_STALE_DAY_OPTIONS,
  PRINCIPAL_ROLE_LABELS,
  accessFindingKey,
  type AccessFinding,
  type AccessPrincipal,
  type AccessReviewResponse,
  type AccessReviewSeverity,
  type DismissedAccessFinding,
} from "@infrawrench/client-core";

export interface AccessReviewSectionProps {
  /**
   * The computed review, or null while the first load is in flight. Hosts
   * fetch (web: `/access-review`, desktop: IPC) and hand the response over —
   * this component never talks to a network.
   */
  data: AccessReviewResponse | null;
  /**
   * Load or refresh failure. With `data` still present the last review stays
   * on screen under a banner — a failed refresh must not blank a drawn list.
   */
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** The staleness window the host is currently requesting. */
  staleDays: number;
  onStaleDaysChange: (days: number) => void;
  /** Jump to a principal's resource detail view. Omitted, names are plain text. */
  onOpenResource?: ((principal: AccessPrincipal) => void) | undefined;
  /**
   * Accept a finding, with the operator's optional note. Omitted, the section
   * is read-only — which is what a host without `resources:write` passes.
   */
  onDismiss?: ((finding: AccessFinding, reason: string) => Promise<void>) | undefined;
  /** Undo a dismissal. Omitted, dismissed findings are listed but not undoable. */
  onRestore?: ((finding: AccessFinding) => Promise<void>) | undefined;
  /**
   * Revoke a principal through its declared plugin action. Only offered on
   * rows whose type declares `revokeActionId`; omitted, the button never
   * renders. The host is responsible for confirming and for refreshing.
   */
  onRevoke?: ((principal: AccessPrincipal) => Promise<void>) | undefined;
  /**
   * Download the CSV / JSON evidence file. Omitted, the export buttons are
   * hidden (local or read-only hosts).
   */
  onExport?: ((format: "csv" | "json") => void) | undefined;
}

type View = "findings" | "principals";

/** Pill tones per bucket, matching the PostureSection translucent-badge recipe. */
const SEVERITY_BADGE_CLASSES: Record<AccessReviewSeverity, string> = {
  critical: "bg-red-500/10 text-danger",
  high: "bg-orange-500/10 text-severe",
  medium: "bg-amber-500/10 text-warning",
  low: "bg-surface-overlay text-on-surface-tertiary",
};

const ACTIVITY_CLASSES: Record<AccessPrincipal["activity"], string> = {
  active: "text-success",
  stale: "text-warning",
  // Deliberately the muted tone, not a warning tone: unknown is an absence of
  // evidence, not a finding.
  unknown: "text-on-surface-faint",
};

/**
 * What a principal's activity cell says. "Unknown" is printed, never blank — a
 * blank cell reads as "not looked up", which is the impression this column
 * exists to avoid giving.
 */
function activityLabel(principal: AccessPrincipal): string {
  if (principal.activity === "unknown") return "Unknown";
  if (principal.daysSinceLastUsed === null) return "Unknown";
  if (principal.daysSinceLastUsed <= 0) return "Today";
  return `${principal.daysSinceLastUsed}d ago`;
}

interface FindingGroup {
  key: string;
  title: string;
  subtitle: string | null;
  findings: AccessFinding[];
}

function buildGroups(
  findings: AccessFinding[],
  groupBy: "severity" | "account" | "role",
): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  // Findings arrive pre-sorted (worst first, then account, then name), so
  // insertion order already ranks account/role groups by their worst finding.
  for (const finding of findings) {
    let key: string;
    let title: string;
    let subtitle: string | null = null;
    if (groupBy === "severity") {
      key = finding.severity;
      title = ACCESS_REVIEW_SEVERITY_LABELS[finding.severity];
    } else if (groupBy === "role") {
      key = finding.principal.role;
      title = PRINCIPAL_ROLE_LABELS[finding.principal.role];
    } else {
      key = finding.principal.accountId;
      title = finding.principal.accountName;
      subtitle = finding.principal.pluginName;
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
 * Enter/Space on a row opens its resource — but only when the row itself has
 * focus, so the Dismiss and Revoke buttons inside it keep their own
 * activation.
 */
function rowKeyHandler(open: () => void) {
  return (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    open();
  };
}

function SummaryChips({ data }: { data: AccessReviewResponse }) {
  const principals = data.principals.length;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-on-surface-secondary">
        <span className="tabular-nums">{principals}</span>
        {principals === 1 ? "principal" : "principals"}
      </span>
      {ACCESS_REVIEW_SEVERITIES.map((severity) => (
        <span
          key={severity}
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${SEVERITY_BADGE_CLASSES[severity]}`}
        >
          <span className="tabular-nums">{data.counts[severity]}</span>
          {ACCESS_REVIEW_SEVERITY_LABELS[severity]}
        </span>
      ))}
      {data.dismissedCount > 0 && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-on-surface-tertiary">
          <span className="tabular-nums">{data.dismissedCount}</span>
          Dismissed
        </span>
      )}
    </div>
  );
}

interface FindingRowProps {
  finding: AccessFinding;
  onOpenResource?: ((principal: AccessPrincipal) => void) | undefined;
  pending: boolean;
}

function ActiveFindingRow({
  finding,
  onOpenResource,
  pending,
  onToggleReason,
  editing,
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
  onRevoke,
}: FindingRowProps & {
  onToggleReason?: (() => void) | undefined;
  editing: boolean;
  reason: string;
  onReasonChange: (reason: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** Present only when the type declares a revoke action and the host wired one. */
  onRevoke?: (() => void) | undefined;
}) {
  const p = finding.principal;
  const open = onOpenResource ? () => onOpenResource(p) : undefined;
  return (
    <tr
      className={`border-b border-border last:border-b-0 ${
        open ? "cursor-pointer hover:bg-surface-raised" : ""
      }`}
      onClick={open}
      onKeyDown={open ? rowKeyHandler(open) : undefined}
      tabIndex={open ? 0 : undefined}
    >
      <td className="px-4 py-2.5 whitespace-nowrap align-top font-medium text-on-surface">
        {p.displayName}
        {p.parent && (
          <span className="block text-xs font-normal text-on-surface-faint">via {p.parent}</span>
        )}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap align-top">
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
          {PRINCIPAL_ROLE_LABELS[p.role]}
        </span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
        {p.pluginName}
        <span className="text-on-surface-faint"> · {p.accountName}</span>
      </td>
      <td
        className={`px-3 py-2.5 whitespace-nowrap align-top text-xs ${ACTIVITY_CLASSES[p.activity]}`}
      >
        {activityLabel(p)}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
        {p.owner ? p.owner.displayName : <span className="text-on-surface-faint">Unowned</span>}
      </td>
      <td className="px-3 py-2.5 w-full align-top text-on-surface-secondary">
        <span className="font-medium text-on-surface">{finding.title}</span>
        <span className="block text-xs text-on-surface-tertiary">{finding.reason}</span>
        {editing && (
          <span
            className="mt-2 flex flex-wrap items-center gap-2"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <input
              type="text"
              autoFocus
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              maxLength={500}
              placeholder="Why is this acceptable? (optional)"
              aria-label={`Reason for dismissing ${finding.title} on ${p.displayName}`}
              className="min-w-56 flex-1 rounded-lg border border-border bg-surface-raised px-2 py-1 text-xs text-on-surface"
            />
            <button
              type="button"
              disabled={pending}
              onClick={onConfirm}
              className="rounded-lg border border-border px-2 py-1 text-xs text-on-surface hover:bg-surface-overlay disabled:opacity-50"
            >
              {pending ? "Dismissing…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={onCancel}
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
          {ACCESS_REVIEW_SEVERITY_LABELS[finding.severity]}
        </span>
      </td>
      <td
        className="px-3 py-2.5 whitespace-nowrap align-top text-right"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Revoke only appears where the resource type declares a revoke
            action — everywhere else the provider offers nothing Infrawrench
            can invoke, and a button that opened the provider's console would
            be a different promise. */}
        {onRevoke && (
          <button
            type="button"
            disabled={pending}
            onClick={onRevoke}
            className="mr-3 text-xs text-danger hover:text-danger-strong disabled:opacity-50"
          >
            Revoke
          </button>
        )}
        {onToggleReason && (
          <button
            type="button"
            disabled={pending}
            onClick={onToggleReason}
            className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
          >
            Dismiss
          </button>
        )}
      </td>
    </tr>
  );
}

function DismissedFindingRow({
  finding,
  onOpenResource,
  pending,
  onRestore,
}: FindingRowProps & {
  finding: DismissedAccessFinding;
  onRestore?: (() => void) | undefined;
}) {
  const p = finding.principal;
  const open = onOpenResource ? () => onOpenResource(p) : undefined;
  return (
    <tr
      className={`border-b border-border last:border-b-0 ${
        open ? "cursor-pointer hover:bg-surface-raised" : ""
      }`}
      onClick={open}
      onKeyDown={open ? rowKeyHandler(open) : undefined}
      tabIndex={open ? 0 : undefined}
    >
      <td className="px-4 py-2.5 whitespace-nowrap align-top font-medium text-on-surface-secondary">
        {p.displayName}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
        {p.pluginName}
        <span className="text-on-surface-faint"> · {p.accountName}</span>
      </td>
      <td className="px-3 py-2.5 w-full align-top text-on-surface-tertiary">
        <span className="font-medium">{finding.title}</span>
        <span className="block text-xs text-on-surface-faint">
          Dismissed {formatDismissedAt(finding.dismissal.dismissedAt)}
          {finding.dismissal.dismissedBy ? ` by ${finding.dismissal.dismissedBy}` : ""}
          {finding.dismissal.reason ? ` — ${finding.dismissal.reason}` : ""}
        </span>
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap align-top text-right">
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-on-surface-tertiary">
          {ACCESS_REVIEW_SEVERITY_LABELS[finding.severity]}
        </span>
      </td>
      {onRestore && (
        <td className="px-3 py-2.5 whitespace-nowrap align-top text-right">
          <button
            type="button"
            disabled={pending}
            onClick={(e) => {
              e.stopPropagation();
              onRestore();
            }}
            className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
          >
            {pending ? "Restoring…" : "Restore"}
          </button>
        </td>
      )}
    </tr>
  );
}

/** The full inventory, which is what a reviewer signs off rather than the findings alone. */
function PrincipalTable({
  principals,
  onOpenResource,
}: {
  principals: AccessPrincipal[];
  onOpenResource?: ((principal: AccessPrincipal) => void) | undefined;
}) {
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-on-surface-faint">
            <th className="px-4 py-2 font-medium">Principal</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium">Account</th>
            <th className="px-3 py-2 font-medium">Last used</th>
            <th className="px-3 py-2 font-medium">Age</th>
            <th className="px-3 py-2 font-medium">Admin</th>
            <th className="px-3 py-2 font-medium">Owner</th>
          </tr>
        </thead>
        <tbody>
          {principals.map((p) => {
            const open = onOpenResource ? () => onOpenResource(p) : undefined;
            return (
              <tr
                key={p.resourceId}
                className={`border-b border-border last:border-b-0 ${
                  open ? "cursor-pointer hover:bg-surface-raised" : ""
                }`}
                onClick={open}
                onKeyDown={open ? rowKeyHandler(open) : undefined}
                tabIndex={open ? 0 : undefined}
              >
                <td className="px-4 py-2.5 align-top font-medium text-on-surface">
                  {p.displayName}
                  {p.parent && (
                    <span className="block text-xs font-normal text-on-surface-faint">
                      via {p.parent}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                  {PRINCIPAL_ROLE_LABELS[p.role]}
                  <span className="block text-on-surface-faint">{p.resourceTypeName}</span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                  {p.pluginName}
                  <span className="block text-on-surface-faint">{p.accountName}</span>
                </td>
                <td
                  className={`px-3 py-2.5 whitespace-nowrap align-top text-xs ${ACTIVITY_CLASSES[p.activity]}`}
                >
                  {activityLabel(p)}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                  {p.ageDays === null ? (
                    <span className="text-on-surface-faint">Unknown</span>
                  ) : (
                    `${p.ageDays}d`
                  )}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs">
                  {p.admin === null ? (
                    <span className="text-on-surface-faint">Unknown</span>
                  ) : p.admin ? (
                    <span className="text-severe">Yes</span>
                  ) : (
                    <span className="text-on-surface-tertiary">No</span>
                  )}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                  {p.owner ? (
                    p.owner.displayName
                  ) : (
                    <span className="text-on-surface-faint">Unowned</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Cross-cloud access review: every principal your connected accounts have
 * synced — IAM users and roles, service accounts, app registrations, groups,
 * role bindings and long-lived keys — with the findings that have evidence
 * against them.
 *
 * This is about the principals inside **your** clouds. It is not your
 * Infrawrench team's roles (Settings → Team) and not the credentials
 * Infrawrench stores for you (Settings → Credential hygiene). The copy on the
 * page says so, because those three are otherwise easy to confuse.
 *
 * Findings can be accepted ("that break-glass role is admin on purpose"),
 * which moves them into the dismissed list and out of the security alerts —
 * visibly and reversibly, because a silenced access warning that leaves no
 * trace is worse than a noisy one.
 */
export function AccessReviewSection({
  data,
  error,
  onRetry,
  staleDays,
  onStaleDaysChange,
  onOpenResource,
  onDismiss,
  onRestore,
  onRevoke,
  onExport,
}: AccessReviewSectionProps) {
  const [view, setView] = useState<View>("findings");
  const [groupBy, setGroupBy] = useState<"severity" | "account" | "role">("severity");
  /** Key of the finding whose reason box is open, if any. */
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  /** Keys with a call in flight — their buttons stay disabled. */
  const [pending, setPending] = useState<readonly string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  const groups = useMemo(() => (data ? buildGroups(data.findings, groupBy) : []), [data, groupBy]);

  const isPending = (finding: AccessFinding) => pending.includes(accessFindingKey(finding));

  async function run(finding: AccessFinding, action: () => Promise<void>): Promise<void> {
    const key = accessFindingKey(finding);
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
      <h1 className="text-xl font-semibold mb-1">Access review</h1>
      <p className="text-sm text-on-surface-muted mb-4">
        Every principal inside your connected clouds — IAM users and roles, service accounts, app
        registrations, groups, role bindings and long-lived keys — read from the state your accounts
        last synced. This is not your Infrawrench team&apos;s roles, and not the credentials
        Infrawrench stores on your behalf.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4 text-xs">
        <div role="group" aria-label="Staleness window" className="flex items-center gap-1">
          <span className="text-on-surface-faint mr-1">Unused for</span>
          <div className="flex rounded-lg border border-border overflow-hidden">
            {ACCESS_REVIEW_STALE_DAY_OPTIONS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => onStaleDaysChange(days)}
                aria-pressed={staleDays === days}
                className={`px-2.5 py-1 transition-colors ${
                  staleDays === days
                    ? "bg-surface-overlay text-on-surface"
                    : "text-on-surface-tertiary hover:text-on-surface-secondary"
                }`}
              >
                {days}d
              </button>
            ))}
          </div>
        </div>
        {onExport && (
          <div role="group" aria-label="Export the review" className="flex items-center gap-1">
            <span className="text-on-surface-faint mr-1">Export</span>
            <div className="flex rounded-lg border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => onExport("csv")}
                className="px-2.5 py-1 text-on-surface-tertiary hover:text-on-surface-secondary"
              >
                CSV
              </button>
              <button
                type="button"
                onClick={() => onExport("json")}
                className="px-2.5 py-1 text-on-surface-tertiary hover:text-on-surface-secondary"
              >
                JSON
              </button>
            </div>
          </div>
        )}
      </div>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-danger">
          Couldn&apos;t load the access review — {error}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              Retry
            </button>
          )}
        </div>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Reviewing synced principals…
        </p>
      )}
      {error != null && data !== null && (
        <p role="alert" className="mb-4 text-xs text-danger">
          Couldn&apos;t refresh — showing the last loaded review. {error}
        </p>
      )}

      {data !== null && (
        <>
          <SummaryChips data={data} />

          {actionError != null && (
            <p role="alert" className="mb-4 text-xs text-danger">
              {actionError}
            </p>
          )}

          {data.principals.length === 0 ? (
            <p className="text-sm text-on-surface-faint">
              No principals synced. This page fills in when a connected provider syncs an identity
              type — IAM users and roles, service accounts, app registrations, directory users,
              memberships or long-lived API keys. An empty list means none of your accounts have
              synced one, not that you have none.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4 text-xs">
                <div role="group" aria-label="View" className="flex items-center gap-1">
                  <div className="flex rounded-lg border border-border overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setView("findings")}
                      aria-pressed={view === "findings"}
                      className={`px-2.5 py-1 transition-colors ${
                        view === "findings"
                          ? "bg-surface-overlay text-on-surface"
                          : "text-on-surface-tertiary hover:text-on-surface-secondary"
                      }`}
                    >
                      Findings ({data.totalCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setView("principals")}
                      aria-pressed={view === "principals"}
                      className={`px-2.5 py-1 transition-colors ${
                        view === "principals"
                          ? "bg-surface-overlay text-on-surface"
                          : "text-on-surface-tertiary hover:text-on-surface-secondary"
                      }`}
                    >
                      All principals ({data.principals.length})
                    </button>
                  </div>
                </div>
                {view === "findings" && data.findings.length > 0 && (
                  <div
                    role="group"
                    aria-label="Group findings by"
                    className="flex items-center gap-1"
                  >
                    <span className="text-on-surface-faint mr-1">Group by</span>
                    <div className="flex rounded-lg border border-border overflow-hidden">
                      {(
                        [
                          { key: "severity", label: "Severity" },
                          { key: "account", label: "Account" },
                          { key: "role", label: "Kind" },
                        ] as const
                      ).map((option) => (
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
                )}
              </div>

              {view === "principals" ? (
                <PrincipalTable principals={data.principals} onOpenResource={onOpenResource} />
              ) : data.findings.length === 0 ? (
                <p className="text-sm text-on-surface-faint">
                  {data.dismissedCount > 0
                    ? "No open findings — everything currently flagged has been accepted. The dismissed list is below."
                    : "No open findings across your synced principals."}
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
                          {group.findings.length} finding{group.findings.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="border border-border rounded-xl overflow-hidden">
                        <table className="w-full text-sm">
                          <tbody>
                            {group.findings.map((finding) => {
                              const key = accessFindingKey(finding);
                              const revokable =
                                onRevoke && finding.principal.revokeActionId !== null;
                              return (
                                <ActiveFindingRow
                                  key={key}
                                  finding={finding}
                                  onOpenResource={onOpenResource}
                                  pending={isPending(finding)}
                                  editing={dismissing === key && onDismiss !== undefined}
                                  reason={reason}
                                  onReasonChange={setReason}
                                  onToggleReason={
                                    onDismiss
                                      ? () => {
                                          setActionError(null);
                                          setReason("");
                                          setDismissing(dismissing === key ? null : key);
                                        }
                                      : undefined
                                  }
                                  onConfirm={() => {
                                    if (onDismiss)
                                      void run(finding, () => onDismiss(finding, reason));
                                  }}
                                  onCancel={() => {
                                    setDismissing(null);
                                    setReason("");
                                  }}
                                  onRevoke={
                                    revokable
                                      ? () => void run(finding, () => onRevoke(finding.principal))
                                      : undefined
                                  }
                                />
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
                Accepted risks. Still evaluated on every review, but kept off the list above and out
                of the security alerts until restored. They stay in the exported evidence file.
              </p>
              {showDismissed && (
                <div className="mt-3 border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <tbody>
                      {dismissed.map((finding: DismissedAccessFinding) => (
                        <DismissedFindingRow
                          key={accessFindingKey(finding)}
                          finding={finding}
                          onOpenResource={onOpenResource}
                          pending={isPending(finding)}
                          onRestore={
                            onRestore
                              ? () => void run(finding, () => onRestore(finding))
                              : undefined
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {data.principals.length > 0 && (
            <p className="mt-4 text-xs text-on-surface-faint">
              Computed from already-synced fields — nothing here contacts a provider.{" "}
              {data.unknownActivityCount > 0 && (
                <>
                  {data.unknownActivityCount} of {data.principals.length} principals report no
                  last-use date at all; they are shown as <em>Unknown</em> and are never counted as
                  unused.{" "}
                </>
              )}
              Critical and high findings ride the posture alert, under the same switch.
            </p>
          )}
        </>
      )}
    </div>
  );
}
