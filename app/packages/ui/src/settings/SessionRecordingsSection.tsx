import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
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

function useStatusLabels(gt: ReturnType<typeof useGT>): Record<SessionRecordingStatus, string> {
  return {
    recording: gt("Live"),
    complete: gt("Complete"),
    truncated: gt("Truncated"),
    abandoned: gt("Incomplete"),
  };
}

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
  const gt = useGT();
  const STATUS_LABELS = useStatusLabels(gt);
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
      setError(e instanceof Error ? e.message : gt("Could not load recording settings"));
    }
  }, [api, base, gt]);

  const loadRecordings = useCallback(async () => {
    try {
      const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
      setRecordings(await api.get<SessionRecording[]>(`${base}${query}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not load recordings"));
    }
  }, [api, base, statusFilter, gt]);

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
      setError(e instanceof Error ? e.message : gt("Could not save the recording policy"));
    }
  }

  async function remove(recording: SessionRecording) {
    setError(null);
    try {
      await api.delete(`${base}/${encodeURIComponent(recording.id)}`);
      if (selected?.id === recording.id) setSelected(null);
      await Promise.all([loadRecordings(), loadSettings()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not delete the recording"));
    }
  }

  if (permissionsLoading) {
    return <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>;
  }

  if (!canRead) {
    return (
      <div>
        <Header />
        <T>
          <p className="text-sm text-on-surface-muted">
            Your role does not include <code>session-recordings:read</code>, so you cannot see the
            organization&rsquo;s recorded sessions.
          </p>
        </T>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header />

      {error && <p className="text-sm text-danger">{error}</p>}

      {settings && (
        <section className={`${CARD} space-y-4`}>
          <div>
            <h2 className="text-sm font-semibold text-on-surface-secondary">
              {gt("Recording policy")}
            </h2>
            <T>
              <p className="text-xs text-on-surface-muted mt-1">
                Applies to SSH sessions opened through Infrawrench Cloud, including the web terminal
                and desktop sessions in cloud mode. Sessions the desktop app opens directly against
                a host never reach our servers and are not recorded.
              </p>
            </T>
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
              {gt("Record SSH sessions")}
              <span className="block text-xs text-on-surface-muted">
                {gt("Captures what the host printed, as an asciinema cast. Off by default.")}
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
              {gt("Also capture keystrokes")}
              <span className="block text-xs text-on-surface-muted">
                {gt(
                  "Records what operators typed, including at prompts the remote host chose not to echo — a sudo password, a token pasted into an editor. A materially different promise to the people being recorded, so it is a separate decision.",
                )}
              </span>
            </span>
          </label>

          <div className="max-w-[12rem]">
            <label className={LABEL} htmlFor="recording-retention">
              {gt("Keep recordings for (days)")}
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
                const raw = e.target.value.trim();
                // Empty/partial input: Number('') is 0 and Number('12.') is
                // not an integer — neither should silently ship to the API.
                const days = raw === "" ? NaN : Number(raw);
                if (
                  !Number.isInteger(days) ||
                  days < 1 ||
                  days > 3650 ||
                  days === settings.retentionDays
                ) {
                  e.target.value = String(settings.retentionDays);
                  return;
                }
                void savePolicy({ retentionDays: days });
              }}
            />
          </div>

          <p className="text-xs text-on-surface-muted">
            {gt(
              "{count} recording{plural} stored, {stored} compressed from {captured} of terminal output{oldest}.",
              {
                count: settings.usage.recordingCount,
                plural: settings.usage.recordingCount === 1 ? "" : "s",
                stored: formatRecordingBytes(settings.usage.storedBytes),
                captured: formatRecordingBytes(settings.usage.capturedBytes),
                oldest: settings.usage.oldestStartedAt
                  ? gt("; oldest {date}", {
                      date: new Date(settings.usage.oldestStartedAt).toLocaleDateString(),
                    })
                  : "",
              },
            )}
          </p>

          {!canWrite && (
            <T>
              <p className="text-xs text-on-surface-muted">
                Changing the policy needs <code>session-recordings:write</code>.
              </p>
            </T>
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-on-surface-secondary">{gt("Sessions")}</h2>
          <select
            className="bg-surface-overlay border border-border-strong rounded-lg px-2 py-1 text-xs text-on-surface-secondary"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as SessionRecordingStatus | "")}
            aria-label={gt("Filter by status")}
          >
            <option value="">{gt("All statuses")}</option>
            {(Object.keys(STATUS_LABELS) as SessionRecordingStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        {recordings === null ? (
          <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
        ) : recordings.length === 0 ? (
          <p className="text-sm text-on-surface-muted">
            {settings?.enabled
              ? gt("No sessions recorded yet.")
              : gt("Recording is off, so nothing has been captured.")}
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
                        {gt("· via {count} jump host{plural}", {
                          count: recording.hopCount - 1,
                          plural: recording.hopCount - 1 === 1 ? "" : "s",
                        })}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-on-surface-muted">
                    {recording.userName ?? gt("an API key")} ·{" "}
                    {new Date(recording.startedAt).toLocaleString()} ·{" "}
                    {formatRecordingDuration(recording.durationMs)} ·{" "}
                    {formatRecordingBytes(recording.outputBytes)}
                    {recording.hasInput ? ` · ${gt("keystrokes")}` : ""}
                  </p>
                </div>

                <span
                  className={`text-xs px-2 py-0.5 rounded-md ${
                    recording.status === "complete"
                      ? "text-on-surface-tertiary bg-surface-overlay"
                      : "text-warning bg-amber-500/10"
                  }`}
                >
                  {STATUS_LABELS[recording.status]}
                </span>

                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  onClick={() => setSelected(selected?.id === recording.id ? null : recording)}
                >
                  {selected?.id === recording.id ? gt("Close") : gt("Watch")}
                </button>

                {canWrite && (
                  <button
                    type="button"
                    className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-red-500/10 text-danger rounded-lg transition-colors"
                    onClick={() => void remove(recording)}
                  >
                    {gt("Delete")}
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
  const gt = useGT();
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold">{gt("Session recordings")}</h1>
      <T>
        <p className="text-sm text-on-surface-muted mt-1">
          A replayable record of every SSH session opened through the cloud — who connected, to
          what, and exactly what crossed the terminal. Recordings download as standard{" "}
          <code>.cast</code> files, so an auditor can play them with <code>asciinema play</code>{" "}
          without our software.
        </p>
      </T>
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
  const gt = useGT();
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
        if (!cancelled)
          setError(e instanceof Error ? e.message : gt("Could not load the recording"));
      });
    return () => {
      cancelled = true;
    };
  }, [castUrl, fetchText, gt]);

  const downloadUrl = useMemo(() => `${castUrl}?download=1`, [castUrl]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!cast) return <p className="text-sm text-on-surface-faint">{gt("Loading recording…")}</p>;

  return (
    <div className="space-y-2">
      {mount ? (
        <RecordingPlayer cast={cast} mount={mount} />
      ) : (
        <T>
          <p className="text-sm text-on-surface-muted">
            Playback is not available on this surface. Download the cast and play it with{" "}
            <code>asciinema play</code>.
          </p>
        </T>
      )}
      <T>
        <p className="text-xs text-on-surface-muted">
          <Var>{cast.events.length}</Var> events · recorded at <Var>{recording.cols}</Var>×
          <Var>{recording.rows}</Var> ·{" "}
          <a href={downloadUrl} className="underline" download>
            download .cast
          </a>
        </p>
      </T>
    </div>
  );
}
