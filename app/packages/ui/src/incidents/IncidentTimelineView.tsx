import {
  INCIDENT_ARTIFACT_LABELS,
  type IncidentTimelineEntry,
  type IncidentTimelineResponse,
} from "@infrawrench/client-core";

export interface IncidentTimelineViewProps {
  timeline: IncidentTimelineResponse | null;
  /** null while loading, a string when the fetch failed. */
  error?: string | null;
  onRetry?: () => void;
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-blue-500",
};

const SOURCE_LABEL: Record<string, string> = {
  incident: "Incident",
  note: "Note",
  artifact: "Artefact",
  moment: "Recorded",
  probe: "Probe",
  "metric-alert": "Metric alert",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function entryTone(entry: IncidentTimelineEntry): string {
  if (entry.kind === "artifact.failed" || entry.kind === "artifact.close_failed") {
    return "border-red-500/40 bg-red-500/5";
  }
  if (entry.source === "note") return "border-blue-500/30 bg-blue-500/5";
  if (entry.source === "incident") return "border-border bg-surface-sunken";
  return "border-border";
}

/**
 * The merged timeline.
 *
 * Everything here arrived from `buildIncidentTimeline` already ordered,
 * windowed and badged — this component renders and does not decide, which is
 * what lets web, desktop and the postmortem export agree about what happened
 * without three copies of the merge.
 *
 * Two things are called out visually rather than left to be read: a failed
 * artefact (red, with its error) and an operator note (blue). Those are the two
 * rows a human wrote or a human needs to act on; everything else is machinery.
 */
export function IncidentTimelineView({ timeline, error, onRetry }: IncidentTimelineViewProps) {
  if (error) {
    return (
      <p className="text-sm text-danger">
        {error}{" "}
        {onRetry && (
          <button type="button" onClick={onRetry} className="underline hover:text-danger-strong">
            Retry
          </button>
        )}
      </p>
    );
  }
  if (!timeline) return <p className="text-sm text-on-surface-faint">Assembling the timeline…</p>;

  const degraded = timeline.feeds.filter((feed) => feed.status !== "ok");

  return (
    <div className="space-y-2">
      {degraded.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {degraded.map((feed) => (
            <span
              key={feed.feed}
              className="px-2 py-0.5 rounded-full text-[11px] bg-surface-sunken text-on-surface-faint"
              title={feed.error ?? undefined}
            >
              {feed.feed} {feed.status === "omitted" ? "not visible to you" : "unavailable"}
            </span>
          ))}
        </div>
      )}

      {timeline.entries.length === 0 ? (
        <p className="text-sm text-on-surface-faint">
          Nothing else was recorded in this window. That is a finding too — it means the change
          feed, deploys and alerts were all quiet while this was happening.
        </p>
      ) : (
        <ol className="space-y-1.5">
          {timeline.entries.map((entry) => (
            <li key={entry.id} className={`rounded-lg border px-3 py-2 ${entryTone(entry)}`}>
              <div className="flex items-start gap-2">
                <span
                  className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                    SEVERITY_DOT[entry.severity] ?? "bg-neutral-500"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-xs tabular-nums text-on-surface-faint">
                      {formatTime(entry.at)}
                    </span>
                    <span className="text-[11px] uppercase tracking-wide text-on-surface-faint">
                      {SOURCE_LABEL[entry.source] ?? entry.source}
                    </span>
                    {entry.authorName && (
                      <span className="text-[11px] text-on-surface-faint">{entry.authorName}</span>
                    )}
                  </div>
                  <p className="text-sm text-on-surface break-words">{entry.title}</p>
                  {entry.detail && (
                    <p className="text-xs text-on-surface-secondary break-words">{entry.detail}</p>
                  )}
                  {entry.resourceName && (
                    <p className="text-[11px] text-on-surface-faint">{entry.resourceName}</p>
                  )}
                  {entry.link?.url && (
                    <a
                      href={entry.link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-[11px] text-info hover:underline"
                    >
                      Open provider status page
                    </a>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {timeline.truncated && (
        <p className="text-xs text-on-surface-faint">
          The timeline was truncated — this incident's window contains more events than one view can
          carry.
        </p>
      )}
    </div>
  );
}

/** Small helper the detail header reuses for the artefact chips. */
export function artifactLabel(kind: string): string {
  return INCIDENT_ARTIFACT_LABELS[kind as keyof typeof INCIDENT_ARTIFACT_LABELS] ?? kind;
}
