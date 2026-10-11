import { useMemo, useState } from "react";
import { useGT, useLocale } from "gt-react";
import {
  VULNERABILITY_SEVERITY_ORDER,
  filterVulnerabilityFindings,
  groupRunningByType,
  type DismissedVulnerabilityFinding,
  type VulnerabilityArtifactKind,
  type VulnerabilityFindingRow,
  type VulnerabilityListResponse,
  type VulnerabilityMatchKind,
  type VulnerabilityRunningRef,
  type VulnerabilitySettings,
  type VulnerabilitySettingsPatch,
  type VulnerabilitySeverity,
  type VulnerabilitySource,
} from "@infrawrench/client-core";

import { useDataString } from "../i18n/data-strings.js";
import { ChevronIcon } from "../components/icons/ChromeIcons.js";

/** What a dismissal (or a restore) is keyed on: the advisory plus an artifact key, `"*"` for everywhere. */
export interface VulnerabilityDismissalTarget {
  advisoryId: string;
  artifactKey: string;
}

export interface VulnerabilitiesSectionProps {
  /**
   * The joined feed, or null while the first load is in flight. Hosts fetch
   * (web: `/vulnerabilities`, desktop: IPC) and hand the response over; this
   * component never talks to a network.
   */
  data: VulnerabilityListResponse | null;
  /**
   * Load or refresh failure. With `data` still present the last feed stays on
   * screen under a banner: a failed refresh must not blank a drawn list.
   */
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** Open a running resource's detail view. Omitted, resource names are plain text. */
  onOpenResource?: ((resource: VulnerabilityRunningRef) => void) | undefined;
  /**
   * Accept an advisory as a known risk, for one artifact or everywhere
   * (`artifactKey === "*"`). Omitted, the section is read-only: what a host
   * without `resources:write` passes. Rejecting leaves the row in place and
   * shows the message; the host refreshes on success.
   */
  onDismiss?:
    ((input: VulnerabilityDismissalTarget & { reason: string }) => Promise<void>) | undefined;
  /** Undo a dismissal. Omitted, dismissed findings are listed but not undoable. */
  onRestore?: ((input: VulnerabilityDismissalTarget) => Promise<void>) | undefined;
  /** Alert settings. Omitted (no `org:settings:write`), the settings card is hidden. */
  settings?: VulnerabilitySettings | null | undefined;
  /** Save a settings change. Omitted, the settings card is read-only. */
  onUpdateSettings?: ((patch: VulnerabilitySettingsPatch) => Promise<void>) | undefined;
  /** Jump to the Posture tab, the configuration half of the same question. */
  onOpenPosture?: (() => void) | undefined;
}

type RunningFilter = "all" | "running" | "not-running";

/** Rows drawn before "Show more": a large org can carry thousands of findings. */
const PAGE_SIZE = 200;

/** Pill tones per bucket, the PostureSection recipe plus a muted tone for unscored. */
const SEVERITY_BADGE_CLASSES: Record<VulnerabilitySeverity, string> = {
  critical: "bg-red-500/10 text-danger",
  high: "bg-orange-500/10 text-severe",
  medium: "bg-amber-500/10 text-warning",
  low: "bg-surface-overlay text-on-surface-tertiary",
  unknown: "bg-surface-overlay text-on-surface-faint",
};

function useSeverityLabel(): (severity: VulnerabilitySeverity) => string {
  const gt = useGT();
  return (severity) => {
    switch (severity) {
      case "critical":
        return gt("Critical");
      case "high":
        return gt("High");
      case "medium":
        return gt("Medium");
      case "low":
        return gt("Low");
      default:
        return gt("Unscored");
    }
  };
}

/** Only https links leave the app; anything else renders as plain text. */
function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function formatDate(iso: string | null | undefined, withTime = false): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return withTime
    ? new Date(parsed).toLocaleString()
    : new Date(parsed).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

/** `sha256:0123456789ab`: enough to tell two builds apart at a glance. */
function shortDigest(digest: string | null): string | null {
  if (!digest) return null;
  const [algo, hex] = digest.includes(":") ? digest.split(":", 2) : ["", digest];
  return `${algo ? `${algo}:` : ""}${(hex ?? "").slice(0, 12)}`;
}

/**
 * "Running in 3 Pods and 1 Lambda Function", translated: the count template
 * and the sentence go through gt, the type names (data) through
 * useDataString, and the list joins with the locale's own conjunction.
 */
function useRunningSummary(): (running: readonly VulnerabilityRunningRef[]) => string {
  const gt = useGT();
  const gtData = useDataString();
  const locale = useLocale();
  const listFormat = useMemo(() => {
    try {
      return new Intl.ListFormat(locale || undefined, { type: "conjunction" });
    } catch {
      return new Intl.ListFormat(undefined, { type: "conjunction" });
    }
  }, [locale]);
  return (running) => {
    const parts = groupRunningByType(running).map((group) =>
      gt("{count} {resourceType}", {
        count: group.count,
        resourceType: gtData(
          group.count === 1 ? group.resourceTypeName : group.resourceTypePluralName,
        ),
      }),
    );
    return gt("Running in {resources}", { resources: listFormat.format(parts) });
  };
}

function useMatchLabels(): Record<VulnerabilityMatchKind, { label: string; hint: string }> {
  const gt = useGT();
  return {
    digest: {
      label: gt("Exact digest"),
      hint: gt("The resource runs exactly the image digest the scanner scanned."),
    },
    resource: {
      label: gt("Named by the scanner"),
      hint: gt("The scanner reported this resource itself."),
    },
    tag: {
      label: gt("Tag match (unconfirmed)"),
      hint: gt(
        "Same repository and tag as the scanned image, but no digest to confirm it: the tag may have moved since the scan.",
      ),
    },
  };
}

function useDismissScopeLabel(): (kind: VulnerabilityArtifactKind) => string {
  const gt = useGT();
  return (kind) => {
    switch (kind) {
      case "image":
        return gt("This image repository");
      case "function":
        return gt("This function");
      case "host":
        return gt("This host");
      case "repository":
        return gt("This source repository");
      default:
        return gt("This package");
    }
  };
}

function SeverityBadge({ severity, muted }: { severity: VulnerabilitySeverity; muted?: boolean }) {
  const label = useSeverityLabel();
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
        muted ? "border border-border text-on-surface-tertiary" : SEVERITY_BADGE_CLASSES[severity]
      }`}
    >
      {label(severity)}
    </span>
  );
}

function KevBadge({ finding }: { finding: VulnerabilityFindingRow }) {
  const gt = useGT();
  if (!finding.kev) return null;
  const title = finding.kev.knownRansomware
    ? gt(
        "In the CISA Known Exploited Vulnerabilities catalog since {date}, with known ransomware campaign use.",
        { date: finding.kev.dateAdded },
      )
    : gt("In the CISA Known Exploited Vulnerabilities catalog since {date}.", {
        date: finding.kev.dateAdded,
      });
  return (
    <span
      title={title}
      className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-danger"
    >
      KEV
      {finding.kev.knownRansomware && (
        <span className="normal-case font-medium">{gt("ransomware")}</span>
      )}
    </span>
  );
}

/** The severity buckets: total and how many of them are running. Click to filter. */
function SeverityCards({
  data,
  selected,
  onToggle,
}: {
  data: VulnerabilityListResponse;
  selected: readonly VulnerabilitySeverity[];
  onToggle: (severity: VulnerabilitySeverity) => void;
}) {
  const gt = useGT();
  const label = useSeverityLabel();
  return (
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
      {VULNERABILITY_SEVERITY_ORDER.map((severity) => {
        const active = selected.includes(severity);
        return (
          <button
            key={severity}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(severity)}
            className={`rounded-xl border px-3 py-2 text-left transition-colors ${
              active ? "border-on-surface-tertiary bg-surface-raised" : "border-border"
            } hover:bg-surface-raised`}
          >
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_BADGE_CLASSES[severity]}`}
            >
              {label(severity)}
            </span>
            <span className="mt-1 block text-lg font-semibold tabular-nums text-on-surface">
              {data.counts[severity]}
            </span>
            <span className="block text-xs text-on-surface-tertiary">
              {gt("{count} running", { count: data.runningCounts[severity] })}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PackageCell({ finding }: { finding: VulnerabilityFindingRow }) {
  const gt = useGT();
  let fix: string;
  if (finding.fixedVersion) fix = finding.fixedVersion;
  else if (finding.fixAvailable === true) fix = gt("Fix available");
  else if (finding.fixAvailable === false) fix = gt("No fix");
  else fix = gt("Unknown");
  return (
    <>
      <span className="block font-mono text-xs text-on-surface">
        {finding.packageName ?? gt("Unknown package")}
      </span>
      <span className="block text-xs text-on-surface-tertiary">
        {finding.installedVersion ?? gt("Unknown")}
        {" → "}
        <span className={finding.fixedVersion ? "text-success" : "text-on-surface-faint"}>
          {fix}
        </span>
      </span>
    </>
  );
}

function ArtifactCell({ finding }: { finding: VulnerabilityFindingRow }) {
  const gtData = useDataString();
  const digest = shortDigest(finding.artifact.digest);
  const href = safeUrl(finding.artifact.url);
  return (
    <>
      <span
        className="block max-w-72 truncate font-mono text-xs text-on-surface"
        title={finding.artifact.name}
      >
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
            {finding.artifact.name}
          </a>
        ) : (
          finding.artifact.name
        )}
      </span>
      {(digest || finding.artifact.tags.length > 0) && (
        <span className="block font-mono text-[11px] text-on-surface-faint">
          {[...finding.artifact.tags.slice(0, 3), ...(digest ? [digest] : [])].join(" · ")}
        </span>
      )}
      <span className="block text-xs text-on-surface-tertiary">
        {gtData(finding.scanner)}
        <span className="text-on-surface-faint"> · {finding.accountName}</span>
      </span>
    </>
  );
}

function RunningList({
  running,
  onOpenResource,
}: {
  running: readonly VulnerabilityRunningRef[];
  onOpenResource?: ((resource: VulnerabilityRunningRef) => void) | undefined;
}) {
  const gtData = useDataString();
  const matchLabels = useMatchLabels();
  return (
    <ul className="flex flex-col gap-1">
      {running.map((r) => (
        <li key={r.resourceId} className="flex flex-wrap items-baseline gap-x-2 text-xs">
          {onOpenResource ? (
            <button
              type="button"
              onClick={() => onOpenResource(r)}
              className="cursor-pointer font-medium text-on-surface hover:underline"
            >
              {r.displayName}
            </button>
          ) : (
            <span className="font-medium text-on-surface">{r.displayName}</span>
          )}
          <span className="rounded-full border border-border px-1.5 text-[11px] text-on-surface-tertiary">
            {gtData(r.resourceTypeName)}
          </span>
          <span className="text-on-surface-faint">{r.accountName}</span>
          <span
            title={matchLabels[r.matchedBy].hint}
            className={r.matchedBy === "tag" ? "text-warning" : "text-on-surface-tertiary"}
          >
            {matchLabels[r.matchedBy].label}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface FindingRowProps {
  finding: VulnerabilityFindingRow;
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpenResource?: ((resource: VulnerabilityRunningRef) => void) | undefined;
  /** Present: the row offers Dismiss. Opens or closes the dismiss box. */
  onToggleDismiss?: (() => void) | undefined;
  dismissing: boolean;
  pending: boolean;
  reason: string;
  onReasonChange: (reason: string) => void;
  everywhere: boolean;
  onEverywhereChange: (everywhere: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  columns: number;
}

function FindingRow({
  finding,
  expanded,
  onToggleExpanded,
  onOpenResource,
  onToggleDismiss,
  dismissing,
  pending,
  reason,
  onReasonChange,
  everywhere,
  onEverywhereChange,
  onConfirm,
  onCancel,
  columns,
}: FindingRowProps) {
  const gt = useGT();
  const runningSummary = useRunningSummary();
  const scopeLabel = useDismissScopeLabel();
  const href = safeUrl(finding.url);
  const scopeName = `scope-${finding.key}`;
  return (
    <>
      <tr className="border-b border-border hover:bg-surface-raised">
        <td className="px-4 py-2.5 align-top whitespace-nowrap">
          <span className="font-mono text-xs font-medium text-on-surface">
            {href ? (
              <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
                {finding.advisoryId}
              </a>
            ) : (
              finding.advisoryId
            )}
          </span>
          <KevBadge finding={finding} />
          {finding.title && (
            <span
              className="block max-w-72 truncate text-xs text-on-surface-tertiary"
              title={finding.title}
            >
              {finding.title}
            </span>
          )}
        </td>
        <td className="px-3 py-2.5 align-top whitespace-nowrap">
          <SeverityBadge severity={finding.severity} />
        </td>
        <td className="px-3 py-2.5 align-top whitespace-nowrap text-xs tabular-nums text-on-surface-secondary">
          <span title={finding.cvssVector ?? undefined}>
            {finding.cvssScore !== null ? finding.cvssScore.toFixed(1) : "–"}
          </span>
        </td>
        <td className="px-3 py-2.5 align-top">
          <PackageCell finding={finding} />
        </td>
        <td className="px-3 py-2.5 align-top">
          <ArtifactCell finding={finding} />
        </td>
        <td className="px-3 py-2.5 align-top text-xs">
          {finding.running.length > 0 ? (
            <button
              type="button"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              className="inline-flex items-start gap-1 text-left font-medium text-on-surface hover:underline"
            >
              <ChevronIcon direction={expanded ? "down" : "right"} size={10} />
              {runningSummary(finding.running)}
            </button>
          ) : (
            <span className="text-on-surface-faint">
              {finding.artifact.kind === "repository" || finding.artifact.kind === "package"
                ? gt("Not a deployment")
                : gt("Not running")}
            </span>
          )}
        </td>
        {onToggleDismiss && (
          <td className="px-3 py-2.5 align-top whitespace-nowrap text-right">
            <button
              type="button"
              disabled={pending}
              onClick={onToggleDismiss}
              className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
            >
              {gt("Dismiss")}
            </button>
          </td>
        )}
      </tr>
      {expanded && finding.running.length > 0 && (
        <tr className="border-b border-border bg-surface-raised/50">
          <td colSpan={columns} className="px-4 py-2.5">
            <RunningList running={finding.running} onOpenResource={onOpenResource} />
          </td>
        </tr>
      )}
      {dismissing && (
        <tr className="border-b border-border bg-surface-raised/50">
          <td colSpan={columns} className="px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <fieldset className="flex items-center gap-3">
                <legend className="sr-only">{gt("Dismiss for")}</legend>
                <label className="flex items-center gap-1 text-on-surface-secondary">
                  <input
                    type="radio"
                    name={scopeName}
                    checked={!everywhere}
                    onChange={() => onEverywhereChange(false)}
                  />
                  {scopeLabel(finding.artifact.kind)}
                </label>
                <label className="flex items-center gap-1 text-on-surface-secondary">
                  <input
                    type="radio"
                    name={scopeName}
                    checked={everywhere}
                    onChange={() => onEverywhereChange(true)}
                  />
                  {gt("Everywhere")}
                </label>
              </fieldset>
              <input
                type="text"
                autoFocus
                value={reason}
                onChange={(e) => onReasonChange(e.target.value)}
                maxLength={500}
                placeholder={gt("Why is this acceptable? (optional)")}
                aria-label={gt("Reason for dismissing {advisory}", {
                  advisory: finding.advisoryId,
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
            </div>
            <p className="mt-1 text-[11px] text-on-surface-faint">
              {everywhere
                ? gt(
                    "Hides {advisory} on every artifact in the organization, including ones scanned later.",
                    { advisory: finding.advisoryId },
                  )
                : gt(
                    "Hides {advisory} on this artifact; a rebuild of the same repository stays dismissed.",
                    { advisory: finding.advisoryId },
                  )}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

function DismissedRow({
  finding,
  pending,
  onRestore,
}: {
  finding: DismissedVulnerabilityFinding;
  pending: boolean;
  onRestore?: (() => void) | undefined;
}) {
  const gt = useGT();
  const everywhere = finding.dismissal.artifactKey === "*";
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-surface-raised">
      <td className="px-4 py-2.5 align-top whitespace-nowrap font-mono text-xs text-on-surface-secondary">
        {finding.advisoryId}
      </td>
      <td className="px-3 py-2.5 align-top whitespace-nowrap">
        <SeverityBadge severity={finding.severity} muted />
      </td>
      <td className="px-3 py-2.5 w-full align-top text-on-surface-tertiary">
        <span className="block font-mono text-xs">
          {everywhere ? gt("Everywhere") : finding.artifact.name}
        </span>
        <span className="block text-xs text-on-surface-faint">
          {gt("Dismissed {date}", { date: formatDate(finding.dismissal.dismissedAt) ?? "" })}
          {finding.dismissal.dismissedBy
            ? gt(" by {who}", { who: finding.dismissal.dismissedBy })
            : ""}
          {finding.dismissal.reason ? `: ${finding.dismissal.reason}` : ""}
        </span>
      </td>
      {onRestore && (
        <td className="px-3 py-2.5 align-top whitespace-nowrap text-right">
          <button
            type="button"
            disabled={pending}
            onClick={onRestore}
            className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
          >
            {pending ? gt("Restoring…") : gt("Restore")}
          </button>
        </td>
      )}
    </tr>
  );
}

function SourcesPanel({ sources }: { sources: readonly VulnerabilitySource[] }) {
  const gt = useGT();
  const gtData = useDataString();
  if (sources.length === 0) {
    return (
      <div className="rounded-xl border border-border p-4 text-sm text-on-surface-secondary">
        <p className="font-medium text-on-surface">
          {gt("No connected account reports vulnerabilities")}
        </p>
        <p className="mt-1 text-xs text-on-surface-tertiary">
          {gt(
            "Findings come from each provider's own scanner: Amazon Inspector, Artifact Analysis, Defender for Cloud, Dependabot, GitLab and JFrog Xray. Connect an account with one of them to see its findings here. A provider with no scanner shows nothing here, rather than zero findings.",
          )}
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
      {sources.map((source) => {
        const help = safeUrl(source.helpUrl);
        const consoleUrl = safeUrl(source.consoleUrl);
        const collected = formatDate(source.lastCollectedAt, true);
        return (
          <li key={source.accountId} className="px-4 py-2.5 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <span className="font-medium text-on-surface">{gtData(source.scanner)}</span>
                <span className="text-on-surface-tertiary">
                  {" "}
                  · {gtData(source.pluginName)} · {source.accountName}
                </span>
              </span>
              <span className="text-on-surface-faint">
                {collected
                  ? gt("{count} findings, collected {time}", {
                      count: source.findingCount,
                      time: collected,
                    })
                  : gt("Not collected yet")}
                {consoleUrl && (
                  <>
                    {" · "}
                    <a href={consoleUrl} target="_blank" rel="noreferrer" className="underline">
                      {gt("Open console")}
                    </a>
                  </>
                )}
              </span>
            </div>
            {source.error && (
              <p role="alert" className="mt-1 text-danger">
                {source.error}
                {help && (
                  <>
                    {" "}
                    <a href={help} target="_blank" rel="noreferrer" className="underline">
                      {source.helpLabel ?? gt("How to fix this")}
                    </a>
                  </>
                )}
              </p>
            )}
            {source.partial && (
              <p className="mt-1 text-on-surface-faint">
                {gt(
                  "This scanner reports a bounded subset, so an artifact missing here is not proof that it is clean.",
                )}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SettingsCard({
  settings,
  onUpdate,
}: {
  settings: VulnerabilitySettings;
  onUpdate?: ((patch: VulnerabilitySettingsPatch) => Promise<void>) | undefined;
}) {
  const gt = useGT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = !onUpdate;

  async function save(patch: VulnerabilitySettingsPatch) {
    if (!onUpdate) return;
    setSaving(true);
    setError(null);
    try {
      await onUpdate(patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <h2 className="text-sm font-medium text-on-surface">{gt("Alerts")}</h2>
      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={settings.alertsEnabled}
          disabled={readOnly || saving}
          onChange={(e) => void save({ alertsEnabled: e.target.checked })}
        />
        <span>{gt("Send vulnerability alerts")}</span>
      </label>
      <div>
        <label
          htmlFor="vulnerability-min-severity"
          className="mb-1 block text-xs text-on-surface-tertiary"
        >
          {gt("Minimum severity")}
        </label>
        <select
          id="vulnerability-min-severity"
          value={settings.minSeverity}
          disabled={readOnly || saving || !settings.alertsEnabled}
          onChange={(e) =>
            void save({ minSeverity: e.target.value === "high" ? "high" : "critical" })
          }
          className="rounded-lg border border-border bg-surface-raised px-2 py-1 text-sm text-on-surface"
        >
          <option value="critical">{gt("Critical only")}</option>
          <option value="high">{gt("Critical and high")}</option>
        </select>
        <p className="mt-1 text-xs text-on-surface-faint">
          {gt("Findings in the CISA Known Exploited Vulnerabilities catalog always alert.")}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={settings.runningOnly}
          disabled={readOnly || saving || !settings.alertsEnabled}
          onChange={(e) => void save({ runningOnly: e.target.checked })}
        />
        <span>{gt("Only alert on findings that are running")}</span>
      </label>
      {settings.lastNotifiedAt && (
        <p className="text-xs text-on-surface-tertiary">
          {gt("Last alert sent {date}.", { date: formatDate(settings.lastNotifiedAt, true) ?? "" })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Vulnerabilities: what each provider's own scanner found (Inspector,
 * Artifact Analysis, Defender, Dependabot, GitLab, Xray), joined to the
 * synced resources running the affected image. The join is the point: the
 * list leads with what is running, says where ("Running in 3 Pods"), and
 * says how sure it is (a tag match is unconfirmed). Shared by the web and
 * desktop Vulnerabilities tabs; the CLI prints the same feed as text.
 *
 * Dismissals follow the Posture stance: visible, reversible, and keyed on
 * the advisory plus the artifact's repository so a rebuild stays dismissed.
 */
export function VulnerabilitiesSection({
  data,
  error,
  onRetry,
  onOpenResource,
  onDismiss,
  onRestore,
  settings,
  onUpdateSettings,
  onOpenPosture,
}: VulnerabilitiesSectionProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [severities, setSeverities] = useState<VulnerabilitySeverity[]>([]);
  const [running, setRunning] = useState<RunningFilter>("all");
  const [fixOnly, setFixOnly] = useState(false);
  const [kevOnly, setKevOnly] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Key of the finding whose dismiss box is open. */
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [everywhere, setEverywhere] = useState(false);
  /** Keys with a dismiss/restore call in flight. */
  const [pending, setPending] = useState<readonly string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  const kevKnown = data?.kevUpdatedAt != null;

  const accounts = useMemo(() => {
    const out = new Map<string, string>();
    for (const s of data?.sources ?? [])
      out.set(s.accountId, `${gtData(s.pluginName)} · ${s.accountName}`);
    for (const f of data?.findings ?? [])
      if (!out.has(f.accountId)) out.set(f.accountId, `${gtData(f.pluginName)} · ${f.accountName}`);
    return [...out.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data, gtData]);

  const filtered = useMemo(
    () =>
      data
        ? filterVulnerabilityFindings(data.findings, {
            severities,
            running: running === "all" ? undefined : running === "running",
            fixAvailable: fixOnly || undefined,
            kev: (kevKnown && kevOnly) || undefined,
            accountId: accountId || undefined,
            search,
          })
        : [],
    [data, severities, running, fixOnly, kevOnly, kevKnown, accountId, search],
  );

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    setPending((keys) => [...keys, key]);
    setActionError(null);
    try {
      await action();
      setDismissing(null);
      setReason("");
      setEverywhere(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending((keys) => keys.filter((k) => k !== key));
    }
  }

  const dismissed = data?.dismissed ?? [];
  const columns = onDismiss ? 7 : 6;
  const filtersActive =
    severities.length > 0 ||
    running !== "all" ||
    fixOnly ||
    kevOnly ||
    accountId !== "" ||
    search !== "";

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">{gt("Vulnerabilities")}</h1>
        {onOpenPosture && (
          <button
            type="button"
            onClick={onOpenPosture}
            className="text-xs text-on-surface-tertiary underline hover:text-on-surface-secondary"
          >
            {gt("Configuration checks are in Posture")}
          </button>
        )}
      </div>
      <p className="mb-6 text-sm text-on-surface-muted">
        {gt(
          "What your providers' own scanners found, joined to the resources running the affected image. Nothing here scans; it reads the last collection.",
        )}
      </p>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load the vulnerabilities: {error}", { error })}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              {gt("Retry")}
            </button>
          )}
        </div>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading vulnerabilities…")}
        </p>
      )}
      {error != null && data !== null && (
        <p role="alert" className="mb-4 text-xs text-danger">
          {gt("Couldn't refresh; showing the last loaded findings. {error}", { error })}
        </p>
      )}

      {data !== null && (
        <>
          <SeverityCards
            data={data}
            selected={severities}
            onToggle={(severity) => {
              setLimit(PAGE_SIZE);
              setSeverities((current) =>
                current.includes(severity)
                  ? current.filter((s) => s !== severity)
                  : [...current, severity],
              );
            }}
          />

          {actionError != null && (
            <p role="alert" className="mb-4 text-xs text-danger">
              {actionError}
            </p>
          )}

          {data.findings.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
              <div
                role="group"
                aria-label={gt("Filter by running state")}
                className="flex overflow-hidden rounded-lg border border-border"
              >
                {(
                  [
                    ["all", gt("All")],
                    ["running", gt("Running")],
                    ["not-running", gt("Not running")],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={running === key}
                    onClick={() => {
                      setLimit(PAGE_SIZE);
                      setRunning(key);
                    }}
                    className={`px-2.5 py-1 transition-colors ${
                      running === key
                        ? "bg-surface-overlay text-on-surface"
                        : "text-on-surface-tertiary hover:text-on-surface-secondary"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-on-surface-secondary">
                <input
                  type="checkbox"
                  checked={fixOnly}
                  onChange={(e) => setFixOnly(e.target.checked)}
                />
                {gt("Fix available")}
              </label>
              {kevKnown && (
                <label className="flex items-center gap-1.5 text-on-surface-secondary">
                  <input
                    type="checkbox"
                    checked={kevOnly}
                    onChange={(e) => setKevOnly(e.target.checked)}
                  />
                  {gt("Known exploited (KEV)")}
                </label>
              )}
              {accounts.length > 1 && (
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  aria-label={gt("Filter by account")}
                  className="rounded-lg border border-border bg-surface-raised px-2 py-1 text-xs text-on-surface"
                >
                  <option value="">{gt("All accounts")}</option>
                  {accounts.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setLimit(PAGE_SIZE);
                  setSearch(e.target.value);
                }}
                placeholder={gt("Search advisory, package or image")}
                aria-label={gt("Search vulnerabilities")}
                className="min-w-48 flex-1 rounded-lg border border-border bg-surface-raised px-2 py-1 text-xs text-on-surface"
              />
              <span className="text-on-surface-faint">
                {gt("{shown} of {total}", { shown: filtered.length, total: data.totalCount })}
              </span>
            </div>
          )}

          {data.findings.length === 0 ? (
            data.sources.length > 0 && (
              <p className="mb-6 text-sm text-on-surface-faint">
                {data.dismissedCount > 0
                  ? gt(
                      "No open findings. Everything reported was dismissed as an accepted risk; see the list below.",
                    )
                  : gt("No open findings from the connected scanners.")}
              </p>
            )
          ) : filtered.length === 0 ? (
            <p className="mb-6 text-sm text-on-surface-faint">
              {filtersActive ? gt("No findings match these filters.") : gt("No open findings.")}
            </p>
          ) : (
            <div className="mb-6 overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-on-surface-faint">
                    <th className="px-4 py-2 font-medium">{gt("Advisory")}</th>
                    <th className="px-3 py-2 font-medium">{gt("Severity")}</th>
                    <th className="px-3 py-2 font-medium">CVSS</th>
                    <th className="px-3 py-2 font-medium">{gt("Package")}</th>
                    <th className="px-3 py-2 font-medium">{gt("Artifact")}</th>
                    <th className="px-3 py-2 font-medium">{gt("Running")}</th>
                    {onDismiss && (
                      <th className="px-3 py-2">
                        <span className="sr-only">{gt("Actions")}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, limit).map((finding) => (
                    <FindingRow
                      key={finding.key}
                      finding={finding}
                      columns={columns}
                      expanded={expanded === finding.key}
                      onToggleExpanded={() =>
                        setExpanded(expanded === finding.key ? null : finding.key)
                      }
                      onOpenResource={onOpenResource}
                      pending={pending.includes(finding.key)}
                      dismissing={dismissing === finding.key && onDismiss !== undefined}
                      reason={reason}
                      onReasonChange={setReason}
                      everywhere={everywhere}
                      onEverywhereChange={setEverywhere}
                      onToggleDismiss={
                        onDismiss
                          ? () => {
                              setActionError(null);
                              setReason("");
                              setEverywhere(false);
                              setDismissing(dismissing === finding.key ? null : finding.key);
                            }
                          : undefined
                      }
                      onConfirm={() => {
                        if (!onDismiss) return;
                        void run(finding.key, () =>
                          onDismiss({
                            advisoryId: finding.advisoryId,
                            artifactKey: everywhere ? "*" : finding.artifact.key,
                            reason,
                          }),
                        );
                      }}
                      onCancel={() => {
                        setDismissing(null);
                        setReason("");
                        setEverywhere(false);
                      }}
                    />
                  ))}
                </tbody>
              </table>
              {filtered.length > limit && (
                <div className="border-t border-border px-4 py-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setLimit((l) => l + PAGE_SIZE)}
                    className="text-on-surface-tertiary underline hover:text-on-surface-secondary"
                  >
                    {gt("Show {count} more", {
                      count: Math.min(PAGE_SIZE, filtered.length - limit),
                    })}
                  </button>
                </div>
              )}
            </div>
          )}

          {dismissed.length > 0 && (
            <div className="mb-8">
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
                  "Accepted risks. Still collected, but hidden from the list above and from vulnerability alerts until restored.",
                )}
              </p>
              {showDismissed && (
                <div className="mt-3 overflow-hidden rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <tbody>
                      {dismissed.map((finding) => {
                        const target = {
                          advisoryId: finding.dismissal.advisoryId,
                          artifactKey: finding.dismissal.artifactKey,
                        };
                        return (
                          <DismissedRow
                            key={finding.key}
                            finding={finding}
                            pending={pending.includes(finding.key)}
                            onRestore={
                              onRestore
                                ? () => void run(finding.key, () => onRestore(target))
                                : undefined
                            }
                          />
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <div>
              <h2 className="mb-2 text-sm font-medium text-on-surface">{gt("Sources")}</h2>
              <SourcesPanel sources={data.sources} />
              <p className="mt-2 text-xs text-on-surface-faint">
                {data.kevUpdatedAt
                  ? gt(
                      "Read from the last collection; nothing here contacts a provider. CISA KEV catalog updated {date}.",
                      { date: formatDate(data.kevUpdatedAt) ?? "" },
                    )
                  : gt("Read from the last collection; nothing here contacts a provider.")}
              </p>
            </div>
            {settings && <SettingsCard settings={settings} onUpdate={onUpdateSettings} />}
          </div>
        </>
      )}
    </div>
  );
}
