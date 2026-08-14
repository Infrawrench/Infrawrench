import { useCallback, useEffect, useRef, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import {
  buildMomentTimeline,
  describeIncidentBadge,
  DEFAULT_MOMENT_WINDOW_MINUTES,
  MOMENT_FEED_LABELS,
  MOMENT_WINDOW_PRESETS,
  type MomentEvent,
  type MomentIncidentSpan,
  type MomentResponse,
  type MomentSeverity,
} from "@infrawrench/client-core";
import type { MomentClient } from "./types.js";

export interface MomentPanelProps {
  /**
   * Org-scoped data access. Hosts mount the panel with `key={orgId}` so an
   * org switch remounts it — that is what clears the previous org's events.
   */
  client: MomentClient;
  /** Deep-linked centre timestamp (ISO). Absent = "around now". */
  initialAt?: string | undefined;
  /** Deep-linked half-window in minutes. */
  initialWindowMinutes?: number | undefined;
  /**
   * Reports the query whenever it changes so hosts can mirror it into the
   * URL — that is what makes a moment shareable. `at` is null for
   * "around now".
   */
  onQueryChange?: ((query: { at: string | null; windowMinutes: number }) => void) | undefined;
  /**
   * Jump to an event's native screen. The host inspects `event.link` and
   * maps its `kind` onto a route. Omitted, rows are plain text.
   */
  onOpenEvent?: ((event: MomentEvent) => void) | undefined;
  /** Open an external URL (provider incident page). */
  onOpenUrl?: ((url: string) => void) | undefined;
}

/** ISO → the value a `datetime-local` input wants (local wall clock). */
function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `datetime-local` value (local wall clock) → ISO, or null when empty/invalid. */
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

const SEVERITY_DOT: Record<MomentSeverity, string> = {
  info: "bg-on-surface-faint",
  warning: "bg-amber-500",
  critical: "bg-red-500",
};

function spansById(ids: string[], incidents: MomentIncidentSpan[]): MomentIncidentSpan[] {
  return incidents.filter((span) => ids.includes(span.id));
}

/**
 * "What changed around 03:14?" — one merged, chronological narrative of
 * everything the platform knows happened in a window, unioned across the
 * feeds that already exist. Cloud-only by nature (every feed is recorded
 * server-side); hosts guard the entry point.
 */
export function MomentPanel({
  client,
  initialAt,
  initialWindowMinutes,
  onQueryChange,
  onOpenEvent,
  onOpenUrl,
}: MomentPanelProps) {
  const gt = useGT();
  const gtData = useDataString();
  // "" = around now. Kept in the input's local format so typing stays sane.
  const [atInput, setAtInput] = useState(() => (initialAt ? isoToLocalInput(initialAt) : ""));
  // Guard the host-supplied initial window like MomentScreen does — only a
  // finite positive number is usable; anything else gets the default.
  const [windowMinutes, setWindowMinutes] = useState(
    typeof initialWindowMinutes === "number" &&
      Number.isFinite(initialWindowMinutes) &&
      initialWindowMinutes > 0
      ? initialWindowMinutes
      : DEFAULT_MOMENT_WINDOW_MINUTES,
  );
  const [data, setData] = useState<MomentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedBurst, setExpandedBurst] = useState<string | null>(null);
  // Bumped per request so a slow window can't overwrite a later one.
  const requestSeq = useRef(0);

  const atIso = localInputToIso(atInput);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getMoment({
        ...(atIso ? { at: atIso } : {}),
        windowMinutes,
      });
      if (seq !== requestSeq.current) return;
      setData(result);
      setLoading(false);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [client, atIso, windowMinutes]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onQueryChange?.({ at: atIso, windowMinutes });
    // The callback identity is the host's concern; re-notifying on every
    // host re-render would loop navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atIso, windowMinutes]);

  const unhealthyFeeds = (data?.feeds ?? []).filter(
    (feed) => feed.status !== "ok" || feed.truncated,
  );
  const timeline = data ? buildMomentTimeline(data.events, data.incidents) : [];
  const crossesDays =
    data !== null && new Date(data.from).toDateString() !== new Date(data.to).toDateString();

  const formatTime = (iso: string) => {
    const date = new Date(iso);
    return crossesDays ? date.toLocaleString() : date.toLocaleTimeString();
  };

  const eventRow = (event: MomentEvent, incidentIds: string[], inBurst: boolean) => {
    const badge = describeIncidentBadge(spansById(incidentIds, data?.incidents ?? []));
    return (
      <div className={`flex items-center gap-3 min-w-0 ${inBurst ? "pl-6" : ""}`}>
        <span className="text-xs text-on-surface-tertiary whitespace-nowrap w-28 shrink-0 text-right">
          {formatTime(event.timestamp)}
        </span>
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${SEVERITY_DOT[event.severity] ?? SEVERITY_DOT.info}`}
          title={event.severity}
        />
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary whitespace-nowrap shrink-0">
          {gtData(MOMENT_FEED_LABELS[event.feed] ?? event.feed)}
        </span>
        {onOpenEvent && event.link ? (
          <button
            type="button"
            onClick={() => onOpenEvent(event)}
            className="text-sm text-on-surface-secondary hover:text-on-surface hover:underline truncate text-left"
            title={event.title}
          >
            {event.title}
          </button>
        ) : (
          <span className="text-sm text-on-surface-secondary truncate">{event.title}</span>
        )}
        {badge && (
          <span
            className="rounded-full border border-amber-500/40 text-warning px-2 py-0.5 text-xs whitespace-nowrap shrink-0"
            title={gt(
              "This event falls inside a provider incident's span — correlation, not causation.",
            )}
          >
            {badge}
          </span>
        )}
        {event.detail && (
          <span className="ml-auto text-xs text-on-surface-muted truncate">{event.detail}</span>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">{gt("Investigate a moment")}</h1>
      <p className="text-sm text-on-surface-muted mb-6">
        {gt(
          "Everything the platform knows happened around a timestamp — changes, incidents, anomalies, runs, deployments, audit entries and freezes, merged into one timeline.",
        )}
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label htmlFor="moment-at" className="sr-only">
          {gt("Timestamp to investigate")}
        </label>
        <input
          id="moment-at"
          type="datetime-local"
          value={atInput}
          onChange={(e) => setAtInput(e.target.value)}
          className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary"
        />
        <button
          type="button"
          onClick={() => setAtInput("")}
          disabled={atInput === ""}
          className="px-3 py-1.5 text-sm border border-border-strong rounded-lg text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-40"
          title={gt("Centre the window on the current time")}
        >
          {gt("Around now")}
        </button>
        <div
          className="flex rounded-lg border border-border-strong overflow-hidden"
          role="group"
          aria-label={gt("Window size")}
        >
          {MOMENT_WINDOW_PRESETS.map((preset) => (
            <button
              key={preset.minutes}
              type="button"
              onClick={() => setWindowMinutes(preset.minutes)}
              aria-pressed={windowMinutes === preset.minutes}
              className={`px-3 py-1.5 text-sm ${
                windowMinutes === preset.minutes
                  ? "bg-surface-raised text-on-surface"
                  : "text-on-surface-tertiary hover:text-on-surface-secondary"
              }`}
            >
              {gtData(preset.label)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto px-3 py-1.5 text-sm border border-border-strong rounded-lg text-on-surface-tertiary hover:text-on-surface-secondary"
        >
          {gt("Refresh")}
        </button>
      </div>

      {unhealthyFeeds.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {unhealthyFeeds.map((feed) => (
            <span
              key={feed.feed}
              className={`rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${
                feed.status === "error"
                  ? "border-amber-500/40 text-warning"
                  : "border-border text-on-surface-faint"
              }`}
              title={
                feed.status === "error"
                  ? (feed.error ?? gt("The feed's query failed."))
                  : feed.status === "omitted"
                    ? gt("Your role lacks this feed's read permission.")
                    : gt("This feed had more events than the window returns.")
              }
            >
              {gtData(MOMENT_FEED_LABELS[feed.feed] ?? feed.feed)}{" "}
              {feed.status === "error"
                ? gt("unavailable")
                : feed.status === "omitted"
                  ? gt("omitted")
                  : gt("truncated")}
            </span>
          ))}
        </div>
      )}

      {data !== null && data.incidents.length > 0 && (
        <div className="border border-amber-500/30 rounded-xl px-4 py-3 mb-4">
          <T>
            <p className="text-xs text-on-surface-muted mb-1">
              Provider incident<Var>{data.incidents.length === 1 ? "" : "s"}</Var> overlapping
              this window:
            </p>
          </T>
          <ul className="text-sm text-on-surface-secondary">
            {data.incidents.map((incident) => (
              <li key={incident.id} className="truncate">
                {incident.url && onOpenUrl ? (
                  <button
                    type="button"
                    onClick={() => onOpenUrl(incident.url as string)}
                    className="hover:underline"
                  >
                    {incident.pluginName}: {incident.title}
                  </button>
                ) : (
                  <>
                    {incident.pluginName}: {incident.title}
                  </>
                )}
                {!incident.resolvedAt && (
                  <span className="ml-2 text-xs text-warning">{gt("active")}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error !== null && (
        <T>
          <div role="alert" className="mb-4 text-sm text-danger">
            Couldn&apos;t load the moment — <Var>{error}</Var>{" "}
            <button type="button" onClick={() => void load()} className="underline">
              Retry
            </button>
          </div>
        </T>
      )}

      <div className="border border-border rounded-xl overflow-hidden">
        {loading ? (
          <p role="status" className="px-4 py-8 text-center text-sm text-on-surface-faint">
            {gt("Loading…")}
          </p>
        ) : timeline.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-on-surface-faint">{gt("Nothing recorded in this window.")}</p>
            <p className="text-xs text-on-surface-faint mt-1">
              {gt("Try a wider window — or breathe out, maybe nothing happened.")}
            </p>
          </div>
        ) : (
          <ul>
            {timeline.map((item) => (
              <li
                key={item.key}
                className="border-b border-border/50 last:border-b-0 px-4 py-3 hover:bg-surface-raised/50"
              >
                {item.kind === "event" ? (
                  eventRow(item.event, item.incidentIds, false)
                ) : (
                  <div>
                    <button
                      type="button"
                      onClick={() => setExpandedBurst(expandedBurst === item.key ? null : item.key)}
                      aria-expanded={expandedBurst === item.key}
                      className="flex items-center gap-3 min-w-0 w-full text-left"
                    >
                      <span className="text-xs text-on-surface-tertiary whitespace-nowrap w-28 shrink-0 text-right">
                        {formatTime(item.events[0]?.timestamp ?? "")}
                      </span>
                      <span className="w-2 h-2 rounded-full shrink-0 bg-on-surface-faint" />
                      <T>
                        <span className="text-sm text-on-surface-secondary truncate">
                          <Var>{item.events.length}</Var> events on{" "}
                          <Var>{item.resourceName ?? item.resourceId}</Var>
                        </span>
                      </T>
                      {describeIncidentBadge(
                        spansById(item.incidentIds, data?.incidents ?? []),
                      ) && (
                        <span className="rounded-full border border-amber-500/40 text-warning px-2 py-0.5 text-xs whitespace-nowrap shrink-0">
                          {describeIncidentBadge(
                            spansById(item.incidentIds, data?.incidents ?? []),
                          )}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-on-surface-faint shrink-0">
                        {expandedBurst === item.key ? gt("Collapse") : gt("Expand")}
                      </span>
                    </button>
                    {expandedBurst === item.key && (
                      <div className="mt-2 flex flex-col gap-2">
                        {item.events.map((event) => (
                          <div key={event.id}>{eventRow(event, item.incidentIds, true)}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {data !== null && !loading && (
        <T>
          <p className="text-xs text-on-surface-muted mt-4">
            <Var>{new Date(data.from).toLocaleString()}</Var> —{" "}
            <Var>{new Date(data.to).toLocaleString()}</Var> ·{" "}
            <Var>{data.events.length}</Var> event
            <Var>{data.events.length === 1 ? "" : "s"}</Var>
          </p>
        </T>
      )}
    </div>
  );
}
