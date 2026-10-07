import { useMemo, useState, type KeyboardEvent } from "react";
import { T, Var, useGT, t } from "gt-react";
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
import { useDataString } from "../i18n/data-strings.js";
import { ChevronIcon } from "../components/icons/ChromeIcons.js";

export interface AccessReviewSectionProps {
  /**
   * The computed review, or null while the first load is in flight. Hosts
   * fetch (web: `/access-review`, desktop: IPC) and hand the response over;
   * this component never talks to a network.
   */
  data: AccessReviewResponse | null;
  /**
   * Load or refresh failure. With `data` still present the last review stays
   * on screen under a banner: a failed refresh must not blank a drawn list.
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
   * is read-only, which is what a host without `resources:write` passes.
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
 * What a principal's activity cell says. "Unknown" is printed, never blank: a
 * blank cell reads as "not looked up", which is the impression this column
 * exists to avoid giving.
 */
function activityLabel(principal: AccessPrincipal): string {
  if (principal.activity === "unknown") return t("Unknown");
  if (principal.daysSinceLastUsed === null) return t("Unknown");
  if (principal.daysSinceLastUsed <= 0) return t("Today");
  return t("{days}d ago", { days: principal.daysSinceLastUsed });
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

/** `"2 Mar 2026"`: a dismissal's age is what matters, not its minute. */
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
 * Enter/Space on a row opens its resource, but only when the row itself has
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
  const gt = useGT();
  const gtData = useDataString();
  const principals = data.principals.length;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-on-surface-secondary">
        <span className="tabular-nums">{principals}</span>
        {principals === 1 ? gt("principal") : gt("principals")}
      </span>
      {ACCESS_REVIEW_SEVERITIES.map((severity) => (
        <span
          key={severity}
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${SEVERITY_BADGE_CLASSES[severity]}`}
        >
          <span className="tabular-nums">{data.counts[severity]}</span>
          {gtData(ACCESS_REVIEW_SEVERITY_LABELS[severity])}
        </span>
      ))}
      {data.dismissedCount > 0 && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-on-surface-tertiary">
          <span className="tabular-nums">{data.dismissedCount}</span>
          {gt("Dismissed")}
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
  const gt = useGT();
  const gtData = useDataString();
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
          <span className="block text-xs font-normal text-on-surface-faint">
            {gt("via {parent}", { parent: p.parent })}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap align-top">
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
          {gtData(PRINCIPAL_ROLE_LABELS[p.role])}
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
        {p.owner ? (
          p.owner.displayName
        ) : (
          <span className="text-on-surface-faint">{gt("Unowned")}</span>
        )}
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
              placeholder={gt("Why is this acceptable? (optional)")}
              aria-label={gt("Reason for dismissing {title} on {name}", {
                title: finding.title,
                name: p.displayName,
              })}
              className="min-w-56 flex-1 rounded-lg border border-border bg-surface-raised px-2 py-1 text-xs text-on-surface"
            />
            <button
              type="button"
              disabled={pending}
              onClick={onConfirm}
              className="rounded-lg border border-border px-2 py-1 text-xs text-on-surface hover:bg-surface-overlay disabled:opacity-50"
            >
              {pending ? gt("Dismissing…") : gt("Confirm")}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
            >
              {gt("Cancel")}
            </button>
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap align-top text-right">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_BADGE_CLASSES[finding.severity]}`}
        >
          {gtData(ACCESS_REVIEW_SEVERITY_LABELS[finding.severity])}
        </span>
      </td>
      <td
        className="px-3 py-2.5 whitespace-nowrap align-top text-right"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Revoke only appears where the resource type declares a revoke
            action: everywhere else the provider offers nothing Infrawrench
            can invoke, and a button that opened the provider's console would
            be a different promise. */}
        {onRevoke && (
          <button
            type="button"
            disabled={pending}
            onClick={onRevoke}
            className="mr-3 text-xs text-danger hover:text-danger-strong disabled:opacity-50"
          >
            {gt("Revoke")}
          </button>
        )}
        {onToggleReason && (
          <button
            type="button"
            disabled={pending}
            onClick={onToggleReason}
            className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
          >
            {gt("Dismiss")}
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
  const gt = useGT();
  const gtData = useDataString();
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
          {gt("Dismissed {date}", { date: formatDismissedAt(finding.dismissal.dismissedAt) })}
          {finding.dismissal.dismissedBy
            ? ` ${gt("by {name}", { name: finding.dismissal.dismissedBy })}`
            : ""}
          {finding.dismissal.reason ? `: ${finding.dismissal.reason}` : ""}
        </span>
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap align-top text-right">
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-on-surface-tertiary">
          {gtData(ACCESS_REVIEW_SEVERITY_LABELS[finding.severity])}
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
            {pending ? gt("Restoring…") : gt("Restore")}
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
  const gt = useGT();
  const gtData = useDataString();
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-on-surface-faint">
            <th className="px-4 py-2 font-medium">{gt("Principal")}</th>
            <th className="px-3 py-2 font-medium">{gt("Kind")}</th>
            <th className="px-3 py-2 font-medium">{gt("Account")}</th>
            <th className="px-3 py-2 font-medium">{gt("Last used")}</th>
            <th className="px-3 py-2 font-medium">{gt("Age")}</th>
            <th className="px-3 py-2 font-medium">{gt("Admin")}</th>
            <th className="px-3 py-2 font-medium">{gt("Owner")}</th>
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
                      {gt("via {parent}", { parent: p.parent })}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                  {gtData(PRINCIPAL_ROLE_LABELS[p.role])}
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
                    <span className="text-on-surface-faint">{gt("Unknown")}</span>
                  ) : (
                    gt("{days}d", { days: p.ageDays })
                  )}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs">
                  {p.admin === null ? (
                    <span className="text-on-surface-faint">{gt("Unknown")}</span>
                  ) : p.admin ? (
                    <span className="text-severe">{gt("Yes")}</span>
                  ) : (
                    <span className="text-on-surface-tertiary">{gt("No")}</span>
                  )}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
                  {p.owner ? (
                    p.owner.displayName
                  ) : (
                    <span className="text-on-surface-faint">{gt("Unowned")}</span>
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
 * synced (IAM users and roles, service accounts, app registrations, groups,
 * role bindings and long-lived keys) with the findings that have evidence
 * against them.
 *
 * This is about the principals inside **your** clouds. It is not your
 * Infrawrench team's roles (Settings → Team) and not the credentials
 * Infrawrench stores for you (Settings → Credential hygiene). The copy on the
 * page says so, because those three are otherwise easy to confuse.
 *
 * Findings can be accepted ("that break-glass role is admin on purpose"),
 * which moves them into the dismissed list and out of the security alerts:
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
  const gt = useGT();
  const gtData = useDataString();
  const [view, setView] = useState<View>("findings");
  const [groupBy, setGroupBy] = useState<"severity" | "account" | "role">("severity");
  /** Key of the finding whose reason box is open, if any. */
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  /** Keys with a call in flight: their buttons stay disabled. */
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
      <h1 className="text-xl font-semibold mb-1">{gt("Access review")}</h1>
      <p className="text-sm text-on-surface-muted mb-4">
        {gt(
          "Every principal in your connected clouds (IAM users and roles, service accounts, groups, role bindings, long-lived keys), from the last sync. Not your Infrawrench team roles.",
        )}
      </p>

      {(data?.jitGrantIssues?.length ?? 0) > 0 && (
        <section
          role="alert"
          aria-label={gt("Just-in-time grants that did not end")}
          className="mb-4 border border-red-500/40 bg-red-500/5 rounded-xl p-4 space-y-2"
        >
          <h2 className="text-sm font-semibold text-red-700 dark:text-red-300">
            {gt("Just-in-time grants that did not end")}
          </h2>
          <p className="text-xs text-on-surface-muted">
            {gt(
              "These grants are still held, or may be, after the window an approver agreed to. Infrawrench keeps retrying; remove them in the provider's console if it cannot.",
            )}
          </p>
          <ul className="space-y-1">
            {data!.jitGrantIssues!.map((issue) => (
              <li key={issue.requestId} className="text-sm text-on-surface-secondary">
                {gt("{principal}: {role} on {scope}", {
                  principal: issue.principalName,
                  role: issue.roleName,
                  scope: issue.accountName
                    ? `${issue.scopeName} (${issue.accountName})`
                    : issue.scopeName,
                })}
                {" · "}
                {issue.kind === "revoke_failed"
                  ? gt("revoke failed after {count} attempts", { count: issue.revokeAttempts })
                  : issue.kind === "still_present"
                    ? gt("the provider still reports it after revoking")
                    : gt("still marked as held past its window")}
                {issue.lastError && (
                  <span className="block text-xs text-danger break-words">{issue.lastError}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-4 text-xs">
        <div role="group" aria-label={gt("Staleness window")} className="flex items-center gap-1">
          <span className="text-on-surface-faint mr-1">{gt("Unused for")}</span>
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
                {gt("{days}d", { days })}
              </button>
            ))}
          </div>
        </div>
        {onExport && (
          <div
            role="group"
            aria-label={gt("Export the review")}
            className="flex items-center gap-1"
          >
            <span className="text-on-surface-faint mr-1">{gt("Export")}</span>
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
          {gt("Couldn't load the access review: {error}", { error })}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              {gt("Retry")}
            </button>
          )}
        </div>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Reviewing synced principals…")}
        </p>
      )}
      {error != null && data !== null && (
        <p role="alert" className="mb-4 text-xs text-danger">
          {gt("Couldn't refresh; showing the last loaded review. {error}", { error })}
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
              {gt(
                "No principals synced yet. They appear once a connected provider syncs identities (users, roles, service accounts, API keys). Empty doesn't mean you have none.",
              )}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4 text-xs">
                <div role="group" aria-label={gt("View")} className="flex items-center gap-1">
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
                      {gt("Findings ({count})", { count: data.totalCount })}
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
                      {gt("All principals ({count})", { count: data.principals.length })}
                    </button>
                  </div>
                </div>
                {view === "findings" && data.findings.length > 0 && (
                  <div
                    role="group"
                    aria-label={gt("Group findings by")}
                    className="flex items-center gap-1"
                  >
                    <span className="text-on-surface-faint mr-1">{gt("Group by")}</span>
                    <div className="flex rounded-lg border border-border overflow-hidden">
                      {(
                        [
                          { key: "severity", label: gt("Severity") },
                          { key: "account", label: gt("Account") },
                          { key: "role", label: gt("Kind") },
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
                    ? gt(
                        "No open findings. Everything flagged has been accepted; see the dismissed list below.",
                      )
                    : gt("No open findings across your synced principals.")}
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  {groups.map((group) => (
                    <div key={group.key} className="flex flex-col gap-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="text-sm font-medium text-on-surface">
                          {gtData(group.title)}
                          {group.subtitle && (
                            <span className="ml-2 font-normal text-on-surface-tertiary">
                              {group.subtitle}
                            </span>
                          )}
                        </h2>
                        <span className="text-xs text-on-surface-faint">
                          {group.findings.length} {gt("finding")}
                          {group.findings.length === 1 ? "" : gt("s")}
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
                className="inline-flex items-center gap-1 text-sm font-medium text-on-surface-secondary hover:text-on-surface"
              >
                <ChevronIcon direction={showDismissed ? "down" : "right"} size={12} />
                {gt("Dismissed ({count})", { count: dismissed.length })}
              </button>
              <p className="mt-1 text-xs text-on-surface-faint">
                {gt(
                  "Accepted risks. Still evaluated, but hidden from the list above and from security alerts until restored. Included in the exported evidence file.",
                )}
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
              {gt("Computed from synced data; nothing here contacts a provider.")}{" "}
              {data.unknownActivityCount > 0 && (
                <T>
                  <>
                    <Var>{data.unknownActivityCount}</Var> of <Var>{data.principals.length}</Var>{" "}
                    principals report no last-use date at all; they are shown as <em>Unknown</em>{" "}
                    and are never counted as unused.{" "}
                  </>
                </T>
              )}
              {gt("Critical and high findings ride the posture alert, under the same switch.")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
