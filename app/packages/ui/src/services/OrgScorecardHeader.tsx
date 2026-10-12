import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  orgScorecardBiggestDrag,
  orgScorecardTrendDelta,
  type OrgScorecardGrade,
  type OrgScorecardPillar,
  type OrgScorecardPillarId,
  type OrgScorecardResponse,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";
import { errorMessage } from "./shared.js";
import type { ServicesClient } from "./types.js";

/**
 * Navigation into the page each pillar summarises. Partial on purpose:
 * ownership is recorded per resource and has no org-level page, so a pillar
 * with no entry renders as plain text rather than a button that goes nowhere.
 */
export type OrgScorecardPillarLinks = Partial<Record<OrgScorecardPillarId, () => void>>;

export interface OrgScorecardHeaderProps {
  client: Pick<ServicesClient, "getOrgScorecard">;
  pillarLinks?: OrgScorecardPillarLinks | undefined;
  /** Bumped by the matrix after a re-evaluation, so the services pillar follows. */
  reloadKey?: number | undefined;
}

type Gt = ReturnType<typeof useGT>;

function pillarLabel(gt: Gt, id: OrgScorecardPillarId): string {
  switch (id) {
    case "posture":
      return gt("Security posture");
    case "recoverability":
      return gt("Recoverability");
    case "services":
      return gt("Service standards");
    case "deadlines":
      return gt("Deadlines");
    case "access":
      return gt("Access hygiene");
    case "headroom":
      return gt("Headroom");
    case "ownership":
      return gt("Ownership");
  }
}

function pillarBlurb(gt: Gt, id: OrgScorecardPillarId): string {
  switch (id) {
    case "posture":
      return gt("Open posture findings, weighted by severity, across your synced resources.");
    case "recoverability":
      return gt("The share of stateful resources something actually protects.");
    case "services":
      return gt("The mean service score across the scorecards below.");
    case "deadlines":
      return gt("Certificates, domains, keys and leases that have run out or are about to.");
    case "access":
      return gt("Findings against the IAM users, roles and service accounts inside your clouds.");
    case "headroom":
      return gt("The worst provider quota: what will stop a deploy first.");
    case "ownership":
      return gt("The share of resources with somebody's name on them.");
  }
}

/** Grade bands rather than a per-point ramp: bands read faster. */
const GRADE_CLASSES: Record<OrgScorecardGrade, string> = {
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

/** The 90-day sparkline, always on the full 0-100 range. */
function TrendLine({ points }: { points: readonly { day: string; score: number }[] }) {
  const gt = useGT();
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const width = 240;
    const height = 40;
    // Never auto-scaled to the data's own min and max: that turns a two-point
    // wobble into a cliff, the misreading a score is most vulnerable to.
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
      aria-label={gt("Grade over the last {count} readings", { count: points.length })}
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
  pillar: OrgScorecardPillar;
  onOpen: (() => void) | undefined;
}) {
  const gt = useGT();
  const dataString = useDataString();
  const label = pillarLabel(gt, pillar.id);
  return (
    <div className="rounded-xl border border-border bg-surface-raised p-3">
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
        <span className="text-base font-semibold tabular-nums text-on-surface">
          {pillar.score === null ? (
            <span className="text-xs font-normal text-on-surface-faint">{gt("Not assessed")}</span>
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
        // Not styled as an error: an unassessed pillar is a fact about the
        // org's data, and colouring it red would teach what scoring it zero
        // would.
        <p className="mt-1 text-xs text-on-surface-faint">{pillar.unassessedReason}</p>
      )}
      {pillar.facts.length > 0 && (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {pillar.facts.map((fact) => (
            <div key={fact.label} className="flex items-baseline gap-1">
              <dt className="text-on-surface-faint">{dataString(fact.label)}</dt>
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
          {gt("Next: {step}", { step: pillar.nextStep })}
        </p>
      )}
      <p className="mt-2 text-xs text-on-surface-faint">
        {gt("Weight {weight}", { weight: pillar.weight })}
      </p>
    </div>
  );
}

/**
 * The org grade above the scorecard matrix: one reading over seven feeds
 * the product already computes, the 90-day trend, the pillar dragging it
 * down hardest, and a card per pillar linking to the page it reads. The
 * grade is never the only thing on screen; the pillars always are.
 */
export function OrgScorecardHeader({ client, pillarLinks, reloadKey }: OrgScorecardHeaderProps) {
  const gt = useGT();
  const headingId = useId();
  const [data, setData] = useState<OrgScorecardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const retry = useCallback(() => setRetryKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    client
      .getOrgScorecard()
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((e: unknown) => {
        // A failed refresh keeps the last grade on screen under the banner.
        if (!cancelled) setError(errorMessage(e, gt("Failed to load the org grade")));
      });
    return () => {
      cancelled = true;
    };
  }, [client, gt, reloadKey, retryKey]);

  const drag = useMemo(() => (data ? orgScorecardBiggestDrag(data.pillars) : null), [data]);
  const delta = useMemo(
    () => (data ? orgScorecardTrendDelta(data.trend, data.score) : null),
    [data],
  );

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-base font-semibold text-on-surface">
        {gt("Org grade")}
      </h2>
      <p className="text-xs text-on-surface-faint mb-3">
        {gt(
          "One reading over checks you already have: posture, backups, the service scorecards below, deadlines, cloud access, quota headroom and ownership. Every number is the one its own page shows.",
        )}
      </p>

      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {data
            ? gt("Couldn't refresh the org grade, showing the last one loaded. {error}", { error })
            : error}{" "}
          <button type="button" onClick={retry} className="underline">
            {gt("Retry")}
          </button>
        </p>
      )}
      {data === null && !error && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Reading the org grade…")}
        </p>
      )}

      {data !== null && (
        <>
          {data.failedPillars.length > 0 && (
            <p role="alert" className="mb-3 text-xs text-warning">
              {gt(
                "{count} checks could not be read and are excluded from the grade, not counted against it.",
                { count: data.failedPillars.length },
              )}
            </p>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-6 rounded-xl border border-border bg-surface-raised p-4">
            <div>
              <div className="text-xs text-on-surface-faint">{gt("Overall")}</div>
              {data.score === null || data.grade === null ? (
                <p className="mt-1 max-w-md text-xs text-on-surface-tertiary">
                  {gt(
                    "Nothing could be assessed yet. Connect an account and let it sync; a grade before there is anything to grade would only be a guess.",
                  )}
                </p>
              ) : (
                <div className="mt-1 flex items-baseline gap-3">
                  <span
                    className={`text-4xl font-semibold tabular-nums ${GRADE_CLASSES[data.grade]}`}
                  >
                    {data.grade}
                  </span>
                  <span className="text-xl font-semibold tabular-nums text-on-surface">
                    {data.score}
                  </span>
                  {delta !== null && delta !== 0 && (
                    <span
                      className={`text-xs tabular-nums ${delta > 0 ? "text-success" : "text-danger"}`}
                    >
                      {delta > 0 ? `+${delta}` : delta}{" "}
                      <span className="text-on-surface-faint">
                        {gt("since {day}", { day: data.trend[0]?.day ?? "" })}
                      </span>
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="min-w-60 flex-1">
              <div className="mb-1 text-xs text-on-surface-faint">{gt("Last 90 days")}</div>
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

          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {data.pillars.map((pillar) => (
              <PillarCard key={pillar.id} pillar={pillar} onOpen={pillarLinks?.[pillar.id]} />
            ))}
          </div>

          <p className="mt-3 text-xs text-on-surface-faint">
            {gt(
              "A check with nothing to measure is left out of the grade rather than counted as a failure, and the weights are shared out over whatever was measured, so connecting a new provider can never look like a drop. The weights are fixed: posture 25, recoverability 20, service standards 15, deadlines 15, access 10, headroom 10, ownership 5.",
            )}
          </p>
        </>
      )}
    </section>
  );
}
