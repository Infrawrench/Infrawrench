import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatRecordingBytes,
  formatRecordingDuration,
  parseCast,
  type ParsedCast,
  type SessionRecording,
  type SessionRecordingSettings,
  type SessionRecordingStatus,
} from "@infrawrench/client-core";

import { RecordingPlayer } from "../session-recordings/RecordingPlayer.js";
import { useSettingsHost } from "./host.js";
import { CARD, INPUT, LABEL, SECONDARY_BUTTON } from "./styles.js";

const STATUS_LABELS: Record<SessionRecordingStatus, string> = {
  recording: "Live",
  complete: "Complete",
  truncated: "Truncated",
  abandoned: "Incomplete",
};

/**
 * Recorded SSH sessions — the org's policy, what it currently stores, and the
 * tapes themselves.
 *
 * Only cloud-mode SSH is recordable, and that is not a limitation to apologise
 * for: it is the reason the feature is cheap. Those sessions are already
 * proxied through the server, so recording tees a stream we hold rather than
 * asking anyone to install an agent. A desktop session that dials the host
 * directly never touches us and cannot be recorded by us — the section says so
 * rather than letting an operator assume coverage they do not have.
 */
export function SessionRecordingsSection() {
  const { orgId, api, has, permissionsLoading, mountPlaybackTerminal } = useSettingsHost();
  const canRead = has("session-recordings:read");
  const canWrite = has("session-recordings:write");

  const [settings, setSettings] = useState<SessionRecordingSettings | null>(null);
  const [recordings, setRecordings] = useState<SessionRecording[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<SessionRecordingStatus | "">("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SessionRecording | null>(null);

  const base = `/api/org/${orgId}/session-recordings`;

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.get<SessionRecordingSettings>(`${base}/settings`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load recording settings");
    }
  }, [api, base]);

  const loadRecordings = useCallback(async () => {
    try {
      const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
      setRecordings(await api.get<SessionRecording[]>(`${base}${query}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load recordings");
    }
  }, [api, base, statusFilter]);

  useEffect(() => {
    if (!canRead) return;
    void loadSettings();
  }, [canRead, loadSettings]);

  useEffect(() => {
    if (!canRead) return;
    void loadRecordings();
  }, [canRead, loadRecordings]);

  async function savePolicy(patch: Partial<SessionRecordingSettings>) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    try {
      const saved = await api.put<SessionRecordingSettings>(`${base}/settings`, patch);
      setSettings(saved);
    } catch (e) {
      setSettings(previous);
      setError(e instanceof Error ? e.message : "Could not save the recording policy");
    }
  }

  async function remove(recording: SessionRecording) {
    setError(null);
    try {
      await api.delete(`${base}/${encodeURIComponent(recording.id)}`);
      if (selected?.id === recording.id) setSelected(null);
      await Promise.all([loadRecordings(), loadSettings()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the recording");
    }
  }

  if (permissionsLoading) {
    return <p className="text-sm text-on-surface-faint">Loading…</p>;
  }

  if (!canRead) {
    return (
      <div>
        <Header />
        <p className="text-sm text-on-surface-muted">
          Your role does not include <code>session-recordings:read</code>, so you cannot see the
          organization&rsquo;s recorded sessions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header />

      {error && <p className="text-sm text-red-400">{error}</p>}

      {settings && (
        <section className={`${CARD} space-y-4`}>
          <div>
            <h2 className="text-sm font-semibold text-on-surface-secondary">Recording policy</h2>
            <p className="text-xs text-on-surface-muted mt-1">
              Applies to SSH sessions opened through Infrawrench Cloud, including the web terminal
              and desktop sessions in cloud mode. Sessions the desktop app opens directly against a
              host never reach our servers and are not recorded.
            </p>
          </div>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={!canWrite}
              onChange={(e) => void savePolicy({ enabled: e.target.checked })}
              className="mt-0.5"
            />
            <span className="text-sm text-on-surface-secondary">
              Record SSH sessions
              <span className="block text-xs text-on-surface-muted">
                Captures what the host printed, as an asciinema cast. Off by default.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={settings.captureInput}
              disabled={!canWrite || !settings.enabled}
              onChange={(e) => void savePolicy({ captureInput: e.target.checked })}
              className="mt-0.5"
            />
            <span className="text-sm text-on-surface-secondary">
              Also capture keystrokes
              <span className="block text-xs text-on-surface-muted">
                Records what operators typed, including at prompts the remote host chose not to echo
                — a sudo password, a token pasted into an editor. A materially different promise to
                the people being recorded, so it is a separate decision.
              </span>
            </span>
          </label>

          <div className="max-w-[12rem]">
            <label className={LABEL} htmlFor="recording-retention">
              Keep recordings for (days)
            </label>
            <input
              id="recording-retention"
              type="number"
              min={1}
              max={3650}
              className={INPUT}
              defaultValue={settings.retentionDays}
              disabled={!canWrite}
              onBlur={(e) => {
                const days = Number(e.target.value);
                if (Number.isInteger(days) && days !== settings.retentionDays) {
                  void savePolicy({ retentionDays: days });
                }
              }}
            />
          </div>

          <p className="text-xs text-on-surface-muted">
            {settings.usage.recordingCount} recording
            {settings.usage.recordingCount === 1 ? "" : "s"} stored,{" "}
            {formatRecordingBytes(settings.usage.storedBytes)} compressed from{" "}
            {formatRecordingBytes(settings.usage.capturedBytes)} of terminal output
            {settings.usage.oldestStartedAt
              ? `; oldest ${new Date(settings.usage.oldestStartedAt).toLocaleDateString()}`
              : ""}
            .
          </p>

          {!canWrite && (
            <p className="text-xs text-on-surface-muted">
              Changing the policy needs <code>session-recordings:write</code>.
            </p>
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-on-surface-secondary">Sessions</h2>
          <select
            className="bg-surface-overlay border border-border-strong rounded-lg px-2 py-1 text-xs text-on-surface-secondary"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as SessionRecordingStatus | "")}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABELS) as SessionRecordingStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        {recordings === null ? (
          <p className="text-sm text-on-surface-faint">Loading…</p>
        ) : recordings.length === 0 ? (
          <p className="text-sm text-on-surface-muted">
            {settings?.enabled
              ? "No sessions recorded yet."
              : "Recording is off, so nothing has been captured."}
          </p>
        ) : (
          <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
            {recordings.map((recording) => (
              <li key={recording.id} className="p-3 flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-on-surface-secondary truncate">
                    <span className="font-medium">
                      {recording.username}@{recording.host}
                    </span>
                    {recording.hopCount > 1 && (
                      <span className="text-on-surface-muted">
                        {" "}
                        · via {recording.hopCount - 1} jump host
                        {recording.hopCount - 1 === 1 ? "" : "s"}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-on-surface-muted">
                    {recording.userName ?? "an API key"} ·{" "}
                    {new Date(recording.startedAt).toLocaleString()} ·{" "}
                    {formatRecordingDuration(recording.durationMs)} ·{" "}
                    {formatRecordingBytes(recording.outputBytes)}
                    {recording.hasInput ? " · keystrokes" : ""}
                  </p>
                </div>

                <span
                  className={`text-xs px-2 py-0.5 rounded-md ${
                    recording.status === "complete"
                      ? "text-on-surface-tertiary bg-surface-overlay"
                      : "text-amber-400 bg-amber-500/10"
                  }`}
                >
                  {STATUS_LABELS[recording.status]}
                </span>

                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  onClick={() => setSelected(selected?.id === recording.id ? null : recording)}
                >
                  {selected?.id === recording.id ? "Close" : "Watch"}
                </button>

                {canWrite && (
                  <button
                    type="button"
                    className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-red-500/10 text-red-400 rounded-lg transition-colors"
                    onClick={() => void remove(recording)}
                  >
                    Delete
                  </button>
                )}

                {selected?.id === recording.id && (
                  <div className="w-full pt-3">
                    <RecordingViewer
                      recording={recording}
                      castUrl={`${base}/${encodeURIComponent(recording.id)}/cast`}
                      mount={mountPlaybackTerminal}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Header() {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold">Session recordings</h1>
      <p className="text-sm text-on-surface-muted mt-1">
        A replayable record of every SSH session opened through the cloud — who connected, to what,
        and exactly what crossed the terminal. Recordings download as standard <code>.cast</code>{" "}
        files, so an auditor can play them with <code>asciinema play</code> without our software.
      </p>
    </div>
  );
}

/**
 * Fetch and play one cast.
 *
 * The document is fetched here rather than in the list so that opening a
 * session is what costs a download — a page listing 200 recordings must not
 * pull 200 tapes. Fetched through the host's `api.get` in text form is not
 * possible (it parses JSON), so this uses `fetch` with the same credentials
 * the rest of the web host uses, and falls back to a plain download link on
 * hosts that supply no terminal.
 */
function RecordingViewer({
  recording,
  castUrl,
  mount,
}: {
  recording: SessionRecording;
  castUrl: string;
  mount: ReturnType<typeof useSettingsHost>["mountPlaybackTerminal"];
}) {
  const { fetchText } = useSettingsHost();
  const [cast, setCast] = useState<ParsedCast | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCast(null);
    setError(null);
    fetchText(castUrl)
      .then((text) => {
        if (cancelled) return;
        setCast(parseCast(text));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the recording");
      });
    return () => {
      cancelled = true;
    };
  }, [castUrl, fetchText]);

  const downloadUrl = useMemo(() => `${castUrl}?download=1`, [castUrl]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!cast) return <p className="text-sm text-on-surface-faint">Loading recording…</p>;

  return (
    <div className="space-y-2">
      {mount ? (
        <RecordingPlayer cast={cast} mount={mount} />
      ) : (
        <p className="text-sm text-on-surface-muted">
          Playback is not available on this surface. Download the cast and play it with{" "}
          <code>asciinema play</code>.
        </p>
      )}
      <p className="text-xs text-on-surface-muted">
        {cast.events.length} events · recorded at {recording.cols}×{recording.rows} ·{" "}
        <a href={downloadUrl} className="underline" download>
          download .cast
        </a>
      </p>
    </div>
  );
}
