import { useMemo } from "react";
import { T, useGT } from "gt-react";
import {
  biggestDrag,
  trendDelta,
  type ScorecardGrade,
  type ScorecardPillar,
  type ScorecardPillarId,
  type ScorecardResponse,
} from "@infrawrench/client-core";

export interface ScorecardSectionProps {
  /**
   * The computed scorecard, or null while the first load is in flight. Hosts
   * fetch (web: `/scorecard`, desktop: cloud IPC) and hand the response over —
   * this component never talks to a network.
   */
  data: ScorecardResponse | null;
  /**
   * Load or refresh failure. With `data` still present the last scorecard
   * stays on screen under a banner — a failed refresh must not blank a drawn
   * grade.
   */
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /**
   * Per-pillar navigation into the page each one summarises. Keyed rather than
   * a single callback because the mapping is not total: five pillars have an
   * org-level page and **ownership does not** — it is recorded per resource —
   * so a single handler would have to render a button that goes nowhere. A
   * pillar with no entry renders as plain text.
   */
  pillarLinks?: Partial<Record<ScorecardPillarId, () => void>> | undefined;
}

type Gt = ReturnType<typeof useGT>;

function pillarLabel(gt: Gt, id: ScorecardPillarId): string {
  switch (id) {
    case "security":
      return gt("Security posture");
    case "recoverability":
      return gt("Recoverability");
    case "deadlines":
      return gt("Deadlines");
    case "headroom":
      return gt("Headroom");
    case "access":
      return gt("Access hygiene");
    case "ownership":
      return gt("Ownership");
  }
}

function pillarBlurb(gt: Gt, id: ScorecardPillarId): string {
  switch (id) {
    case "security":
      return gt("Open posture findings, weighted by severity, across your synced resources.");
    case "recoverability":
      return gt("The share of stateful resources something actually protects.");
    case "deadlines":
      return gt("Certificates, domains, keys and leases that have run out or are about to.");
    case "headroom":
      return gt("The worst provider quota — what will stop a deploy first.");
    case "access":
      return gt("Findings against the IAM users, roles and service accounts inside your clouds.");
    case "ownership":
      return gt("The share of resources with somebody's name on them.");
  }
}

/** Grade colours. Deliberately not a red-to-green ramp per point — bands read faster. */
const GRADE_CLASSES: Record<ScorecardGrade, string> = {
  A: "text-success",
  B: "text-success",
  C: "text-warning",
  D: "text-severe",
  F: "text-danger",
};

function barClass(score: number): string {
  if (score >= 80) return "bg-emerald-500/70";
  if (score >= 65) return "bg-amber-500/70";
  if (score >= 50) return "bg-orange-500/70";
  return "bg-red-500/70";
}

/** A 90-day sparkline over the stored readings. */
function TrendLine({ points }: { points: readonly { day: string; score: number }[] }) {
  const gt = useGT();
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const width = 240;
    const height = 40;
    // Always plotted against the full 0–100 range rather than the data's own
    // min and max: an auto-scaled axis turns a two-point wobble into a cliff,
    // which is exactly the misreading a score is most vulnerable to.
    const step = width / (points.length - 1);
    return points
      .map((point, index) => {
        const x = index * step;
        const y = height - (point.score / 100) * height;
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [points]);

  if (!path) {
    return (
      <p className="text-xs text-on-surface-faint">
        {gt("The trend appears once a second daily reading has been recorded.")}
      </p>
    );
  }
  return (
    <svg
      viewBox="0 0 240 40"
      className="h-10 w-full max-w-60 text-accent"
      role="img"
      aria-label={gt("Score over the last {count} readings", { count: points.length })}
      preserveAspectRatio="none"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function PillarCard({
  pillar,
  onOpen,
}: {
  pillar: ScorecardPillar;
  onOpen: (() => void) | undefined;
}) {
  const gt = useGT();
  const label = pillarLabel(gt, pillar.id);
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-baseline justify-between gap-3">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="text-sm font-medium text-on-surface underline-offset-2 hover:underline"
          >
            {label}
          </button>
        ) : (
          <span className="text-sm font-medium text-on-surface">{label}</span>
        )}
        <span className="text-lg font-semibold tabular-nums text-on-surface">
          {pillar.score === null ? (
            <span className="text-sm font-normal text-on-surface-faint">{gt("Not assessed")}</span>
          ) : (
            pillar.score
          )}
        </span>
      </div>

      <p className="mt-0.5 text-xs text-on-surface-tertiary">{pillarBlurb(gt, pillar.id)}</p>

      {pillar.score !== null && (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-overlay"
          role="presentation"
        >
          <div
            className={`h-full ${barClass(pillar.score)}`}
            style={{ width: `${pillar.score}%` }}
          />
        </div>
      )}

      <p className="mt-2 text-xs text-on-surface-secondary">{pillar.headline}</p>

      {pillar.unassessedReason && (
        // Deliberately not styled as an error. An unassessed pillar is a fact
        // about the org's data, not a fault, and colouring it red would teach
        // people the same lesson scoring it zero would.
        <p className="mt-1 text-xs text-on-surface-faint">{pillar.unassessedReason}</p>
      )}

      {pillar.facts.length > 0 && (
        <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {pillar.facts.map((fact) => (
            <div key={fact.label} className="flex items-baseline gap-1">
              <dt className="text-on-surface-faint">{fact.label}</dt>
              <dd
                className={`tabular-nums ${fact.bad ? "text-danger" : "text-on-surface-secondary"}`}
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {pillar.nextStep && (
        <p className="mt-2 text-xs text-on-surface-tertiary">
          <span className="text-on-surface-faint">{gt("Next:")} </span>
          {pillar.nextStep}
        </p>
      )}

      <p className="mt-2 text-xs text-on-surface-faint">
        {gt("Weight {weight}", { weight: pillar.weight })}
      </p>
    </div>
  );
}

/**
 * The infrastructure scorecard — six radars, one number, and the history that
 * makes it mean something.
 *
 * The headline is deliberately not the only thing on the page. A single grade
 * is a conversation starter and a bad decision tool, so the pillars are always
 * visible beneath it, each one linking to the page it summarises, and each one
 * saying what would move it.
 */
export function ScorecardSection({ data, error, onRetry, pillarLinks }: ScorecardSectionProps) {
  const gt = useGT();
  const drag = useMemo(() => (data ? biggestDrag(data.pillars) : null), [data]);
  const delta = useMemo(() => (data ? trendDelta(data.trend, data.score) : null), [data]);

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">{gt("Scorecard")}</h1>
      <T>
        <p className="text-sm text-on-surface-muted mb-6">
          One reading over the six checks you already have — posture, backups, deadlines, quota
          headroom, cloud access and ownership. Nothing here is a new check: every number is the
          same one its own page shows, weighted together so there is something to watch move.
        </p>
      </T>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load the scorecard — {error}", { error })}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              {gt("Retry")}
            </button>
          )}
        </div>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Reading the radars…")}
        </p>
      )}
      {error != null && data !== null && (
        <p role="alert" className="mb-4 text-xs text-danger">
          {gt("Couldn't refresh — showing the last loaded scorecard. {error}", { error })}
        </p>
      )}

      {data !== null && (
        <>
          {data.failedPillars.length > 0 && (
            <p role="alert" className="mb-4 text-xs text-warning">
              {gt(
                "{count} checks could not be read and are excluded from the score, not counted against it.",
                { count: data.failedPillars.length },
              )}
            </p>
          )}

          <div className="mb-6 flex flex-wrap items-center gap-6 rounded-xl border border-border p-5">
            <div>
              <div className="text-xs text-on-surface-faint">{gt("Overall")}</div>
              {data.score === null || data.grade === null ? (
                <>
                  <div className="mt-1 text-2xl font-semibold text-on-surface-faint">—</div>
                  <T>
                    <p className="mt-1 max-w-md text-xs text-on-surface-tertiary">
                      Nothing could be assessed yet. Connect an account and let it sync; a grade
                      before there is anything to grade would only be a guess.
                    </p>
                  </T>
                </>
              ) : (
                <div className="mt-1 flex items-baseline gap-3">
                  <span
                    className={`text-5xl font-semibold tabular-nums ${GRADE_CLASSES[data.grade]}`}
                  >
                    {data.grade}
                  </span>
                  <span className="text-2xl font-semibold tabular-nums text-on-surface">
                    {data.score}
                  </span>
                  {delta !== null && delta !== 0 && (
                    <span
                      className={`text-xs tabular-nums ${delta > 0 ? "text-success" : "text-danger"}`}
                    >
                      {delta > 0 ? `+${delta}` : delta}
                      <span className="text-on-surface-faint">
                        {" "}
                        {gt("since {day}", { day: data.trend[0]?.day ?? "" })}
                      </span>
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="min-w-60 flex-1">
              <div className="text-xs text-on-surface-faint mb-1">{gt("Last 90 days")}</div>
              <TrendLine points={data.trend} />
            </div>

            {drag && (
              <div className="max-w-xs">
                <div className="text-xs text-on-surface-faint">{gt("Biggest drag")}</div>
                <div className="mt-1 text-sm font-medium text-on-surface">
                  {pillarLabel(gt, drag.id)}
                </div>
                {drag.nextStep && (
                  <p className="mt-0.5 text-xs text-on-surface-tertiary">{drag.nextStep}</p>
                )}
              </div>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.pillars.map((pillar) => (
              <PillarCard key={pillar.id} pillar={pillar} onOpen={pillarLinks?.[pillar.id]} />
            ))}
          </div>

          <T>
            <p className="mt-6 max-w-3xl text-xs text-on-surface-faint">
              A check with nothing to measure is left out of the score rather than counted as a
              failure, and the weights are shared out over whatever was measured — so connecting a
              provider that reports quotas for the first time can never look like a drop. The
              weights themselves are fixed: security 30, recoverability 25, deadlines 15, access 15,
              headroom 10, ownership 5.
            </p>
          </T>
        </>
      )}
    </div>
  );
}
