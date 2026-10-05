import { useState } from "react";
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
} from "@infrawrench/client-core";

type Gt = ReturnType<typeof useGT>;

/**
 * The drill half of the screen, supplied by the host. Undefined means the host
 * does not offer drills at all, which hides the tab, rather than showing an
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

/**
 * The Drills tab, where each protected resource stands on restore, and the
 * form for recording that somebody tried.
 *
 * Kept as its own component rather than inlined because it owns a form with
 * its own validation, and the section above it is already long enough that a
 * fifth piece of local state in the same scope would be hard to follow.
 */
export function DrillsPanel({
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
          Record each restore drill (what you restored, how long it took, whether you verified it).
          This page flags drills that have gone stale.
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
            Nothing to drill yet. Resources appear here once something backs them up.
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
                {new Date(drill.performedAt).toLocaleDateString()}:{" "}
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
