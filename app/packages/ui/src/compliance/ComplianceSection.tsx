import { Fragment, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useGT } from "gt-react";
import {
  COMPLIANCE_CONTROL_LIMITS,
  compliancePackPeriodFor,
  getEvidenceSource,
  validateComplianceControlSetting,
  type ComplianceControlRow,
  type ComplianceControlSettingInput,
  type ComplianceControlStatus,
  type ComplianceFrameworkSummary,
  type CompliancePeriod,
  type ComplianceStatusResponse,
  type EvidenceSourceResult,
  type EvidenceStatus,
  type OwnerCandidate,
} from "@infrawrench/client-core";

import { useDataString } from "../i18n/data-strings.js";
import { ChevronIcon } from "../components/icons/ChromeIcons.js";
import { ComplianceSchedules } from "./ComplianceSchedules.js";
import type { ComplianceClient } from "./types.js";

export interface ComplianceSectionProps {
  client: ComplianceClient;
  /**
   * The framework the tab is on (remembered in the tab target and the URL).
   * Absent, the first framework the server lists is shown.
   */
  framework?: string | undefined;
  /**
   * The user picked another framework. Hosts navigate so the tab and URL
   * record it; omitted, the choice is kept in local state only.
   */
  onFrameworkChange?: ((frameworkId: string) => void) | undefined;
}

type PeriodPreset = "last-30" | "last-90" | "previous-month" | "previous-quarter" | "custom";

type ControlFilter = "all" | ComplianceControlStatus | "unowned";

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function lastDays(days: number, now: Date = new Date()): CompliancePeriod {
  const to = utcDay(now);
  const from = utcDay(new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000));
  return { from, to };
}

/** The period a picker state stands for; null while a custom range is incomplete or inverted. */
function resolvePeriod(
  preset: PeriodPreset,
  customFrom: string,
  customTo: string,
): CompliancePeriod | null {
  if (preset !== "custom") return presetPeriod(preset);
  if (!customFrom || !customTo || customFrom > customTo) return null;
  return { from: customFrom, to: customTo };
}

function presetPeriod(preset: Exclude<PeriodPreset, "custom">): CompliancePeriod {
  const today = utcDay(new Date());
  switch (preset) {
    case "last-30":
      return lastDays(30);
    case "last-90":
      return lastDays(90);
    case "previous-month":
      return compliancePackPeriodFor("monthly", today);
    case "previous-quarter":
      return compliancePackPeriodFor("quarterly", today);
  }
}

const CONTROL_STATUS_CLASSES: Record<ComplianceControlStatus, string> = {
  evidence: "bg-green-500/10 text-success",
  gaps: "bg-red-500/10 text-danger",
  "not-applicable": "bg-surface-overlay text-on-surface-tertiary",
};

const EVIDENCE_STATUS_CLASSES: Record<EvidenceStatus, string> = {
  present: "bg-green-500/10 text-success",
  gap: "bg-red-500/10 text-danger",
  "no-data": "bg-amber-500/10 text-warning",
  unavailable: "bg-surface-overlay text-on-surface-faint",
};

function useControlStatusLabel(): (status: ComplianceControlStatus) => string {
  const gt = useGT();
  return (status) => {
    switch (status) {
      case "evidence":
        return gt("Evidence present");
      case "gaps":
        return gt("Gaps");
      default:
        return gt("Not applicable");
    }
  };
}

function useEvidenceStatusLabel(): (status: EvidenceStatus) => string {
  const gt = useGT();
  return (status) => {
    switch (status) {
      case "present":
        return gt("Evidence present");
      case "gap":
        return gt("Gap found");
      case "no-data":
        return gt("No evidence");
      default:
        return gt("Unavailable");
    }
  };
}

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}
    >
      {children}
    </span>
  );
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

/** The label of a source id: the result's own label, the registry's, or the id. */
function sourceLabel(id: string, results: ReadonlyMap<string, EvidenceSourceResult>): string {
  return results.get(id)?.label ?? getEvidenceSource(id)?.label ?? id;
}

function MetricsTable({ source }: { source: EvidenceSourceResult }) {
  const gt = useGT();
  const gtData = useDataString();
  if (source.metrics.length === 0) return null;
  return (
    <table className="mt-2 w-full max-w-md text-xs">
      <tbody>
        {source.metrics.map((m) => (
          <tr key={m.key} className="border-b border-border last:border-0">
            <td className="py-1 pr-3 text-on-surface-tertiary">{gtData(m.label)}</td>
            <td className="py-1 text-right tabular-nums text-on-surface">
              {m.value === null
                ? gt("Unknown")
                : typeof m.value === "number"
                  ? m.value.toLocaleString()
                  : m.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SourceDetails({ source }: { source: EvidenceSourceResult }) {
  const gt = useGT();
  const gtData = useDataString();
  const evidenceLabel = useEvidenceStatusLabel();
  return (
    <div className="rounded-xl border border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-on-surface">{gtData(source.label)}</span>
        <Badge className={EVIDENCE_STATUS_CLASSES[source.status]}>
          {evidenceLabel(source.status)}
        </Badge>
        <span
          className="text-[11px] text-on-surface-faint"
          title={
            source.kind === "snapshot"
              ? gt("Describes the organization as it stands now; the period does not filter it.")
              : gt("A log of what happened, filtered to the period.")
          }
        >
          {source.kind === "snapshot" ? gt("Snapshot") : gt("Period log")}
        </span>
        {source.itemCount > 0 && (
          <span className="text-[11px] text-on-surface-faint">
            {gt("{count} row(s) in the pack", { count: source.itemCount })}
          </span>
        )}
      </div>
      {source.summary && (
        <p className="mt-1 text-xs text-on-surface-secondary">{gtData(source.summary)}</p>
      )}
      {source.status === "unavailable" && source.error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {gtData(source.error)}
        </p>
      )}
      <MetricsTable source={source} />
      {source.gaps.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-danger">
          {source.gaps.map((gap) => (
            <li key={gap}>{gtData(gap)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const MEMBER_PREFIX = "member:";
const LABEL_OPTION = "label";

function ControlEditor({
  control,
  members,
  onSave,
  onReset,
}: {
  control: ComplianceControlRow;
  members: readonly OwnerCandidate[] | null;
  onSave: (input: ComplianceControlSettingInput) => Promise<void>;
  onReset: (() => Promise<void>) | undefined;
}) {
  const gt = useGT();
  const idPrefix = useId();
  const [applicable, setApplicable] = useState(control.applicable);
  const [justification, setJustification] = useState(control.justification ?? "");
  const [ownerChoice, setOwnerChoice] = useState<string>(() => {
    if (control.owner?.userId) return `${MEMBER_PREFIX}${control.owner.userId}`;
    if (control.owner?.isLabel) return LABEL_OPTION;
    return "";
  });
  const [ownerLabel, setOwnerLabel] = useState(
    control.owner?.isLabel ? control.owner.displayName : "",
  );
  const [notes, setNotes] = useState(control.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input: ComplianceControlSettingInput = {
    applicable,
    justification: applicable ? justification.trim() || null : justification.trim(),
    ownerUserId: ownerChoice.startsWith(MEMBER_PREFIX)
      ? ownerChoice.slice(MEMBER_PREFIX.length)
      : null,
    ownerLabel: ownerChoice === LABEL_OPTION ? ownerLabel.trim() || null : null,
    notes: notes.trim() || null,
  };
  const invalid = validateComplianceControlSetting(input);
  const needsJustification = !applicable && justification.trim() === "";

  // A departed member stays selectable as themselves rather than silently
  // dropping to "Unowned" when someone edits the notes.
  const currentUserId = control.owner?.userId ?? null;
  const memberOptions = members ?? [];
  const ownerIsFormer =
    currentUserId !== null && !memberOptions.some((m) => m.userId === currentUserId);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const fieldClass =
    "w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface";

  return (
    <div className="mt-3 rounded-xl border border-border bg-surface px-4 py-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-on-surface-tertiary">
        {gt("Decision")}
      </h4>
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            checked={applicable}
            onChange={(e) => setApplicable(e.target.checked)}
          />
          {gt("Applicable to this organization")}
        </label>

        <div>
          <label className="mb-1 block text-xs text-on-surface-secondary" htmlFor={`${idPrefix}-j`}>
            {applicable ? gt("Justification (optional)") : gt("Justification (required)")}
          </label>
          <textarea
            id={`${idPrefix}-j`}
            rows={2}
            maxLength={COMPLIANCE_CONTROL_LIMITS.maxJustificationLength}
            className={fieldClass}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder={gt("Why this control does or does not apply")}
          />
          {needsJustification && (
            <p className="mt-0.5 text-xs text-warning">
              {gt("A control marked not applicable needs a justification.")}
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs text-on-surface-secondary" htmlFor={`${idPrefix}-o`}>
            {gt("Owner")}
          </label>
          <div className="flex flex-wrap gap-2">
            <select
              id={`${idPrefix}-o`}
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
              value={ownerChoice}
              onChange={(e) => setOwnerChoice(e.target.value)}
            >
              <option value="">{gt("Unowned")}</option>
              {ownerIsFormer && currentUserId && (
                <option value={`${MEMBER_PREFIX}${currentUserId}`}>
                  {control.owner?.displayName ?? gt("Former member")}
                </option>
              )}
              {memberOptions.map((m) => (
                <option key={m.userId} value={`${MEMBER_PREFIX}${m.userId}`}>
                  {m.name && m.name !== m.email ? `${m.name} (${m.email})` : m.email}
                </option>
              ))}
              <option value={LABEL_OPTION}>{gt("A team or alias…")}</option>
            </select>
            {ownerChoice === LABEL_OPTION && (
              <input
                type="text"
                className="min-w-48 flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                maxLength={COMPLIANCE_CONTROL_LIMITS.maxOwnerLabelLength}
                value={ownerLabel}
                onChange={(e) => setOwnerLabel(e.target.value)}
                placeholder={gt("Platform team")}
                aria-label={gt("Owner label")}
              />
            )}
          </div>
          {members === null && (
            <p className="mt-0.5 text-xs text-on-surface-faint">{gt("Loading members…")}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs text-on-surface-secondary" htmlFor={`${idPrefix}-n`}>
            {gt("Notes")}
          </label>
          <textarea
            id={`${idPrefix}-n`}
            rows={2}
            maxLength={COMPLIANCE_CONTROL_LIMITS.maxNotesLength}
            className={fieldClass}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={gt("Where the procedure lives, compensating controls, follow-ups")}
          />
        </div>

        {error !== null && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || invalid !== null}
            title={invalid ?? undefined}
            onClick={() => void run(() => onSave(input))}
            className="rounded-lg border border-border-strong bg-surface-raised px-3 py-1.5 text-sm font-medium text-on-surface disabled:opacity-50"
          >
            {gt("Save")}
          </button>
          {onReset && control.settingUpdatedAt !== null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(gt("Reset this control to applicable and unowned?"))) return;
                void run(onReset);
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface-secondary hover:border-border-strong disabled:opacity-50"
            >
              {gt("Reset")}
            </button>
          )}
          {control.settingUpdatedAt && (
            <span className="text-xs text-on-surface-faint">
              {gt("Last changed {when}", { when: formatDate(control.settingUpdatedAt) ?? "" })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ControlRow({
  control,
  results,
  expanded,
  onToggle,
  members,
  onSave,
  onReset,
}: {
  control: ComplianceControlRow;
  results: ReadonlyMap<string, EvidenceSourceResult>;
  expanded: boolean;
  onToggle: () => void;
  members: readonly OwnerCandidate[] | null;
  onSave: ((input: ComplianceControlSettingInput) => Promise<void>) | undefined;
  onReset: (() => Promise<void>) | undefined;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const statusLabel = useControlStatusLabel();
  const missing = new Set(control.missingSources);
  return (
    <>
      <tr className="border-b border-border hover:bg-surface-raised">
        <td className="whitespace-nowrap px-4 py-2.5 align-top">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-on-surface hover:underline"
          >
            <ChevronIcon direction={expanded ? "down" : "right"} size={10} />
            {control.id}
          </button>
        </td>
        <td className="px-3 py-2.5 align-top text-sm text-on-surface">{gtData(control.title)}</td>
        <td className="px-3 py-2.5 align-top">
          <Badge className={CONTROL_STATUS_CLASSES[control.status]}>
            {statusLabel(control.status)}
          </Badge>
        </td>
        <td className="px-3 py-2.5 align-top text-xs">
          {control.owner ? (
            <span className="text-on-surface-secondary">
              {control.owner.isLabel
                ? control.owner.displayName
                : gtData(control.owner.displayName)}
            </span>
          ) : control.applicable ? (
            <span className="text-warning">{gt("Unowned")}</span>
          ) : (
            <span className="text-on-surface-faint">{"–"}</span>
          )}
        </td>
        <td className="px-3 py-2.5 align-top">
          <div className="flex flex-wrap gap-1">
            {control.sources.map((id) => (
              <span
                key={id}
                className={`rounded-full border border-border px-1.5 text-[11px] ${
                  missing.has(id)
                    ? "text-on-surface-faint line-through"
                    : "text-on-surface-tertiary"
                }`}
              >
                {gtData(sourceLabel(id, results))}
              </span>
            ))}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-surface-raised/50">
          <td colSpan={5} className="px-4 py-3">
            {control.reasons.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-on-surface-tertiary">
                  {gt("Why")}
                </h4>
                <ul className="list-disc pl-5 text-xs text-danger">
                  {control.reasons.map((r) => (
                    <li key={r}>{gtData(r)}</li>
                  ))}
                </ul>
              </div>
            )}
            {!control.applicable && control.justification && (
              <p className="mb-3 text-xs text-on-surface-secondary">
                {gt("Not applicable: {justification}", { justification: control.justification })}
              </p>
            )}
            {control.missingSources.length > 0 && (
              <p className="mb-3 text-xs text-warning">
                {gt("No evidence from: {sources}", {
                  sources: control.missingSources
                    .map((id) => gtData(sourceLabel(id, results)))
                    .join(", "),
                })}
              </p>
            )}
            {control.notes && !onSave && (
              <p className="mb-3 whitespace-pre-wrap text-xs text-on-surface-secondary">
                {gt("Notes: {notes}", { notes: control.notes })}
              </p>
            )}
            <div className="flex flex-col gap-2">
              {control.sources.map((id) => {
                const result = results.get(id);
                return result ? (
                  <SourceDetails key={id} source={result} />
                ) : (
                  <div
                    key={id}
                    className="rounded-xl border border-border px-4 py-3 text-xs text-on-surface-faint"
                  >
                    {gt("{source}: no result was returned for this source.", {
                      source: gtData(sourceLabel(id, results)),
                    })}
                  </div>
                );
              })}
            </div>
            {onSave && (
              <ControlEditor
                // Remount when the stored decision changes so the form shows it.
                key={control.settingUpdatedAt ?? "none"}
                control={control}
                members={members}
                onSave={onSave}
                onReset={onReset}
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Compliance: evidence Infrawrench already collects (access review, audit
 * log, posture, vulnerabilities, backups, change records...) mapped onto a
 * framework's controls, with the org's own decisions per control
 * (applicability, owner, notes) and the evidence pack an auditor receives.
 * Shared by the web and desktop Compliance tabs; the CLI and mobile read the
 * same status endpoint.
 *
 * Nothing here judges a control: the status comes computed from the server
 * (`computeComplianceControls` in client-core), so "what makes a control
 * green" is decided in one place.
 */
export function ComplianceSection({
  client,
  framework,
  onFrameworkChange,
}: ComplianceSectionProps) {
  const gt = useGT();
  const gtData = useDataString();
  const idPrefix = useId();
  const [frameworks, setFrameworks] = useState<ComplianceFrameworkSummary[] | null>(null);
  const [frameworksError, setFrameworksError] = useState<string | null>(null);
  const [localFramework, setLocalFramework] = useState<string | undefined>(framework);
  const [preset, setPreset] = useState<PeriodPreset>("last-90");
  const [customFrom, setCustomFrom] = useState(() => lastDays(90).from);
  const [customTo, setCustomTo] = useState(() => lastDays(90).to);
  const [status, setStatus] = useState<ComplianceStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<ControlFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<OwnerCandidate[] | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => setLocalFramework(framework), [framework]);

  useEffect(() => {
    let cancelled = false;
    client
      .getFrameworks()
      .then((list) => {
        if (!cancelled) {
          setFrameworks(list);
          setFrameworksError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setFrameworksError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, reloadKey]);

  const canEdit = Boolean(client.putControl);
  useEffect(() => {
    let cancelled = false;
    if (!canEdit || !client.listMembers) {
      setMembers([]);
      return;
    }
    client
      .listMembers()
      .then((m) => {
        if (!cancelled) setMembers(m);
      })
      .catch(() => {
        // Without the member list the owner can still be a typed label.
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, canEdit]);

  const frameworkId =
    frameworks && localFramework && frameworks.some((f) => f.id === localFramework)
      ? localFramework
      : (frameworks?.[0]?.id ?? null);

  const period = useMemo(
    () => resolvePeriod(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const loadStatus = useCallback(
    (fw: string, p: CompliancePeriod, isCurrent: () => boolean) => {
      client
        .getStatus(fw, p)
        .then((s) => {
          if (isCurrent()) {
            setStatus(s);
            setStatusError(null);
          }
        })
        .catch((e: unknown) => {
          if (isCurrent()) setStatusError(e instanceof Error ? e.message : String(e));
        });
    },
    [client],
  );

  useEffect(() => {
    if (!frameworkId || !period) return;
    let current = true;
    setStatusError(null);
    // A different framework is a different table: blank it rather than show
    // SOC 2 rows under an ISO 27001 heading while the read is in flight.
    setStatus((s) => (s && s.framework.id === frameworkId ? s : null));
    loadStatus(frameworkId, period, () => current);
    return () => {
      current = false;
    };
  }, [frameworkId, period, reloadKey, loadStatus]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  function selectFramework(id: string) {
    setExpanded(null);
    setFilter("all");
    setLocalFramework(id);
    onFrameworkChange?.(id);
  }

  const results = useMemo(
    () => new Map((status?.sources ?? []).map((s) => [s.sourceId, s])),
    [status],
  );

  const groups = useMemo(() => {
    const out: { group: string; controls: ComplianceControlRow[] }[] = [];
    for (const c of status?.controls ?? []) {
      if (filter === "unowned" && !(c.applicable && !c.owner)) continue;
      if (filter !== "all" && filter !== "unowned" && c.status !== filter) continue;
      const last = out[out.length - 1];
      if (last && last.group === c.group) last.controls.push(c);
      else out.push({ group: c.group, controls: [c] });
    }
    return out;
  }, [status, filter]);

  async function download() {
    if (!client.downloadPack || !frameworkId || !period) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await client.downloadPack(frameworkId, period);
    } catch (e: unknown) {
      setDownloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  const putControl = client.putControl;
  const deleteControl = client.deleteControl;
  const save =
    putControl && frameworkId
      ? (controlId: string) => async (input: ComplianceControlSettingInput) => {
          await putControl(frameworkId, controlId, input);
          refresh();
        }
      : undefined;
  const reset =
    deleteControl && frameworkId
      ? (controlId: string) => async () => {
          await deleteControl(frameworkId, controlId);
          refresh();
        }
      : undefined;

  const selectClass =
    "rounded-lg border border-border bg-surface-raised px-2 py-1.5 text-sm text-on-surface";
  const selectedFramework = frameworks?.find((f) => f.id === frameworkId) ?? null;

  const chips: { key: ControlFilter; label: string; count: number; tone: string }[] = status
    ? [
        {
          key: "evidence",
          label: gt("Evidence"),
          count: status.counts.evidence,
          tone: "text-success",
        },
        { key: "gaps", label: gt("Gaps"), count: status.counts.gaps, tone: "text-danger" },
        {
          key: "not-applicable",
          label: gt("Not applicable"),
          count: status.counts.notApplicable,
          tone: "text-on-surface-tertiary",
        },
        {
          key: "unowned",
          label: gt("Unowned"),
          count: status.counts.unowned,
          tone: "text-warning",
        },
      ]
    : [];

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">{gt("Compliance")}</h1>
        {client.downloadPack && (
          <button
            type="button"
            disabled={downloading || !frameworkId || !period}
            onClick={() => void download()}
            className="rounded-lg border border-border-strong bg-surface-raised px-3 py-1.5 text-sm font-medium text-on-surface hover:border-border-strong disabled:opacity-50"
          >
            {downloading ? gt("Building the pack…") : gt("Download evidence pack")}
          </button>
        )}
      </div>
      <p className="mb-4 text-sm text-on-surface-muted">
        {gt(
          "Evidence Infrawrench already collects, mapped to framework controls. A control with no evidence is a gap, never a pass; mark controls that do not apply, with a justification.",
        )}
      </p>
      {downloadError !== null && (
        <p role="alert" className="mb-3 text-xs text-danger">
          {gt("Couldn't build the evidence pack: {error}", { error: downloadError })}
        </p>
      )}

      {frameworksError !== null && frameworks === null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load the frameworks: {error}", { error: frameworksError })}{" "}
          <button type="button" onClick={refresh} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}
      {frameworks === null && frameworksError === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading compliance…")}
        </p>
      )}

      {frameworks !== null && frameworkId && (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-on-surface-tertiary" htmlFor={`${idPrefix}-fw`}>
                {gt("Framework")}
              </label>
              <select
                id={`${idPrefix}-fw`}
                className={selectClass}
                value={frameworkId}
                onChange={(e) => selectFramework(e.target.value)}
              >
                {frameworks.map((f) => (
                  <option key={f.id} value={f.id}>
                    {gtData(f.name)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-on-surface-tertiary" htmlFor={`${idPrefix}-period`}>
                {gt("Period")}
              </label>
              <select
                id={`${idPrefix}-period`}
                className={selectClass}
                value={preset}
                onChange={(e) => {
                  const next = e.target.value as PeriodPreset;
                  if (next === "custom" && period) {
                    setCustomFrom(period.from);
                    setCustomTo(period.to);
                  }
                  setPreset(next);
                }}
              >
                <option value="last-30">{gt("Last 30 days")}</option>
                <option value="last-90">{gt("Last 90 days")}</option>
                <option value="previous-month">{gt("Previous month")}</option>
                <option value="previous-quarter">{gt("Previous quarter")}</option>
                <option value="custom">{gt("Custom range")}</option>
              </select>
            </div>
            {preset === "custom" && (
              <>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-on-surface-tertiary" htmlFor={`${idPrefix}-from`}>
                    {gt("From")}
                  </label>
                  <input
                    id={`${idPrefix}-from`}
                    type="date"
                    className={selectClass}
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-on-surface-tertiary" htmlFor={`${idPrefix}-to`}>
                    {gt("To")}
                  </label>
                  <input
                    id={`${idPrefix}-to`}
                    type="date"
                    className={selectClass}
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </div>
              </>
            )}
            {period && (
              <span className="pb-2 text-xs text-on-surface-faint">
                {gt("{from} to {to} (UTC)", { from: period.from, to: period.to })}
              </span>
            )}
          </div>
          {preset === "custom" && !period && (
            <p role="alert" className="mb-3 text-xs text-danger">
              {gt("Pick a start date on or before the end date.")}
            </p>
          )}

          {selectedFramework && (
            <div className="mb-4 text-xs text-on-surface-tertiary">
              <p>{gtData(selectedFramework.description)}</p>
              {selectedFramework.scopeNote && (
                <p className="mt-1 text-on-surface-faint">{gtData(selectedFramework.scopeNote)}</p>
              )}
            </div>
          )}

          {statusError !== null && status === null && (
            <div role="alert" className="text-sm text-danger">
              {gt("Couldn't load the compliance status: {error}", { error: statusError })}{" "}
              <button type="button" onClick={refresh} className="underline">
                {gt("Retry")}
              </button>
            </div>
          )}
          {statusError !== null && status !== null && (
            <p role="alert" className="mb-3 text-xs text-danger">
              {gt("Couldn't refresh; showing the last loaded status. {error}", {
                error: statusError,
              })}
            </p>
          )}
          {status === null && statusError === null && period && (
            <p role="status" className="text-sm text-on-surface-faint">
              {gt("Collecting evidence…")}
            </p>
          )}

          {status !== null && (
            <>
              <div className="mb-4 flex flex-wrap gap-2">
                {chips.map((chip) => {
                  const active = filter === chip.key;
                  return (
                    <button
                      key={chip.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setFilter(active ? "all" : chip.key)}
                      className={`rounded-xl border px-3 py-2 text-left transition-colors hover:bg-surface-raised ${
                        active ? "border-on-surface-tertiary bg-surface-raised" : "border-border"
                      }`}
                    >
                      <span className={`block text-lg font-semibold tabular-nums ${chip.tone}`}>
                        {chip.count}
                      </span>
                      <span className="block text-xs text-on-surface-tertiary">{chip.label}</span>
                    </button>
                  );
                })}
                <span className="self-end pb-2 text-xs text-on-surface-faint">
                  {gt("{total} controls · generated {when}", {
                    total: status.counts.total,
                    when: formatDate(status.generatedAt) ?? "",
                  })}
                </span>
              </div>

              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-border text-xs text-on-surface-tertiary">
                      <th className="px-4 py-2 font-medium">{gt("Control")}</th>
                      <th className="px-3 py-2 font-medium">{gt("Title")}</th>
                      <th className="px-3 py-2 font-medium">{gt("Status")}</th>
                      <th className="px-3 py-2 font-medium">{gt("Owner")}</th>
                      <th className="px-3 py-2 font-medium">{gt("Evidence sources")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.length === 0 && (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-4 py-6 text-center text-sm text-on-surface-faint"
                        >
                          {gt("No controls match this filter.")}
                        </td>
                      </tr>
                    )}
                    {groups.map((g) => (
                      <Fragment key={g.group}>
                        <tr className="border-b border-border bg-surface-raised/60">
                          <td
                            colSpan={5}
                            className="px-4 py-1.5 text-xs font-semibold text-on-surface-secondary"
                          >
                            {gtData(g.group)}
                          </td>
                        </tr>
                        {g.controls.map((c) => (
                          <ControlRow
                            key={c.id}
                            control={c}
                            results={results}
                            expanded={expanded === c.id}
                            onToggle={() => setExpanded((cur) => (cur === c.id ? null : c.id))}
                            members={members}
                            onSave={save?.(c.id)}
                            onReset={reset?.(c.id)}
                          />
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              <section className="mt-8">
                <h2 className="mb-1 text-sm font-semibold text-on-surface">
                  {gt("Evidence sources")}
                </h2>
                <p className="mb-3 text-xs text-on-surface-faint">
                  {gt(
                    "What each source reported for this period. A source you lack the permission for is listed as unavailable rather than hidden.",
                  )}
                </p>
                <div className="flex flex-col gap-2">
                  {status.sources.map((s) => (
                    <SourceDetails key={s.sourceId} source={s} />
                  ))}
                </div>
              </section>
            </>
          )}

          <ComplianceSchedules client={client} frameworks={frameworks} frameworkId={frameworkId} />
        </>
      )}
    </div>
  );
}
