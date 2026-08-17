import { useCallback, useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import {
  ON_CALL_LIMITS,
  validateOnCallOverride,
  validateOnCallSchedule,
  type OnCallOverride,
  type OnCallSchedule,
  type OnCallShift,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

interface OnCallNowEntry {
  scheduleId: string;
  scheduleName: string;
  enabled: boolean;
  shift: OnCallShift | null;
  next: { userId: string; name: string | null; email: string | null } | null;
}

/** The subset of `/team/members` the pickers need. */
interface TeamMember {
  userId: string;
  name: string | null;
  email: string;
}

interface TeamMemberRow {
  id: string;
  email: string;
  displayName: string | null;
}

interface Draft {
  name: string;
  timezone: string;
  rotationDays: number;
  handoffTime: string;
  startDate: string;
  participantUserIds: string[];
  enabled: boolean;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function hostZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function emptyDraft(): Draft {
  return {
    name: "",
    timezone: hostZone(),
    rotationDays: 7,
    handoffTime: "09:00",
    startDate: today(),
    participantUserIds: [],
    enabled: true,
  };
}

function draftFrom(schedule: OnCallSchedule): Draft {
  return {
    name: schedule.name,
    timezone: schedule.timezone,
    rotationDays: schedule.rotationDays,
    handoffTime: schedule.handoffTime,
    startDate: schedule.startDate,
    participantUserIds: schedule.participants.map((person) => person.userId),
    enabled: schedule.enabled,
  };
}

function personLabel(person: { name: string | null; email?: string | null }): string {
  return person.name ?? person.email ?? "—";
}

function formatWindow(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  return `${start.toLocaleString(undefined, opts)} → ${end.toLocaleString(undefined, opts)}`;
}

/**
 * On-call rotations.
 *
 * Sits in Settings rather than in a workspace tab because it is org
 * configuration that alert routing reads — the same shelf as Notifications,
 * which is where the rules that consume it live.
 *
 * The shift preview comes from the server, which computes it with the same
 * function the alert path resolves with. A preview computed a second way could
 * disagree with who actually gets woken up, which would make it worse than no
 * preview.
 */
export function OnCallSection() {
  const gt = useGT();
  const { orgId, api, has } = useSettingsHost();
  const canWrite = has("org:settings:write");

  const [schedules, setSchedules] = useState<OnCallSchedule[]>([]);
  const [now, setNow] = useState<OnCallNowEntry[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [shifts, setShifts] = useState<Record<string, OnCallShift[]>>({});
  const [overrides, setOverrides] = useState<OnCallOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [coverFor, setCoverFor] = useState<string | null>(null);
  const [coverDraft, setCoverDraft] = useState({
    userId: "",
    startsAt: "",
    endsAt: "",
    reason: "",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const [scheduleList, nowList, overrideList] = await Promise.all([
        api.get<{ schedules: OnCallSchedule[] }>(`/api/org/${orgId}/on-call/schedules`),
        api.get<{ onCall: OnCallNowEntry[] }>(`/api/org/${orgId}/on-call/now`),
        api.get<{ overrides: OnCallOverride[] }>(`/api/org/${orgId}/on-call/overrides`),
      ]);
      setSchedules(scheduleList.schedules);
      setNow(nowList.onCall);
      setOverrides(overrideList.overrides);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load the on-call rotations"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The member list only feeds the pickers, so a failure here costs the picker
  // and not the page.
  useEffect(() => {
    let cancelled = false;
    api
      .get<TeamMemberRow[]>(`/api/org/${orgId}/team/members`)
      .then((rows) => {
        if (cancelled) return;
        setMembers(
          (rows ?? []).map((row) => ({
            userId: row.id,
            name: row.displayName,
            email: row.email,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);

  const loadShifts = useCallback(
    async (scheduleId: string) => {
      try {
        const response = await api.get<{ shifts: OnCallShift[] }>(
          `/api/org/${orgId}/on-call/schedules/${scheduleId}/shifts?count=8`,
        );
        setShifts((current) => ({ ...current, [scheduleId]: response.shifts }));
      } catch {
        setShifts((current) => ({ ...current, [scheduleId]: [] }));
      }
    },
    [api, orgId],
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await load();
      setDraft(null);
      setEditingId(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!draft) return;
    // The same validator the API runs, so the message here is the message the
    // server would have returned.
    const problem = validateOnCallSchedule(draft);
    if (problem) {
      setActionError(problem);
      return;
    }
    void run(async () => {
      if (editingId) await api.patch(`/api/org/${orgId}/on-call/schedules/${editingId}`, draft);
      else await api.post(`/api/org/${orgId}/on-call/schedules`, draft);
    });
  }

  function saveCover(scheduleId: string) {
    const input = {
      userId: coverDraft.userId,
      startsAt: new Date(coverDraft.startsAt).toISOString(),
      endsAt: new Date(coverDraft.endsAt).toISOString(),
      reason: coverDraft.reason.trim() || null,
    };
    const problem = validateOnCallOverride(input);
    if (problem) {
      setActionError(problem);
      return;
    }
    void run(async () => {
      await api.post(`/api/org/${orgId}/on-call/overrides`, { scheduleId, ...input });
      setCoverFor(null);
      setCoverDraft({ userId: "", startsAt: "", endsAt: "", reason: "" });
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">{gt("On-call")}</h2>
        <T>
          <p className="text-sm text-on-surface-muted">
            Who to wake, rather than which channel to shout into. A rotation is a list of people, a
            shift length and a handover time; an alert routing rule can then say "whoever is on
            call" and keep meaning it after Monday's handover.
          </p>
        </T>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-xs text-danger">
          {actionError}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading rotations…")}
        </p>
      )}

      {!loading && now.length > 0 && (
        <div className="rounded-xl border border-border p-4">
          <h3 className="mb-2 text-sm font-medium text-on-surface">{gt("On call right now")}</h3>
          <ul className="flex flex-col gap-1.5">
            {now.map((entry) => (
              <li key={entry.scheduleId} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="text-on-surface-tertiary">{entry.scheduleName}</span>
                <span className="font-medium text-on-surface">
                  {entry.shift ? personLabel(entry.shift) : gt("Nobody")}
                </span>
                {entry.shift?.source === "override" && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-warning">
                    {gt("Covering")}
                  </span>
                )}
                {!entry.enabled && (
                  <span className="text-xs text-on-surface-faint">{gt("(rotation is off)")}</span>
                )}
                {entry.next && (
                  <span className="text-xs text-on-surface-faint">
                    {gt("Escalates to {name}", { name: personLabel(entry.next) })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {canWrite && draft === null && (
        <div>
          <button
            type="button"
            onClick={() => {
              setDraft(emptyDraft());
              setEditingId(null);
            }}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent"
          >
            {gt("New rotation")}
          </button>
        </div>
      )}

      {draft !== null && (
        <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
            {gt("Name")}
            <input
              value={draft.name}
              maxLength={ON_CALL_LIMITS.maxNameLength}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={gt("Platform primary")}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
              {gt("Time zone")}
              <input
                value={draft.timezone}
                onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                // i18n-ignore: IANA timezone identifier
                placeholder="Europe/London"
                className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
              {gt("Handover time")}
              <input
                type="time"
                value={draft.handoffTime}
                onChange={(e) => setDraft({ ...draft, handoffTime: e.target.value })}
                className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
              {gt("Shift length (days)")}
              <input
                type="number"
                min={ON_CALL_LIMITS.minRotationDays}
                max={ON_CALL_LIMITS.maxRotationDays}
                value={draft.rotationDays}
                onChange={(e) => setDraft({ ...draft, rotationDays: Number(e.target.value) })}
                className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
              {gt("First shift starts")}
              <input
                type="date"
                value={draft.startDate}
                onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
                className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-on-surface"
              />
            </label>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs text-on-surface-tertiary">
              {gt("Rotation order — click to add, click again to remove")}
            </legend>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {members.map((member) => {
                const index = draft.participantUserIds.indexOf(member.userId);
                const on = index >= 0;
                return (
                  <button
                    key={member.userId}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        participantUserIds: on
                          ? draft.participantUserIds.filter((id) => id !== member.userId)
                          : [...draft.participantUserIds, member.userId],
                      })
                    }
                    className={`rounded-full border px-2.5 py-1 transition-colors ${
                      on
                        ? "border-transparent bg-surface-overlay text-on-surface"
                        : "border-border text-on-surface-tertiary hover:text-on-surface-secondary"
                    }`}
                  >
                    {on && (
                      <span className="mr-1 tabular-nums text-on-surface-faint">{index + 1}</span>
                    )}
                    {personLabel(member)}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <label className="flex items-center gap-2 text-xs text-on-surface-tertiary">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            {gt("Rotation is live")}
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={save}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
            >
              {gt("Save")}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setEditingId(null);
                setActionError(null);
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-on-surface-tertiary"
            >
              {gt("Cancel")}
            </button>
          </div>
        </div>
      )}

      {!loading && schedules.length === 0 && draft === null && (
        <T>
          <p className="text-sm text-on-surface-faint">
            No rotations yet. Create one and an alert routing rule can send to whoever is on call
            instead of to a channel.
          </p>
        </T>
      )}

      <ul className="flex flex-col gap-2">
        {schedules.map((schedule) => (
          <li key={schedule.id} className="rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  const next = expandedId === schedule.id ? null : schedule.id;
                  setExpandedId(next);
                  if (next) void loadShifts(schedule.id);
                }}
                aria-expanded={expandedId === schedule.id}
                className="text-sm font-medium text-on-surface underline-offset-2 hover:underline"
              >
                {schedule.name}
              </button>
              {!schedule.enabled && (
                <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-xs text-on-surface-faint">
                  {gt("Off")}
                </span>
              )}
              <span className="text-xs text-on-surface-tertiary">
                {gt("{count} people · {days}-day shifts · handover {time} {zone}", {
                  count: schedule.participants.length,
                  days: schedule.rotationDays,
                  time: schedule.handoffTime,
                  zone: schedule.timezone,
                })}
              </span>
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => setCoverFor(coverFor === schedule.id ? null : schedule.id)}
                  className="rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary"
                >
                  {gt("Arrange cover")}
                </button>
                {canWrite && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(draftFrom(schedule));
                        setEditingId(schedule.id);
                      }}
                      className="rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary"
                    >
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.delete(`/api/org/${orgId}/on-call/schedules/${schedule.id}`);
                        })
                      }
                      className="text-xs text-danger underline disabled:opacity-50"
                    >
                      {gt("Delete")}
                    </button>
                  </>
                )}
              </div>
            </div>

            {coverFor === schedule.id && (
              <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
                <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                  {gt("Who is covering")}
                  <select
                    value={coverDraft.userId}
                    onChange={(e) => setCoverDraft({ ...coverDraft, userId: e.target.value })}
                    className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                  >
                    <option value="">{gt("Choose…")}</option>
                    {members.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {personLabel(member)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                  {gt("From")}
                  <input
                    type="datetime-local"
                    value={coverDraft.startsAt}
                    onChange={(e) => setCoverDraft({ ...coverDraft, startsAt: e.target.value })}
                    className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-on-surface-tertiary">
                  {gt("Until")}
                  <input
                    type="datetime-local"
                    value={coverDraft.endsAt}
                    onChange={(e) => setCoverDraft({ ...coverDraft, endsAt: e.target.value })}
                    className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-on-surface"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => saveCover(schedule.id)}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
                >
                  {gt("Save cover")}
                </button>
              </div>
            )}

            {expandedId === schedule.id && (
              <div className="mt-3 flex flex-col gap-3">
                <div>
                  <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-on-surface-faint">
                    {gt("Next shifts")}
                  </h4>
                  <ul className="flex flex-col gap-1 text-xs">
                    {(shifts[schedule.id] ?? []).map((shift) => (
                      <li key={shift.startsAt} className="flex flex-wrap gap-2">
                        <span className="text-on-surface">{personLabel(shift)}</span>
                        <span className="text-on-surface-faint">
                          {formatWindow(shift.startsAt, shift.endsAt)}
                        </span>
                      </li>
                    ))}
                    {(shifts[schedule.id]?.length ?? 0) === 0 && (
                      <li className="text-on-surface-faint">{gt("No upcoming shifts.")}</li>
                    )}
                  </ul>
                </div>

                {overrides.filter((o) => o.scheduleId === schedule.id).length > 0 && (
                  <div>
                    <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-on-surface-faint">
                      {gt("Covers")}
                    </h4>
                    <ul className="flex flex-col gap-1 text-xs">
                      {overrides
                        .filter((o) => o.scheduleId === schedule.id)
                        .map((override) => (
                          <li key={override.id} className="flex flex-wrap items-baseline gap-2">
                            <span className="text-on-surface">
                              {override.userName ?? override.userId}
                            </span>
                            <span className="text-on-surface-faint">
                              {formatWindow(override.startsAt, override.endsAt)}
                            </span>
                            {override.reason && (
                              <span className="text-on-surface-tertiary">{override.reason}</span>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await api.delete(
                                    `/api/org/${orgId}/on-call/overrides/${override.id}`,
                                  );
                                })
                              }
                              className="text-danger underline disabled:opacity-50"
                            >
                              {gt("Cancel")}
                            </button>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <T>
        <p className="text-xs text-on-surface-faint">
          Shift boundaries are calendar days in the rotation's own time zone, so a 09:00 handover
          stays at 09:00 through a daylight-saving change. A rotation that is off, empty, or has not
          started yet resolves to nobody — and a routing rule that names it still delivers to its
          other destinations, because an alert lost to a misconfigured rotation would be the worst
          thing this could do.
        </p>
      </T>
    </div>
  );
}
