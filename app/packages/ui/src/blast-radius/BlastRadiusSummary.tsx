import {
  blastRadiusReferenceLabel,
  formatFlowBytes,
  type BlastRadiusReport,
  type BlastRadiusSeverity,
} from "@infrawrench/client-core";
import { useBlastRadius } from "./useBlastRadius.js";
import type { BlastRadiusClient } from "./types.js";

interface BlastRadiusSummaryProps {
  client: BlastRadiusClient | undefined;
  resourceId: string;
  /** How many dependants to name before collapsing to a count. */
  maxNamed?: number;
}

/** Tone per severity. `unknown` is deliberately neutral, not green. */
const SEVERITY_CLASS: Record<BlastRadiusSeverity, string> = {
  none: "border-border bg-surface-overlay text-on-surface-tertiary",
  low: "border-border-strong bg-surface-overlay text-on-surface-secondary",
  medium: "border-amber-500/40 bg-amber-500/10 text-warning",
  high: "border-red-500/50 bg-red-500/10 text-danger",
  unknown: "border-border-strong bg-surface-overlay text-on-surface-secondary",
};

/**
 * The impact report, compressed to fit above a type-to-confirm box.
 *
 * Three rules this component exists to hold:
 *
 *  - **It never gates the dialog.** It renders a quiet "Checking…" line while
 *    loading and the dialog is fully usable underneath — including the
 *    confirm button.
 *  - **A failed check degrades to a visible "couldn't check", never to
 *    silence.** An absent warning reads as "nothing to warn about", which is
 *    the one thing a failed fetch does not mean.
 *  - **Gaps are shown even on a clean report.** "Nothing depends on this" and
 *    "nothing depends on this, but flows are off" are different claims.
 */
export function BlastRadiusSummary({ client, resourceId, maxNamed = 3 }: BlastRadiusSummaryProps) {
  const { report, loading, error } = useBlastRadius(client, resourceId);

  if (!client) return null;

  if (loading) {
    return (
      <p className="mb-4 text-xs text-on-surface-faint" aria-live="polite">
        Checking what depends on this…
      </p>
    );
  }

  if (error || !report) {
    return (
      <div
        className="mb-4 rounded-lg border border-border-strong bg-surface-overlay px-3 py-2"
        aria-live="polite"
      >
        <p className="text-xs text-on-surface-secondary">
          Couldn&apos;t check what depends on this resource.
        </p>
        <p className="mt-0.5 text-xs text-on-surface-faint">
          {error ?? "The impact report is unavailable."} Deleting is still allowed — decide from
          what you know.
        </p>
      </div>
    );
  }

  return (
    <div
      className={`mb-4 rounded-lg border px-3 py-2 ${SEVERITY_CLASS[report.severity]}`}
      aria-live="polite"
    >
      <p className="text-xs font-medium">{report.headline}</p>
      <SummaryLines report={report} maxNamed={maxNamed} />
      {report.unchecked.length > 0 && (
        <p className="mt-1.5 text-xs text-on-surface-faint">
          Not checked: {report.unchecked.map((gap) => gap.reason).join(" ")}
        </p>
      )}
    </div>
  );
}

function SummaryLines({ report, maxNamed }: { report: BlastRadiusReport; maxNamed: number }) {
  const named = report.dependants.slice(0, maxNamed);
  const rest = report.dependants.length - named.length;

  const referenceCounts = new Map<string, number>();
  for (const ref of report.references) {
    referenceCounts.set(ref.kind, (referenceCounts.get(ref.kind) ?? 0) + 1);
  }

  const userFacing = report.references.filter((r) => r.userFacing);

  return (
    <>
      {named.length > 0 && (
        <p className="mt-1 text-xs text-on-surface-secondary">
          {named.map((d) => d.node.displayName).join(", ")}
          {rest > 0 ? ` and ${rest} more` : ""}
        </p>
      )}
      {userFacing.length > 0 && (
        <p className="mt-1 text-xs font-medium">
          Customer-visible: {userFacing.map((r) => r.name).join(", ")}
        </p>
      )}
      {referenceCounts.size > 0 && (
        <p className="mt-1 text-xs text-on-surface-secondary">
          Also referenced by{" "}
          {[...referenceCounts.entries()]
            .map(([kind, count]) => {
              const label = blastRadiusReferenceLabel(kind as never).toLowerCase();
              return `${count} ${label}${count === 1 ? "" : "s"}`;
            })
            .join(", ")}
          .
        </p>
      )}
      {report.flowTotals && report.flowTotals.bytes > 0 && (
        <p className="mt-1 text-xs text-on-surface-secondary">
          {formatFlowBytes(report.flowTotals.bytes)} of measured traffic with{" "}
          {report.flowPeers.length} peer{report.flowPeers.length === 1 ? "" : "s"} in the last 14
          days.
        </p>
      )}
    </>
  );
}
