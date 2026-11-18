import { useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  formatQuotaUtilization,
  type ResourceRunwayResponse,
  type ResourceRunwayRow,
} from "@infrawrench/client-core";
import { RunwayChart } from "./RunwayChart.js";
import { useRunwayDuration } from "./duration.js";

export interface ResourceRunwayPanelProps {
  /** Fetch this resource's runway rows (web: `/quotas/runway/resource`, desktop: the cloud client). */
  load: () => Promise<ResourceRunwayResponse>;
}

function Caption({ row }: { row: ResourceRunwayRow }) {
  const gt = useGT();
  const duration = useRunwayDuration();
  if (row.status === "full") {
    return <p className="text-xs text-danger mt-1">{gt("At the limit.")}</p>;
  }
  if (row.forecast.confidence === "short") {
    return (
      <p className="text-xs text-on-surface-faint mt-1">
        {gt("Not enough history for a trend yet.")}
      </p>
    );
  }
  const noisy = row.forecast.confidence === "noisy";
  if (row.kind === "allowance" && row.cycle) {
    const values = {
      percent: formatQuotaUtilization(row.cycle.projectedUtilization ?? 0),
      date: new Date(row.cycle.end).toLocaleDateString(),
    };
    return (
      <p className="text-xs text-on-surface-tertiary mt-1">
        {noisy
          ? gt("Projected {percent} of the allowance by {date}, on a noisy trend.", values)
          : gt("Projected {percent} of the allowance by {date}.", values)}
      </p>
    );
  }
  if (row.forecast.daysLeft !== null) {
    const values = { duration: duration(row.forecast.daysLeft) };
    return (
      <p className="text-xs text-on-surface-tertiary mt-1">
        {noisy
          ? gt("Runway: {duration} at the current rate, on a noisy trend.", values)
          : gt("Runway: {duration} at the current rate.", values)}
      </p>
    );
  }
  return <p className="text-xs text-on-surface-faint mt-1">{gt("Not heading for the limit.")}</p>;
}

/**
 * The runway charts on a resource's Metrics tab: one per declared usage, each
 * with its recorded history, the limit, and the projection. Renders nothing
 * until it has rows, so a type with no reading yet adds no empty box.
 */
export function ResourceRunwayPanel({ load }: ResourceRunwayPanelProps) {
  const gt = useGT();
  const [data, setData] = useState<ResourceRunwayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((response) => {
        if (!cancelled) {
          setData(response);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : gt("Request failed"));
      });
    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure per render on both hosts; the resource it
    // closes over is what matters, and the host remounts the tab per resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <T>
        <p role="alert" className="text-xs text-danger">
          Couldn&apos;t load the capacity runway: <Var>{error}</Var>
        </p>
      </T>
    );
  }
  if (!data || data.rows.length === 0) return null;

  return (
    <section aria-label={gt("Capacity runway")} className="space-y-6">
      {data.rows.map((row) => (
        <div key={row.key}>
          <RunwayChart row={row} />
          <Caption row={row} />
        </div>
      ))}
    </section>
  );
}
