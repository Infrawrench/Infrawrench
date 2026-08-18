import { useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  WALLBOARD_LIMITS,
  formatWallDuration,
  rotationIndex,
  type WallboardResponse,
  type WallboardStatus,
} from "@infrawrench/client-core";

export interface WallboardSectionProps {
  /** The wall, or null while the first load is in flight. */
  data: WallboardResponse | null;
  /**
   * Load or refresh failure. With `data` present the last wall stays on screen
   * — a television that blanks on one failed poll is worse than one showing a
   * reading from a minute ago with a stale marker on it.
   */
  error?: string | null | undefined;
  /** Seconds between refreshes; the host owns the timer. */
  refreshSeconds: number;
  /** Seconds each panel is shown before rotating. */
  rotateSeconds: number;
  /** Leave the wall on one panel. */
  paused?: boolean | undefined;
  onTogglePaused?: (() => void) | undefined;
}

/**
 * The whole-screen tint. Background utilities rather than fixed text colours:
 * text has to come from the semantic tokens (`text-danger`, `text-warning`,
 * `text-success`), which are the only ones guaranteed to clear WCAG AA in both
 * schemes — and a wallboard is the last screen that should be readable in one
 * theme and not the other.
 */
const STATUS_BACKDROP: Record<WallboardStatus, string> = {
  ok: "bg-emerald-500/10",
  degraded: "bg-amber-500/10",
  down: "bg-red-500/15",
};

const STATUS_ACCENT: Record<WallboardStatus, string> = {
  ok: "text-success",
  degraded: "text-warning",
  down: "text-danger",
};

function statusHeadline(gt: ReturnType<typeof useGT>, status: WallboardStatus): string {
  switch (status) {
    case "ok":
      return gt("All clear");
    case "degraded":
      return gt("Needs a look");
    case "down":
      return gt("Something is down");
  }
}

/**
 * The wallboard — one screen, read from across the room.
 *
 * Deliberately not a dashboard in kiosk mode. Type is large, the palette is
 * three colours, and nothing on it is a trend: the rule is that a wallboard may
 * only show things that are true right now and that somebody would cross a room
 * to look at.
 *
 * Rotation is derived from the wall clock rather than a local timer, so two
 * televisions in the same room show the same panel at the same moment — being
 * out of step is the sort of thing people notice and nobody can explain.
 */
export function WallboardSection({
  data,
  error,
  refreshSeconds,
  rotateSeconds,
  paused,
  onTogglePaused,
}: WallboardSectionProps) {
  const gt = useGT();
  // Ticks once a second so the "for 41m" durations stay honest without the
  // host having to refetch to move them.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const panels = useMemo(() => {
    if (!data) return [] as Array<"overview" | "incidents" | "failures">;
    const list: Array<"overview" | "incidents" | "failures"> = ["overview"];
    // A panel with nothing on it is never rotated to. A wall that spends a
    // third of its time showing an empty "Incidents" heading trains a room to
    // stop looking at it.
    if (data.incidents.length > 0) list.push("incidents");
    if (data.failures.length > 0) list.push("failures");
    return list;
  }, [data]);

  const panel = panels[paused ? 0 : rotationIndex(now, panels.length, rotateSeconds)] ?? "overview";
  const status = data?.status ?? "degraded";
  const stale = data ? now - Date.parse(data.generatedAt) > refreshSeconds * 3000 : false;

  return (
    <div
      className={`flex h-full flex-1 flex-col gap-6 overflow-hidden p-8 text-on-surface ${STATUS_BACKDROP[status]}`}
    >
      <header className="flex flex-wrap items-baseline gap-4">
        <h1 className={`text-4xl font-semibold tracking-tight ${STATUS_ACCENT[status]}`}>
          {data ? statusHeadline(gt, status) : gt("Connecting…")}
        </h1>
        <span className="text-lg opacity-70">
          {data ? new Date(data.generatedAt).toLocaleTimeString() : ""}
        </span>
        {/* A stale marker rather than a blank screen: a wall that quietly keeps
            showing a five-minute-old green is the failure this guards. */}
        {stale && <span className="text-lg text-warning">{gt("· not updating")}</span>}
        {error && data === null && <span className="text-lg text-danger">{error}</span>}
        {onTogglePaused && (
          <button
            type="button"
            onClick={onTogglePaused}
            className="ml-auto rounded-lg border border-border px-3 py-1 text-sm opacity-60 hover:opacity-100"
          >
            {paused ? gt("Resume rotation") : gt("Hold this panel")}
          </button>
        )}
      </header>

      {data !== null && data.failedSources.length > 0 && (
        <p className="text-xl text-warning">
          {gt("Could not read: {sources}", { sources: data.failedSources.join(", ") })}
        </p>
      )}

      {data !== null && panel === "overview" && (
        <div className="grid flex-1 grid-cols-2 gap-6 xl:grid-cols-4">
          {data.tiles.map((tile) => (
            <div
              key={tile.id}
              className="flex flex-col justify-center rounded-2xl border border-border p-6"
            >
              <div className="text-xl opacity-70">{tile.label}</div>
              <div
                className={`mt-2 text-7xl font-semibold tabular-nums ${STATUS_ACCENT[tile.status]}`}
              >
                {tile.value}
              </div>
              {tile.detail && <div className="mt-2 text-lg opacity-70">{tile.detail}</div>}
            </div>
          ))}
        </div>
      )}

      {data !== null && panel === "incidents" && (
        <div className="flex flex-1 flex-col gap-4">
          <h2 className="text-2xl opacity-70">{gt("Open incidents")}</h2>
          <ul className="flex flex-col gap-3">
            {data.incidents.map((incident) => (
              <li key={incident.id} className="flex flex-wrap items-baseline gap-4">
                <span className="rounded-lg border border-border px-3 py-1 text-2xl uppercase">
                  {incident.severity}
                </span>
                <span className="text-4xl font-medium">{incident.title}</span>
                <span className="text-2xl opacity-70">
                  {gt("for {duration}", {
                    duration: formatWallDuration(incident.startedAt, now),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data !== null && panel === "failures" && (
        <div className="flex flex-1 flex-col gap-4">
          <h2 className="text-2xl opacity-70">{gt("Not healthy")}</h2>
          <ul className="flex flex-col gap-3">
            {data.failures.map((failure) => (
              <li key={failure.id} className="flex flex-wrap items-baseline gap-4">
                <span className="text-4xl font-medium">{failure.label}</span>
                <span className="text-2xl opacity-70">{failure.detail}</span>
                {failure.since && (
                  <span className="text-2xl opacity-50">
                    {formatWallDuration(failure.since, now)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {panels.length > 1 && (
        <footer className="flex justify-center gap-2" aria-hidden="true">
          {panels.map((name, index) => (
            <span
              key={name}
              className={`h-2 w-8 rounded-full ${
                panels.indexOf(panel) === index ? "bg-current" : "bg-current/25"
              }`}
            />
          ))}
        </footer>
      )}
    </div>
  );
}

/** Bounds re-exported so a host can build its own controls without importing twice. */
export { WALLBOARD_LIMITS };
