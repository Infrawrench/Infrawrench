import { useCallback, useEffect, useState } from "react";
import {
  formatIncidentDuration,
  isIncidentArtifactFailure,
  incidentSeverityLabel,
  incidentStatusLabel,
  type Incident,
  type IncidentNote,
  type IncidentStatus,
  type IncidentTimelineResponse,
} from "@infrawrench/client-core";
import { DeclareIncidentModal } from "./DeclareIncidentModal.js";
import { IncidentTimelineView, artifactLabel } from "./IncidentTimelineView.js";
import type { IncidentSeed, IncidentsClient } from "./types.js";

export interface IncidentsPanelProps {
  client: IncidentsClient;
  /** Which incident the detail view opens on; the host mirrors it into the URL. */
  incidentId?: string | undefined;
  /** Called when the selection changes, so the host can record it on the tab. */
  onIncidentChange?: (incidentId: string | null) => void;
  /** Set by a host that arrived here from a "Declare incident" button. */
  initialSeed?: IncidentSeed | undefined;
}

const STATUS_FILTERS: Array<{ id: IncidentStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "mitigated", label: "Mitigated" },
  { id: "resolved", label: "Resolved" },
];

function severityTone(severity: string): string {
  switch (severity) {
    case "sev1":
      return "bg-red-600 text-white";
    case "sev2":
      return "bg-orange-600 text-white";
    case "sev3":
      return "bg-amber-600 text-white";
    default:
      return "bg-surface-sunken text-on-surface-secondary";
  }
}

function statusTone(status: string): string {
  switch (status) {
    case "open":
      return "text-red-400";
    case "mitigated":
      return "text-amber-400";
    default:
      return "text-on-surface-faint";
  }
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Incident mode: the list, and the detail view with the assembled timeline.
 *
 * Shared between web and desktop (and rendered by the incidents workspace tab
 * on both). Write actions are gated on the client exposing them, the
 * `ProbesPanel` convention.
 *
 * List and detail are one component rather than two routes because during an
 * incident the useful navigation is "back to the list and into the other one",
 * and a route transition per click is a page load you do not want at 03:14.
 */
export function IncidentsPanel({
  client,
  incidentId,
  onIncidentChange,
  initialSeed,
}: IncidentsPanelProps) {
  // null = loading, [] = loaded-empty.
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [filter, setFilter] = useState<IncidentStatus | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [declaring, setDeclaring] = useState<IncidentSeed | null>(initialSeed ?? null);

  const [selected, setSelected] = useState<Incident | null>(null);
  const [notes, setNotes] = useState<IncidentNote[]>([]);
  const [timeline, setTimeline] = useState<IncidentTimelineResponse | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [postmortem, setPostmortem] = useState<string | null>(null);

  const canWrite = Boolean(client.declareIncident && client.updateIncident);

  const reload = useCallback(() => {
    setError(null);
    client
      .listIncidents(filter)
      .then(setIncidents)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load incidents"));
  }, [client, filter]);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadDetail = useCallback(
    (id: string) => {
      setTimeline(null);
      setTimelineError(null);
      client
        .getIncident(id)
        .then((detail) => {
          setSelected(detail.incident);
          setNotes(detail.notes);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Failed to load the incident"));
      client
        .getTimeline(id)
        .then(setTimeline)
        .catch((e) =>
          setTimelineError(e instanceof Error ? e.message : "Failed to assemble the timeline"),
        );
    },
    [client],
  );

  useEffect(() => {
    if (incidentId) loadDetail(incidentId);
    else {
      setSelected(null);
      setNotes([]);
      setTimeline(null);
      setPostmortem(null);
    }
  }, [incidentId, loadDetail]);

  const open = (id: string | null) => {
    setPostmortem(null);
    onIncidentChange?.(id);
    if (id) loadDetail(id);
    else setSelected(null);
  };

  const transition = async (status: IncidentStatus) => {
    if (!selected || !client.updateIncident) return;
    setBusy(true);
    try {
      const updated = await client.updateIncident(selected.id, { status });
      setSelected(updated);
      reload();
      // Resolving lifts a freeze and closes a public update, both of which can
      // fail; re-reading the timeline is how the operator sees whether they did.
      client
        .getTimeline(selected.id)
        .then(setTimeline)
        .catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update the incident");
    } finally {
      setBusy(false);
    }
  };

  const submitNote = async () => {
    if (!selected || !client.addNote) return;
    const body = noteDraft.trim();
    if (!body) return;
    setBusy(true);
    try {
      await client.addNote(selected.id, body);
      setNoteDraft("");
      loadDetail(selected.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add the note");
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!selected || !client.retryArtifacts) return;
    setBusy(true);
    try {
      setSelected(await client.retryArtifacts(selected.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to retry");
    } finally {
      setBusy(false);
    }
  };

  const exportPostmortem = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const doc = await client.getPostmortem(selected.id);
      setPostmortem(doc.markdown);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build the postmortem");
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------------------------------------------- *
   * Detail
   * ---------------------------------------------------------------- */

  if (incidentId && selected) {
    const failed = selected.artifacts.filter((a) => isIncidentArtifactFailure(a.status));
    return (
      <div className="space-y-5">
        <button
          type="button"
          onClick={() => open(null)}
          className="text-xs text-on-surface-secondary hover:text-on-surface"
        >
          ← All incidents
        </button>

        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`px-2 py-0.5 rounded text-xs font-semibold ${severityTone(selected.severity)}`}
            >
              {incidentSeverityLabel(selected.severity)}
            </span>
            <h2 className="text-lg font-semibold text-on-surface">{selected.title}</h2>
          </div>
          <p className="text-xs text-on-surface-secondary">
            <span className={statusTone(selected.status)}>
              {incidentStatusLabel(selected.status)}
            </span>{" "}
            · started {formatWhen(selected.startedAt)} ·{" "}
            {formatIncidentDuration(selected.startedAt, selected.resolvedAt)}
            {selected.declaredByName && ` · declared by ${selected.declaredByName}`}
          </p>
          {selected.summary && <p className="text-sm text-on-surface">{selected.summary}</p>}
        </header>

        {/* Artefacts, failures first and loudest. */}
        {selected.artifacts.length > 0 && (
          <section className="space-y-1.5">
            <div className="flex flex-wrap gap-1.5">
              {selected.artifacts.map((artifact) => (
                <span
                  key={artifact.id}
                  title={artifact.error ?? artifact.label ?? undefined}
                  className={`px-2 py-0.5 rounded-full text-[11px] ${
                    isIncidentArtifactFailure(artifact.status)
                      ? "bg-red-500/15 text-red-400"
                      : artifact.status === "closed"
                        ? "bg-surface-sunken text-on-surface-faint"
                        : "bg-emerald-500/15 text-emerald-400"
                  }`}
                >
                  {artifactLabel(artifact.kind)} · {artifact.status}
                </span>
              ))}
            </div>
            {failed.length > 0 && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2">
                <p className="text-xs text-red-300">
                  {failed.length === 1 ? "One thing" : `${failed.length} things`} on this incident
                  needs attention:
                </p>
                <ul className="mt-1 space-y-0.5">
                  {failed.map((artifact) => (
                    <li key={artifact.id} className="text-xs text-on-surface-secondary">
                      <span className="text-on-surface">{artifactLabel(artifact.kind)}</span>
                      {artifact.status === "close_failed" ? " is still open — " : " — "}
                      {artifact.error}
                    </li>
                  ))}
                </ul>
                {client.retryArtifacts && (
                  <button
                    type="button"
                    onClick={() => void retry()}
                    disabled={busy}
                    className="mt-2 px-2 py-1 rounded-lg text-xs bg-surface-sunken text-on-surface-secondary hover:bg-surface disabled:opacity-50"
                  >
                    Retry these
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {selected.status === "open" && (
              <button
                type="button"
                onClick={() => void transition("mitigated")}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white transition-colors"
              >
                Mark mitigated
              </button>
            )}
            {selected.status !== "resolved" && (
              <button
                type="button"
                onClick={() => void transition("resolved")}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors"
              >
                Resolve
              </button>
            )}
            {selected.status === "resolved" && (
              <button
                type="button"
                onClick={() => void transition("open")}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg text-sm bg-surface-sunken text-on-surface-secondary hover:bg-surface disabled:opacity-50 transition-colors"
              >
                Reopen
              </button>
            )}
            <button
              type="button"
              onClick={() => void exportPostmortem()}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-sm bg-surface-sunken text-on-surface-secondary hover:bg-surface disabled:opacity-50 transition-colors"
            >
              Postmortem
            </button>
          </div>
        )}

        {postmortem !== null && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-on-surface">Postmortem draft</h3>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(postmortem)}
                  className="px-2 py-1 rounded-lg text-xs bg-surface-sunken text-on-surface-secondary hover:bg-surface"
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => setPostmortem(null)}
                  className="px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken"
                >
                  Close
                </button>
              </div>
            </div>
            <textarea
              readOnly
              value={postmortem}
              rows={16}
              className="w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 font-mono text-xs text-on-surface"
            />
            <p className="text-xs text-on-surface-faint">
              The facts are filled in. Impact, root cause and action items are deliberately left
              blank — paste this into your tracker and finish it there.
            </p>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-on-surface">Timeline</h3>
          {client.addNote && (
            <div className="flex gap-2">
              <input
                type="text"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitNote();
                }}
                placeholder="Add a note — failed over to the replica…"
                className="flex-1 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-on-surface"
              />
              <button
                type="button"
                onClick={() => void submitNote()}
                disabled={busy || !noteDraft.trim()}
                className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
              >
                Add
              </button>
            </div>
          )}
          <IncidentTimelineView
            timeline={timeline}
            error={timelineError}
            onRetry={() => loadDetail(selected.id)}
          />
        </section>

        {notes.length > 0 && (
          <p className="text-xs text-on-surface-faint">
            {notes.length} note{notes.length === 1 ? "" : "s"} on this incident, shown inline above.
          </p>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    );
  }

  /* ---------------------------------------------------------------- *
   * List
   * ---------------------------------------------------------------- */

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-on-surface">Incidents</h2>
          <p className="text-xs text-on-surface-faint">
            Incidents you declared — not provider outages, which live under Changes. Declaring
            records the incident and, if you ask it to, freezes changes, pins the moment, tells your
            org and tells the public.
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setDeclaring({})}
            className="shrink-0 px-3 py-1.5 rounded-lg text-sm bg-red-600 hover:bg-red-500 text-white transition-colors"
          >
            Declare incident
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={filter === option.id}
            onClick={() => setFilter(option.id)}
            className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
              filter === option.id
                ? "bg-blue-600 text-white"
                : "bg-surface-sunken text-on-surface-secondary hover:bg-surface"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-sm text-red-400">
          {error}{" "}
          <button type="button" onClick={reload} className="underline hover:text-red-300">
            Retry
          </button>
        </p>
      )}
      {incidents === null && !error && (
        <p className="text-sm text-on-surface-faint">Loading incidents…</p>
      )}
      {incidents !== null && incidents.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          No incidents{filter === "all" ? "" : ` with status ${filter}`}. Long may it last.
        </p>
      )}

      {incidents !== null && incidents.length > 0 && (
        <ul className="space-y-2">
          {incidents.map((incident) => {
            const failedCount = incident.artifacts.filter((a) =>
              isIncidentArtifactFailure(a.status),
            ).length;
            return (
              <li key={incident.id}>
                <button
                  type="button"
                  onClick={() => open(incident.id)}
                  className="w-full text-left rounded-xl border border-border bg-surface-raised px-4 py-3 hover:border-blue-500/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${severityTone(incident.severity)}`}
                    >
                      {incidentSeverityLabel(incident.severity)}
                    </span>
                    <span className="text-sm font-medium text-on-surface truncate">
                      {incident.title}
                    </span>
                    <span className={`text-xs ${statusTone(incident.status)}`}>
                      {incidentStatusLabel(incident.status)}
                    </span>
                    {failedCount > 0 && (
                      <span className="text-xs text-red-400">
                        {failedCount} artefact{failedCount === 1 ? "" : "s"} need
                        {failedCount === 1 ? "s" : ""} attention
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-secondary truncate">
                    {formatWhen(incident.startedAt)} ·{" "}
                    {formatIncidentDuration(incident.startedAt, incident.resolvedAt)}
                    {incident.declaredByName && ` · ${incident.declaredByName}`}
                    {incident.noteCount > 0 && ` · ${incident.noteCount} notes`}
                    {incident.affectedResourceIds.length > 0 &&
                      ` · ${incident.affectedResourceIds.length} resources`}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {declaring !== null && (
        <DeclareIncidentModal
          client={client}
          seed={declaring}
          onDeclared={(incident) => {
            setDeclaring(null);
            reload();
            open(incident.id);
          }}
          onClose={() => setDeclaring(null)}
        />
      )}
    </div>
  );
}
