import { useMemo, useState, type KeyboardEvent } from "react";
import { T, useGT } from "gt-react";
import {
  DRILL_OUTCOMES,
  formatRto,
  validateRestoreDrill,
  type DrillCoverageRow,
  type DrillOutcome,
  type DrillStanding,
  type DrillSummary,
  type RestoreDrill,
  type RestoreDrillInput,
  BACKUP_FINDING_KIND_LABELS,
  BACKUP_POLICY_LIMITS,
  BACKUP_SEVERITIES,
  BACKUP_SEVERITY_LABELS,
  formatHours,
  validateBackupPolicyInput,
  type BackupCoverageResponse,
  type BackupCoverageRow,
  type BackupFinding,
  type BackupFindingKind,
  type BackupPolicy,
  type BackupPolicyInput,
  type BackupProtectionState,
  type BackupSeverity,
} from "@infrawrench/client-core";

export interface BackupsSectionProps {
  /**
   * The computed coverage, or null while the first load is in flight. Hosts
   * fetch (web: `/backups`, desktop: cloud IPC) and hand the response over —
   * this component never talks to a network.
   */
  data: BackupCoverageResponse | null;
  /** The org's policies, or null while loading. */
  policies: BackupPolicy[] | null;
  /**
   * Load or refresh failure. With `data` still present the last coverage
   * stays on screen under a banner — a failed refresh must not blank a drawn
   * list.
   */
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** Jump to a finding's resource detail view. Omitted, names are plain text. */
  onOpenResource?: ((finding: { accountId: string; resourceId: string }) => void) | undefined;
  /**
   * Policy editing. All three omitted ⇒ the policy list is read-only, which is
   * what a host without `org:settings:write` passes.
   */
  onCreatePolicy?: ((input: BackupPolicyInput) => Promise<void>) | undefined;
  onUpdatePolicy?:
    ((policyId: string, patch: Partial<BackupPolicyInput>) => Promise<void>) | undefined;
  onDeletePolicy?: ((policyId: string) => Promise<void>) | undefined;
  /**
   * Resource type ids the org has synced, for the policy editor's type picker.
   * Empty or omitted ⇒ the editor offers a free-text list instead, which still
   * works but makes the user know the ids.
   */
  resourceTypeOptions?: ReadonlyArray<{ id: string; label: string }> | undefined;
  /**
   * Restore-drill standings. Undefined hides the Drills tab entirely; null
   * means it is still loading.
   */
  drills?: DrillCoverage | null | undefined;
  /** Record a drill. Omitted, the drill list is read-only. */
  onRecordDrill?: ((input: RestoreDrillInput) => Promise<void>) | undefined;
}

type Tab = "findings" | "coverage" | "policies" | "drills";

/**
 * The drill half of the screen, supplied by the host. Undefined means the host
 * does not offer drills at all, which hides the tab — rather than showing an
 * empty one, which would read as "nobody has ever drilled".
 */
export interface DrillCoverage {
  rows: DrillCoverageRow[];
  summary: DrillSummary;
  validDays: number;
  orphanedDrills: RestoreDrill[];
}

const STANDING_CLASSES: Record<DrillStanding, string> = {
  verified: "bg-emerald-500/10 text-success",
  stale: "bg-amber-500/10 text-warning",
  failed: "bg-red-500/10 text-danger",
  // Neutral, not red: nobody having tried is a gap in practice rather than a
  // fault in the backup, and the two want different colours.
  never: "bg-surface-overlay text-on-surface-tertiary",
};

function standingLabel(gt: Gt, standing: DrillStanding): string {
  switch (standing) {
    case "verified":
      return gt("Verified");
    case "stale":
      return gt("Stale");
    case "failed":
      return gt("Last attempt failed");
    case "never":
      return gt("Never verified");
  }
}

function outcomeLabel(gt: Gt, outcome: DrillOutcome): string {
  switch (outcome) {
    case "verified":
      return gt("Restored and checked");
    case "restored-unverified":
      return gt("Restored, not checked");
    case "failed":
      return gt("Restore failed");
    case "blocked":
      return gt("Could not attempt");
  }
}

type Gt = ReturnType<typeof useGT>;

/** Pill tones per bucket, matching the PostureSection translucent-badge recipe. */
const SEVERITY_BADGE_CLASSES: Record<BackupSeverity, string> = {
  critical: "bg-red-500/10 text-danger",
  high: "bg-orange-500/10 text-severe",
  medium: "bg-amber-500/10 text-warning",
  low: "bg-surface-overlay text-on-surface-tertiary",
};

const STATE_BADGE_CLASSES: Record<BackupProtectionState, string> = {
  protected: "bg-emerald-500/10 text-success",
  automated: "bg-sky-500/10 text-info",
  stale: "bg-amber-500/10 text-warning",
  // Deliberately neutral, not red: an unassessed resource is not a finding,
  // and colouring it like one would put the false alarm back on the screen
  // after the computation was careful to keep it out.
  unknown: "bg-surface-overlay text-on-surface-tertiary",
  unprotected: "bg-red-500/10 text-danger",
};

function stateLabel(gt: Gt, state: BackupProtectionState): string {
  switch (state) {
    case "protected":
      return gt("Backed up");
    case "automated":
      return gt("Provider-managed");
    case "stale":
      return gt("Stale");
    case "unknown":
      return gt("Not assessed");
    case "unprotected":
      return gt("Unprotected");
  }
}

const FINDING_KINDS: readonly BackupFindingKind[] = [
  "unprotected",
  "rpo-breach",
  "retention-below-policy",
  "orphaned-snapshot",
];

function formatMoney(amount: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency ?? "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ""}`.trim();
  }
}

function formatGb(gb: number): string {
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TiB` : `${Math.round(gb)} GiB`;
}

/**
 * Enter/Space on a row opens its resource — but only when the row itself has
 * focus, so the buttons nested inside keep their own activation (the
 * PostureSection rule).
 */
function rowKeyHandler(open: () => void) {
  return (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    open();
  };
}

/**
 * The headline: worst RPO, how many resources are unprotected, and what the
 * orphans cost. Deliberately leads with the RPO — it is the number the feature
 * exists to answer, and "you have 400 snapshots" never was.
 */
function SummaryCards({ data }: { data: BackupCoverageResponse }) {
  const gt = useGT();
  const { summary } = data;
  const cards: Array<{ label: string; value: string; hint: string }> = [
    {
      label: gt("Worst RPO"),
      value: summary.worstRpoHours == null ? "—" : formatHours(summary.worstRpoHours),
      hint:
        summary.worstRpoHours == null
          ? gt("Nothing has a datable backup yet")
          : gt("Oldest newest-backup across everything protected"),
    },
    {
      label: gt("Unprotected"),
      value: `${summary.unprotectedCount} / ${summary.statefulCount}`,
      hint:
        summary.unknownCount > 0
          ? gt("Confirmed gaps — {count} more could not be assessed", {
              count: summary.unknownCount,
            })
          : gt("Stateful resources with no backup we can see"),
    },
    {
      label: gt("Orphaned backups"),
      value: String(summary.orphanedBackupCount),
      hint:
        summary.orphanedMonthlyCost != null
          ? gt("{amount} in the last 30 days", {
              amount: formatMoney(summary.orphanedMonthlyCost, summary.currency),
            })
          : summary.orphanedGb != null
            ? gt("{size} held", { size: formatGb(summary.orphanedGb) })
            : gt("Backups whose source is gone"),
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3 mb-5">
      {cards.map((card) => (
        <div key={card.label} className="rounded-xl border border-border p-4">
          <div className="text-xs text-on-surface-faint">{card.label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-on-surface">
            {card.value}
          </div>
          <div className="mt-1 text-xs text-on-surface-tertiary">{card.hint}</div>
        </div>
      ))}
    </div>
  );
}

function SeverityChips({ data }: { data: BackupCoverageResponse }) {
  const gt = useGT();
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {BACKUP_SEVERITIES.map((severity) => (
        <span
          key={severity}
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${SEVERITY_BADGE_CLASSES[severity]}`}
        >
          <span className="tabular-nums">{data.counts[severity]}</span>
          {BACKUP_SEVERITY_LABELS[severity]}
        </span>
      ))}
      {data.summary.unattributableBackupCount > 0 && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-on-surface-tertiary">
          <span className="tabular-nums">{data.summary.unattributableBackupCount}</span>
          {gt("Unattributable")}
        </span>
      )}
      {/* Same reason the unattributable count is here: an unassessed resource
          produces no finding, so without this the severity row would read as a
          clean bill of health for resources nobody actually checked. */}
      {data.summary.unknownCount > 0 && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-on-surface-tertiary">
          <span className="tabular-nums">{data.summary.unknownCount}</span>
          {gt("Not assessed")}
        </span>
      )}
    </div>
  );
}

function FindingRow({
  finding,
  onOpenResource,
}: {
  finding: BackupFinding;
  onOpenResource?: ((f: { accountId: string; resourceId: string }) => void) | undefined;
}) {
  const open = onOpenResource ? () => onOpenResource(finding) : undefined;
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
        {finding.displayName}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap align-top">
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
          {finding.resourceTypeName}
        </span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap align-top text-xs text-on-surface-tertiary">
        {finding.pluginName}
        <span className="text-on-surface-faint"> · {finding.accountName}</span>
      </td>
      <td className="px-3 py-2.5 w-full align-top text-on-surface-secondary">
        <span className="font-medium text-on-surface">{finding.title}</span>
        <span className="block text-xs text-on-surface-tertiary">{finding.detail}</span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap align-top text-right text-xs tabular-nums text-on-surface-tertiary">
        {finding.rpoHours != null
          ? formatHours(finding.rpoHours)
          : finding.monthlyCost != null
            ? formatMoney(finding.monthlyCost, finding.currency)
            : finding.sizeGb != null
              ? formatGb(finding.sizeGb)
              : "—"}
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap align-top text-right">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_BADGE_CLASSES[finding.severity]}`}
        >
          {BACKUP_SEVERITY_LABELS[finding.severity]}
        </span>
      </td>
    </tr>
  );
}

/**
 * Which policies bind this row. Both are shown when the RPO and the retention
 * floor come from different policies, because naming only one would send the
 * reader to edit the wrong objective.
 */
function describeRowPolicies(row: BackupCoverageRow): string {
  const names = [...new Set([row.rpoPolicyName, row.retentionPolicyName].filter(Boolean))];
  return names.length === 0 ? "—" : names.join(" · ");
}

function CoverageRow({
  row,
  onOpenResource,
}: {
  row: BackupCoverageRow;
  onOpenResource?: ((f: { accountId: string; resourceId: string }) => void) | undefined;
}) {
  const gt = useGT();
  const open = onOpenResource ? () => onOpenResource(row) : undefined;
  return (
    <tr
      className={`border-b border-border last:border-b-0 ${
        open ? "cursor-pointer hover:bg-surface-raised" : ""
      }`}
      onClick={open}
      onKeyDown={open ? rowKeyHandler(open) : undefined}
      tabIndex={open ? 0 : undefined}
    >
      <td className="px-4 py-2.5 whitespace-nowrap font-medium text-on-surface">
        {row.displayName}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary">
          {row.resourceTypeName}
        </span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-xs text-on-surface-tertiary">
        {row.pluginName}
        <span className="text-on-surface-faint"> · {row.accountName}</span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-right text-xs tabular-nums text-on-surface-tertiary">
        {row.backupCount}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-right text-xs tabular-nums text-on-surface-tertiary">
        {row.rpoHours != null
          ? formatHours(row.rpoHours)
          : row.backupCount > 0
            ? gt("unknown")
            : "—"}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-right text-xs tabular-nums text-on-surface-tertiary">
        {row.retentionDays != null ? `${row.retentionDays}d` : "—"}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-xs text-on-surface-tertiary">
        {describeRowPolicies(row)}
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap text-right">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_BADGE_CLASSES[row.state]}`}
        >
          {stateLabel(gt, row.state)}
        </span>
      </td>
    </tr>
  );
}

interface PolicyDraft {
  name: string;
  resourceTypeIds: string[];
  tagKey: string;
  tagValue: string;
  maxRpoHours: string;
  minRetentionDays: string;
}

const EMPTY_DRAFT: PolicyDraft = {
  name: "",
  resourceTypeIds: [],
  tagKey: "",
  tagValue: "",
  maxRpoHours: "24",
  minRetentionDays: "",
};

function draftToInput(draft: PolicyDraft): BackupPolicyInput {
  const rpo = draft.maxRpoHours.trim();
  const retention = draft.minRetentionDays.trim();
  return {
    name: draft.name,
    resourceTypeIds: draft.resourceTypeIds,
    tagKey: draft.tagKey.trim() === "" ? null : draft.tagKey.trim(),
    tagValue: draft.tagValue.trim() === "" ? null : draft.tagValue.trim(),
    maxRpoHours: rpo === "" ? null : Number(rpo),
    minRetentionDays: retention === "" ? null : Number(retention),
  };
}

function policyToDraft(policy: BackupPolicy): PolicyDraft {
  return {
    name: policy.name,
    resourceTypeIds: [...policy.resourceTypeIds],
    tagKey: policy.tagKey ?? "",
    tagValue: policy.tagValue ?? "",
    maxRpoHours: policy.maxRpoHours == null ? "" : String(policy.maxRpoHours),
    minRetentionDays: policy.minRetentionDays == null ? "" : String(policy.minRetentionDays),
  };
}

/** Describe a policy's selector in one line, so the list is readable at a glance. */
function describeSelector(gt: Gt, policy: BackupPolicy, typeLabels: Map<string, string>): string {
  const parts: string[] = [];
  parts.push(
    policy.resourceTypeIds.length === 0
      ? gt("every stateful resource")
      : policy.resourceTypeIds.map((id) => typeLabels.get(id) ?? id).join(", "),
  );
  if (policy.tagKey) {
    parts.push(
      policy.tagValue
        ? gt("tagged {tagKey}={tagValue}", { tagKey: policy.tagKey, tagValue: policy.tagValue })
        : gt("tagged {tagKey}", { tagKey: policy.tagKey }),
    );
  }
  return parts.join(", ");
}

function describeDemands(gt: Gt, policy: BackupPolicy): string {
  const parts: string[] = [];
  if (policy.maxRpoHours != null)
    parts.push(gt("RPO ≤ {hours}", { hours: formatHours(policy.maxRpoHours) }));
  if (policy.minRetentionDays != null)
    parts.push(gt("retention ≥ {days}d", { days: policy.minRetentionDays }));
  return parts.join(" · ");
}

function PolicyEditor({
  draft,
  onChange,
  resourceTypeOptions,
  disabled,
}: {
  draft: PolicyDraft;
  onChange: (draft: PolicyDraft) => void;
  resourceTypeOptions: ReadonlyArray<{ id: string; label: string }>;
  disabled: boolean;
}) {
  const gt = useGT();
  const inputClass =
    "rounded-lg border border-border bg-surface-raised px-2 py-1 text-xs text-on-surface disabled:opacity-50";
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
        {gt("Name")}
        <input
          type="text"
          value={draft.name}
          disabled={disabled}
          maxLength={BACKUP_POLICY_LIMITS.maxNameLength}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder={gt("Production databases, daily")}
          className={inputClass}
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Maximum RPO (hours)")}
          <input
            type="number"
            min={BACKUP_POLICY_LIMITS.minRpoHours}
            max={BACKUP_POLICY_LIMITS.maxRpoHours}
            value={draft.maxRpoHours}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, maxRpoHours: e.target.value })}
            placeholder={gt("Leave empty for no RPO")}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Minimum retention (days)")}
          <input
            type="number"
            min={BACKUP_POLICY_LIMITS.minRetentionDays}
            max={BACKUP_POLICY_LIMITS.maxRetentionDays}
            value={draft.minRetentionDays}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, minRetentionDays: e.target.value })}
            placeholder={gt("Leave empty for no floor")}
            className={inputClass}
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Tag key (optional)")}
          <input
            type="text"
            value={draft.tagKey}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, tagKey: e.target.value })}
            placeholder="env"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
          {gt("Tag value (optional)")}
          <input
            type="text"
            value={draft.tagValue}
            disabled={disabled || draft.tagKey.trim() === ""}
            onChange={(e) => onChange({ ...draft, tagValue: e.target.value })}
            placeholder="production"
            className={inputClass}
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs text-on-surface-tertiary">
          {gt("Resource types — none selected applies the policy to everything stateful")}
        </legend>
        {resourceTypeOptions.length === 0 ? (
          <T>
            <p className="text-xs text-on-surface-faint">
              No backup-aware resource types are synced yet, so this policy will apply to whatever
              appears once an account with them syncs.
            </p>
          </T>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {resourceTypeOptions.map((option) => {
              const selected = draft.resourceTypeIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() =>
                    onChange({
                      ...draft,
                      resourceTypeIds: selected
                        ? draft.resourceTypeIds.filter((id) => id !== option.id)
                        : [...draft.resourceTypeIds, option.id],
                    })
                  }
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                    selected
                      ? "border-transparent bg-surface-overlay text-on-surface"
                      : "border-border text-on-surface-tertiary hover:text-on-surface-secondary"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        )}
      </fieldset>
    </div>
  );
}

/**
 * Backup & restore coverage — "what is your actual RPO?".
 *
 * Three views over one computation: the gaps (worst first), the full coverage
 * table (every stateful resource and what protects it), and the org's recovery
 * objectives. Shared by the web and desktop Backups screens.
 *
 * Everything here is derived from already-synced inventory — no provider API
 * calls — which is why the coverage can be recomputed on every read rather than
 * stored, and why "unattributable" is a first-class answer alongside "orphaned":
 * telling someone a snapshot protects nothing when we simply could not tell is
 * an invitation to delete a live backup.
 */
export function BackupsSection({
  data,
  policies,
  error,
  onRetry,
  onOpenResource,
  onCreatePolicy,
  onUpdatePolicy,
  onDeletePolicy,
  resourceTypeOptions,
  drills,
  onRecordDrill,
}: BackupsSectionProps) {
  const gt = useGT();
  const [tab, setTab] = useState<Tab>("findings");
  const [kindFilter, setKindFilter] = useState<BackupFindingKind | "all">("all");
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  /** Id of the policy being edited; null while the draft is a new policy. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const canEditPolicies = Boolean(onCreatePolicy || onUpdatePolicy || onDeletePolicy);

  const typeLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of resourceTypeOptions ?? []) map.set(option.id, option.label);
    // The coverage rows are the authoritative source of what is actually
    // synced, so they fill any gap the caller's option list leaves.
    for (const row of data?.resources ?? []) map.set(row.resourceTypeId, row.resourceTypeName);
    return map;
  }, [resourceTypeOptions, data]);

  const typeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const option of resourceTypeOptions ?? []) seen.set(option.id, option.label);
    for (const row of data?.resources ?? []) {
      if (!seen.has(row.resourceTypeId)) seen.set(row.resourceTypeId, row.resourceTypeName);
    }
    return [...seen.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [resourceTypeOptions, data]);

  const findings = useMemo(
    () =>
      data == null
        ? []
        : kindFilter === "all"
          ? data.findings
          : data.findings.filter((f) => f.kind === kindFilter),
    [data, kindFilter],
  );

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setDraft(null);
      setEditingId(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function savePolicy() {
    if (!draft) return;
    const input = draftToInput(draft);
    const problem = validateBackupPolicyInput(input);
    if (problem) {
      setActionError(problem);
      return;
    }
    if (editingId && onUpdatePolicy) void run(() => onUpdatePolicy(editingId, input));
    else if (!editingId && onCreatePolicy) void run(() => onCreatePolicy(input));
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">{gt("Backups")}</h1>
      <T>
        <p className="text-sm text-on-surface-muted mb-6">
          What is actually recoverable, across every provider — which stateful resources have a
          backup, how old the newest one is, and which backups protect a resource that no longer
          exists. Derived from the state your accounts last synced; no provider calls are made.
        </p>
      </T>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load the backup coverage — {error}", { error })}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              {gt("Retry")}
            </button>
          )}
        </div>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Scanning synced resources…")}
        </p>
      )}
      {error != null && data !== null && (
        <p role="alert" className="mb-4 text-xs text-danger">
          {gt("Couldn't refresh — showing the last loaded coverage. {error}", { error })}
        </p>
      )}

      {data !== null && (
        <>
          <SummaryCards data={data} />

          <div
            role="tablist"
            aria-label={gt("Backup views")}
            className="mb-4 flex rounded-lg border border-border overflow-hidden text-xs w-fit"
          >
            {(
              [
                ["findings", gt("Gaps ({count})", { count: data.totalCount })],
                ["coverage", gt("Coverage ({count})", { count: data.resources.length })],
                ["policies", gt("Policies ({count})", { count: policies?.length ?? 0 })],
                ...(drills !== undefined
                  ? ([
                      [
                        "drills",
                        gt("Drills ({count})", { count: drills?.summary.eligibleCount ?? 0 }),
                      ],
                    ] as const)
                  : []),
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`px-3 py-1.5 transition-colors ${
                  tab === key
                    ? "bg-surface-overlay text-on-surface"
                    : "text-on-surface-tertiary hover:text-on-surface-secondary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {actionError != null && (
            <p role="alert" className="mb-4 text-xs text-danger">
              {actionError}
            </p>
          )}

          {tab === "findings" && (
            <>
              <SeverityChips data={data} />
              {data.findings.length === 0 ? (
                <T>
                  <p className="text-sm text-on-surface-faint">
                    No gaps. Coverage appears when a plugin declares which of its types are backups
                    and which need protecting, over fields its listers actually sync — so an empty
                    list means nothing declared is unprotected, not that nothing was checked. The
                    Coverage tab shows what was judged.
                  </p>
                </T>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-on-surface-faint mr-1">{gt("Show")}</span>
                    {(["all", ...FINDING_KINDS] as const).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        aria-pressed={kindFilter === kind}
                        onClick={() => setKindFilter(kind)}
                        className={`rounded-full border px-2.5 py-1 transition-colors ${
                          kindFilter === kind
                            ? "border-transparent bg-surface-overlay text-on-surface"
                            : "border-border text-on-surface-tertiary hover:text-on-surface-secondary"
                        }`}
                      >
                        {kind === "all"
                          ? gt("All ({count})", { count: data.totalCount })
                          : gt("{label} ({count})", {
                              label: BACKUP_FINDING_KIND_LABELS[kind],
                              count: data.kindCounts[kind],
                            })}
                      </button>
                    ))}
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-on-surface-faint">
                        <tr className="border-b border-border">
                          <th scope="col" className="px-4 py-2 text-left font-medium">
                            {gt("Resource")}
                          </th>
                          <th scope="col" className="px-3 py-2 text-left font-medium">
                            {gt("Type")}
                          </th>
                          <th scope="col" className="px-3 py-2 text-left font-medium">
                            {gt("Account")}
                          </th>
                          <th scope="col" className="px-3 py-2 text-left font-medium">
                            {gt("Gap")}
                          </th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">
                            {gt("Age / cost")}
                          </th>
                          <th scope="col" className="px-4 py-2 text-right font-medium">
                            {gt("Severity")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {findings.map((finding) => (
                          <FindingRow
                            key={`${finding.resourceId} ${finding.kind}`}
                            finding={finding}
                            onOpenResource={onOpenResource}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {tab === "coverage" && (
            <>
              {data.resources.length === 0 ? (
                <T>
                  <p className="text-sm text-on-surface-faint">
                    Nothing to judge yet. A resource appears here once its plugin declares it as
                    stateful and something the plugin&apos;s listers already sync can tell us
                    whether it is protected.
                  </p>
                </T>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-on-surface-faint">
                      <tr className="border-b border-border">
                        <th scope="col" className="px-4 py-2 text-left font-medium">
                          {gt("Resource")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-left font-medium">
                          {gt("Type")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-left font-medium">
                          {gt("Account")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          {gt("Backups")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          {gt("RPO")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          {gt("Retention")}
                        </th>
                        <th scope="col" className="px-3 py-2 text-left font-medium">
                          {gt("Policy")}
                        </th>
                        <th scope="col" className="px-4 py-2 text-right font-medium">
                          {gt("State")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.resources.map((row) => (
                        <CoverageRow
                          key={row.resourceId}
                          row={row}
                          onOpenResource={onOpenResource}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === "policies" && (
            <div className="flex flex-col gap-4">
              <T>
                <p className="text-sm text-on-surface-tertiary">
                  A policy is a recovery objective: which resources it applies to, and how fresh
                  their newest backup has to be. Without one, coverage still reports what is
                  unprotected — a policy is what turns &quot;there is a backup&quot; into
                  &quot;there is a backup recent enough&quot;.
                </p>
              </T>

              {policies === null ? (
                <p role="status" className="text-sm text-on-surface-faint">
                  {gt("Loading policies…")}
                </p>
              ) : (
                <>
                  {policies.length === 0 && draft === null && (
                    <p className="text-sm text-on-surface-faint">
                      {gt("No policies yet.")}
                      {canEditPolicies
                        ? gt(" Add one to start measuring against an objective.")
                        : gt(" Ask an administrator to add one.")}
                    </p>
                  )}

                  {policies.map((policy) => (
                    <div
                      key={policy.id}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-4"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-on-surface">{policy.name}</span>
                          {!policy.enabled && (
                            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-on-surface-tertiary">
                              {gt("Off")}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-on-surface-tertiary">
                          {gt("Applies to {selector}", {
                            selector: describeSelector(gt, policy, typeLabels),
                          })}
                        </div>
                        <div className="mt-0.5 text-xs text-on-surface-tertiary">
                          {describeDemands(gt, policy)}
                        </div>
                      </div>
                      {canEditPolicies && (
                        <div className="flex items-center gap-3 text-xs">
                          {onUpdatePolicy && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(() =>
                                  onUpdatePolicy(policy.id, { enabled: !policy.enabled }),
                                )
                              }
                              className="text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
                            >
                              {policy.enabled ? gt("Turn off") : gt("Turn on")}
                            </button>
                          )}
                          {onUpdatePolicy && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setEditingId(policy.id);
                                setDraft(policyToDraft(policy));
                                setActionError(null);
                              }}
                              className="text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
                            >
                              {gt("Edit")}
                            </button>
                          )}
                          {onDeletePolicy && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void run(() => onDeletePolicy(policy.id))}
                              className="text-on-surface-tertiary hover:text-danger disabled:opacity-50"
                            >
                              {gt("Delete")}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {draft !== null && (
                    <div className="flex flex-col gap-3">
                      <PolicyEditor
                        draft={draft}
                        onChange={setDraft}
                        resourceTypeOptions={typeOptions}
                        disabled={busy}
                      />
                      <div className="flex items-center gap-3 text-xs">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={savePolicy}
                          className="rounded-lg border border-border px-3 py-1.5 text-on-surface hover:bg-surface-overlay disabled:opacity-50"
                        >
                          {busy
                            ? gt("Saving…")
                            : editingId
                              ? gt("Save changes")
                              : gt("Create policy")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDraft(null);
                            setEditingId(null);
                            setActionError(null);
                          }}
                          className="text-on-surface-tertiary hover:text-on-surface-secondary"
                        >
                          {gt("Cancel")}
                        </button>
                      </div>
                    </div>
                  )}

                  {onCreatePolicy && draft === null && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setDraft(EMPTY_DRAFT);
                        setActionError(null);
                      }}
                      className="w-fit rounded-lg border border-border px-3 py-1.5 text-xs text-on-surface hover:bg-surface-overlay"
                    >
                      {gt("Add a policy")}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "drills" && (
            <DrillsPanel
              drills={drills ?? null}
              onRecordDrill={onRecordDrill}
              onOpenResource={onOpenResource}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The Drills tab — where each protected resource stands on restore, and the
 * form for recording that somebody tried.
 *
 * Kept as its own component rather than inlined because it owns a form with
 * its own validation, and the section above it is already long enough that a
 * fifth piece of local state in the same scope would be hard to follow.
 */
function DrillsPanel({
  drills,
  onRecordDrill,
  onOpenResource,
}: {
  drills: DrillCoverage | null;
  onRecordDrill: ((input: RestoreDrillInput) => Promise<void>) | undefined;
  onOpenResource: ((target: { accountId: string; resourceId: string }) => void) | undefined;
}) {
  const gt = useGT();
  const [recordFor, setRecordFor] = useState<DrillCoverageRow | null>(null);
  const [outcome, setOutcome] = useState<DrillOutcome>("verified");
  const [rto, setRto] = useState("");
  const [restoredFrom, setRestoredFrom] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (drills === null) {
    return (
      <p role="status" className="text-sm text-on-surface-faint">
        {gt("Working out what has been tested…")}
      </p>
    );
  }

  async function record(row: DrillCoverageRow) {
    if (!onRecordDrill) return;
    const input: RestoreDrillInput = {
      resourceId: row.resourceId,
      performedAt: new Date().toISOString(),
      outcome,
      // Blocked drills carry no duration; the validator rejects one, and
      // sending null rather than an empty parse keeps the two agreeing.
      rtoMinutes: outcome === "blocked" || rto.trim() === "" ? null : Number(rto),
      restoredFrom: restoredFrom.trim() || null,
      notes: notes.trim() || null,
    };
    const invalid = validateRestoreDrill(input);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onRecordDrill(input);
      setRecordFor(null);
      setRto("");
      setRestoredFrom("");
      setNotes("");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const summary = drills.summary;

  return (
    <div className="flex flex-col gap-4">
      <T>
        <p className="max-w-3xl text-sm text-on-surface-muted">
          A backup you have never restored is a hypothesis. Record each drill — what you restored,
          how long it took, and whether you checked what came back — and this page will tell you
          when the evidence has gone stale.
        </p>
      </T>

      <div className="grid gap-3 sm:grid-cols-4">
        {(
          [
            [gt("Verified"), String(summary.verifiedCount), false],
            [gt("Stale"), String(summary.staleCount), summary.staleCount > 0],
            [gt("Never verified"), String(summary.neverCount), summary.neverCount > 0],
            [gt("Worst measured RTO"), formatRto(summary.worstRtoMinutes), false],
          ] as const
        ).map(([label, value, bad]) => (
          <div key={label} className="rounded-xl border border-border p-4">
            <div className="text-xs text-on-surface-faint">{label}</div>
            <div
              className={`mt-1 text-2xl font-semibold tabular-nums ${
                bad ? "text-warning" : "text-on-surface"
              }`}
            >
              {value}
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-on-surface-faint">
        {gt("A verified drill counts for {days} days.", { days: drills.validDays })}
      </p>

      {problem && (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}

      {drills.rows.length === 0 ? (
        <T>
          <p className="text-sm text-on-surface-faint">
            Nothing to drill yet. A resource appears here once something is actually backing it up —
            a resource with no backup is a coverage gap rather than an untested restore.
          </p>
        </T>
      ) : (
        <ul className="flex flex-col gap-2">
          {drills.rows.map((row) => (
            <li key={row.resourceId} className="rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-center gap-3">
                {onOpenResource && row.accountId ? (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenResource({ accountId: row.accountId!, resourceId: row.resourceId })
                    }
                    className="text-sm font-medium text-on-surface underline-offset-2 hover:underline"
                  >
                    {row.resourceName ?? row.resourceId}
                  </button>
                ) : (
                  <span className="text-sm font-medium text-on-surface">
                    {row.resourceName ?? row.resourceId}
                  </span>
                )}
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${STANDING_CLASSES[row.standing]}`}
                >
                  {standingLabel(gt, row.standing)}
                </span>
                {row.accountName && (
                  <span className="text-xs text-on-surface-faint">{row.accountName}</span>
                )}
                <span className="text-xs text-on-surface-tertiary">
                  {row.lastVerifiedAt
                    ? gt("Verified {when} · restored in {rto}", {
                        when: new Date(row.lastVerifiedAt).toLocaleDateString(),
                        rto: formatRto(row.verifiedRtoMinutes),
                      })
                    : row.lastDrillAt
                      ? gt("Last attempt {when}", {
                          when: new Date(row.lastDrillAt).toLocaleDateString(),
                        })
                      : gt("No drill on record")}
                </span>
                {onRecordDrill && (
                  <button
                    type="button"
                    onClick={() => {
                      setRecordFor(recordFor?.resourceId === row.resourceId ? null : row);
                      setProblem(null);
                    }}
                    className="ml-auto rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary"
                  >
                    {gt("Record a drill")}
                  </button>
                )}
              </div>

              {recordFor?.resourceId === row.resourceId && (
                <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
                  <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                    {gt("What happened")}
                    <select
                      value={outcome}
                      onChange={(e) => setOutcome(e.target.value as DrillOutcome)}
                      className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                    >
                      {DRILL_OUTCOMES.map((value) => (
                        <option key={value} value={value}>
                          {outcomeLabel(gt, value)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {outcome !== "blocked" && (
                    <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                      {gt("Minutes to restore")}
                      <input
                        type="number"
                        min={0}
                        value={rto}
                        onChange={(e) => setRto(e.target.value)}
                        className="w-32 rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                      />
                    </label>
                  )}
                  <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                    {gt("Restored from")}
                    <input
                      value={restoredFrom}
                      onChange={(e) => setRestoredFrom(e.target.value)}
                      placeholder={gt("snapshot id, key, date…")}
                      className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                    />
                  </label>
                  <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs text-on-surface-tertiary">
                    {gt("What you checked, or what went wrong")}
                    <input
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void record(row)}
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
                  >
                    {gt("Save drill")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {drills.orphanedDrills.length > 0 && (
        <details className="text-xs text-on-surface-tertiary">
          <summary className="cursor-pointer">
            {gt("{count} drills against resources that are no longer here", {
              count: drills.orphanedDrills.length,
            })}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {drills.orphanedDrills.map((drill) => (
              <li key={drill.id}>
                {new Date(drill.performedAt).toLocaleDateString()} —{" "}
                {outcomeLabel(gt, drill.outcome)}
                {drill.notes ? ` · ${drill.notes}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
