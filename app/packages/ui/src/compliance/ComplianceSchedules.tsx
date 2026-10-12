import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  COMPLIANCE_PACK_CADENCES,
  COMPLIANCE_PACK_SCHEDULE_LIMITS,
  type ComplianceFrameworkSummary,
  type CompliancePackCadence,
  type CompliancePackSchedule,
  type CompliancePackScheduleInput,
  type ReportDeliveryTargets,
} from "@infrawrench/client-core";

import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import type { ComplianceClient } from "./types.js";

function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(status: string | null): string {
  if (status === "succeeded") return "text-success";
  if (status === "partial" || status === "failed" || status === "no_targets") return "text-danger";
  return "text-on-surface-faint";
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function useCadenceLabel(): (cadence: CompliancePackCadence) => string {
  const gt = useGT();
  return (cadence) => (cadence === "quarterly" ? gt("Quarterly") : gt("Monthly"));
}

function useLastStatusLabel(): (status: string | null) => string {
  const gt = useGT();
  return (status) => {
    switch (status) {
      case null:
        return gt("Not sent yet");
      case "pending":
        return gt("Sending…");
      case "succeeded":
        return gt("Delivered");
      case "partial":
        return gt("Partially delivered");
      case "failed":
        return gt("Failed");
      case "no_targets":
        return gt("No live destinations");
      default:
        return status;
    }
  };
}

export interface ComplianceSchedulesProps {
  client: ComplianceClient;
  frameworks: readonly ComplianceFrameworkSummary[];
  /** The framework the tab is on: the list shows its schedules and new ones default to it. */
  frameworkId: string;
}

/**
 * Scheduled evidence packs for one framework: list, create, edit, delete,
 * "Send now". A pack fires monthly (covering the previous month) or
 * quarterly (the previous quarter), so the cadence here is only those two,
 * unlike a report's delivery schedule. Writes are `org:settings:write`
 * server-side; a host that omits them renders the list read-only.
 */
export function ComplianceSchedules({ client, frameworks, frameworkId }: ComplianceSchedulesProps) {
  const gt = useGT();
  const gtData = useDataString();
  const cadenceLabel = useCadenceLabel();
  const lastStatusLabel = useLastStatusLabel();
  const [schedules, setSchedules] = useState<CompliancePackSchedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ schedule: CompliancePackSchedule | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const canManage = Boolean(
    client.createSchedule && client.updateSchedule && client.deleteSchedule && client.getTargets,
  );

  const refresh = useCallback(async () => {
    if (!client.listSchedules) return;
    try {
      setSchedules(await client.listSchedules(frameworkId));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, frameworkId]);

  useEffect(() => {
    setSchedules(null);
    void refresh();
  }, [refresh]);

  async function remove(schedule: CompliancePackSchedule) {
    if (!window.confirm(gt("Delete this evidence pack schedule?"))) return;
    setBusyId(schedule.id);
    setSendResult(null);
    try {
      await client.deleteSchedule?.(schedule.id);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function sendNow(schedule: CompliancePackSchedule) {
    setBusyId(schedule.id);
    setSendResult(null);
    try {
      const result = await client.sendScheduleNow?.(schedule.id);
      if (result) {
        setSendResult(
          gt("Sent to {succeeded} of {attempted} destination(s).", {
            succeeded: result.succeeded,
            attempted: result.attempted,
          }),
        );
      }
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  function describeTargets(s: CompliancePackSchedule): string {
    const parts: string[] = [];
    if (s.slackChannelIds.length > 0)
      parts.push(gt("{count} Slack channel(s)", { count: s.slackChannelIds.length }));
    if (s.teamsWebhookIds.length > 0)
      parts.push(gt("{count} Teams webhook(s)", { count: s.teamsWebhookIds.length }));
    if (s.emailRecipients.length > 0)
      parts.push(gt("{count} email(s)", { count: s.emailRecipients.length }));
    return parts.length > 0 ? parts.join(", ") : gt("no destinations");
  }

  if (!client.listSchedules) return null;

  return (
    <section className="mt-8 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Pack schedules")}</h2>
          <p className="mt-0.5 text-xs text-on-surface-faint">
            {gt(
              "Each delivery builds the pack for the previous month or quarter and sends it to the destinations below.",
            )}
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => {
              setSendResult(null);
              setEditing({ schedule: null });
            }}
            className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {gt("New schedule")}
          </button>
        )}
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}{" "}
          <button
            type="button"
            onClick={() => {
              setError(null);
              void refresh();
            }}
            className="underline"
          >
            {gt("Retry")}
          </button>
        </div>
      )}
      {sendResult !== null && (
        <div role="status" className="text-xs text-success">
          {sendResult}
        </div>
      )}
      {schedules === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading schedules…")}
        </p>
      )}
      {schedules?.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt("No scheduled packs for this framework.")}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {(schedules ?? []).map((s) => {
          const lastSent = formatWhen(s.lastSentAt);
          const next = s.enabled ? formatWhen(s.nextSendAt) : null;
          return (
            <li key={s.id} className="rounded-xl border border-border bg-surface-raised px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="block text-sm font-medium text-on-surface">
                    {gt("{cadence}, day {day} at {hour}:00 {timezone}", {
                      cadence: cadenceLabel(s.cadence),
                      day: s.sendDayOfMonth,
                      hour: String(s.hour).padStart(2, "0"),
                      timezone: s.timezone,
                    })}
                    {!s.enabled && (
                      <span className="ml-2 text-xs text-on-surface-faint">{gt("paused")}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-on-surface-faint">
                    {gt("To {targets}", { targets: describeTargets(s) })}
                  </span>
                  <span className={`mt-0.5 block text-xs ${statusTone(s.lastStatus)}`}>
                    {lastStatusLabel(s.lastStatus)}
                    {lastSent && s.lastStatus && s.lastStatus !== "failed"
                      ? gt(" · last sent {when}", { when: lastSent })
                      : ""}
                    {next ? gt(" · next {when}", { when: next }) : ""}
                  </span>
                  {s.lastError && (
                    <span role="alert" className="mt-0.5 block text-xs text-danger">
                      {gtData(s.lastError)}
                    </span>
                  )}
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-2 text-xs text-on-surface-faint">
                    {client.sendScheduleNow && (
                      <button
                        type="button"
                        disabled={busyId === s.id}
                        onClick={() => void sendNow(s)}
                        className="underline hover:text-on-surface-secondary disabled:opacity-50"
                      >
                        {gt("Send now")}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busyId === s.id}
                      onClick={() => {
                        setSendResult(null);
                        setEditing({ schedule: s });
                      }}
                      className="underline hover:text-on-surface-secondary disabled:opacity-50"
                    >
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === s.id}
                      onClick={() => void remove(s)}
                      className="underline hover:text-danger disabled:opacity-50"
                    >
                      {gt("Delete")}
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {editing && canManage && (
        <ScheduleEditor
          client={client}
          frameworks={frameworks}
          defaultFrameworkId={frameworkId}
          schedule={editing.schedule}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

function ScheduleEditor({
  client,
  frameworks,
  defaultFrameworkId,
  schedule,
  onClose,
  onSaved,
}: {
  client: ComplianceClient;
  frameworks: readonly ComplianceFrameworkSummary[];
  defaultFrameworkId: string;
  schedule: CompliancePackSchedule | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const cadenceLabel = useCadenceLabel();
  const idPrefix = useId();
  const frameworkFieldId = `${idPrefix}-framework`;
  const cadenceId = `${idPrefix}-cadence`;
  const hourId = `${idPrefix}-hour`;
  const emailsId = `${idPrefix}-emails`;
  const [targets, setTargets] = useState<ReportDeliveryTargets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [frameworkId, setFrameworkId] = useState(schedule?.frameworkId ?? defaultFrameworkId);
  const [cadence, setCadence] = useState<CompliancePackCadence>(schedule?.cadence ?? "quarterly");
  const [sendDayOfMonth, setSendDayOfMonth] = useState<number>(schedule?.sendDayOfMonth ?? 3);
  const [hour, setHour] = useState<number>(schedule?.hour ?? 8);
  const [timezone, setTimezone] = useState<string>(schedule?.timezone ?? defaultTimezone());
  const [slackIds, setSlackIds] = useState<string[]>(schedule?.slackChannelIds ?? []);
  const [teamsIds, setTeamsIds] = useState<string[]>(schedule?.teamsWebhookIds ?? []);
  const [emails, setEmails] = useState<string>(() => schedule?.emailRecipients.join(", ") ?? "");
  const [enabled, setEnabled] = useState<boolean>(schedule?.enabled ?? true);

  useEffect(() => {
    client
      .getTargets?.()
      .then((t) => setTargets(t))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  const emailList = useMemo(
    () =>
      emails
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter((e) => e.length > 0),
    [emails],
  );

  const slackSelected = new Set(slackIds);
  const teamsSelected = new Set(teamsIds);

  function toggle(list: string[], set: (v: string[]) => void, id: string) {
    set(list.includes(id) ? list.filter((v) => v !== id) : [...list, id]);
  }

  async function save() {
    setBusy(true);
    setError(null);
    const input: CompliancePackScheduleInput = {
      frameworkId,
      cadence,
      sendDayOfMonth,
      hour,
      timezone: timezone.trim() || "UTC",
      emailRecipients: emailList,
      slackChannelIds: slackIds,
      teamsWebhookIds: teamsIds,
      enabled,
    };
    try {
      if (schedule) await client.updateSchedule?.(schedule.id, input);
      else await client.createSchedule?.(input);
      await onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const selectClass =
    "rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface";
  const title = schedule ? gt("Edit evidence pack schedule") : gt("New evidence pack schedule");

  return (
    <Modal onClose={onClose} ariaLabel={title}>
      <div className="max-h-[85vh] w-[460px] overflow-y-auto rounded-xl border border-border-strong bg-surface-raised p-6 shadow-2xl">
        <h2 className="mb-1 text-base font-semibold text-on-surface">{title}</h2>
        <p className="mb-4 text-xs text-on-surface-faint">
          {gt(
            "A monthly pack covers the previous calendar month; a quarterly pack fires in January, April, July and October and covers the previous quarter.",
          )}
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <label className="w-24 shrink-0 text-sm text-on-surface" htmlFor={frameworkFieldId}>
              {gt("Framework")}
            </label>
            <select
              id={frameworkFieldId}
              className={`${selectClass} flex-1 min-w-0`}
              value={frameworkId}
              onChange={(e) => setFrameworkId(e.target.value)}
            >
              {frameworks.map((f) => (
                <option key={f.id} value={f.id}>
                  {gtData(f.name)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="w-24 shrink-0 text-sm text-on-surface" htmlFor={cadenceId}>
              {gt("Cadence")}
            </label>
            <select
              id={cadenceId}
              className={selectClass}
              value={cadence}
              onChange={(e) => setCadence(e.target.value as CompliancePackCadence)}
            >
              {COMPLIANCE_PACK_CADENCES.map((c) => (
                <option key={c} value={c}>
                  {cadenceLabel(c)}
                </option>
              ))}
            </select>
            <select
              aria-label={gt("Day of month")}
              className={selectClass}
              value={sendDayOfMonth}
              onChange={(e) => setSendDayOfMonth(Number(e.target.value))}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d === 31 ? gt("31 (month end)") : gt("Day {day}", { day: d })}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="w-24 shrink-0 text-sm text-on-surface" htmlFor={hourId}>
              {gt("At")}
            </label>
            <select
              id={hourId}
              className={selectClass}
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
            <input
              aria-label={gt("Time zone")}
              className={`${selectClass} flex-1 min-w-0`}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              // i18n-ignore: IANA timezone identifier
              placeholder="Europe/Berlin"
            />
          </div>

          {targets === null && error === null && (
            <p role="status" className="text-xs text-on-surface-faint">
              {gt("Loading destinations…")}
            </p>
          )}

          {targets && targets.slackChannels.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm text-on-surface">{gt("Slack channels")}</legend>
              <div className="flex flex-col gap-1">
                {targets.slackChannels.map((ch) => (
                  <label key={ch.id} className="flex items-center gap-2 text-sm text-on-surface">
                    <input
                      type="checkbox"
                      checked={slackSelected.has(ch.id)}
                      onChange={() => toggle(slackIds, setSlackIds, ch.id)}
                    />
                    <span className="truncate">{ch.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {targets && targets.teamsWebhooks.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm text-on-surface">{gt("Microsoft Teams")}</legend>
              <div className="flex flex-col gap-1">
                {targets.teamsWebhooks.map((w) => (
                  <label key={w.id} className="flex items-center gap-2 text-sm text-on-surface">
                    <input
                      type="checkbox"
                      checked={teamsSelected.has(w.id)}
                      onChange={() => toggle(teamsIds, setTeamsIds, w.id)}
                    />
                    <span className="truncate">{w.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <div>
            <label className="mb-1 block text-sm text-on-surface" htmlFor={emailsId}>
              {gt("Email recipients")}
            </label>
            <textarea
              id={emailsId}
              className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
              rows={2}
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              // i18n-ignore: example email addresses
              placeholder="security@example.com, auditor@example.com"
            />
            <p className="mt-0.5 text-xs text-on-surface-faint">
              {gt("Comma-separated, up to {max}.", {
                max: COMPLIANCE_PACK_SCHEDULE_LIMITS.maxEmailRecipients,
              })}
              {targets && !targets.emailAvailable
                ? gt(
                    " This deployment has no mail provider configured, so addresses are saved but nothing is delivered.",
                  )
                : ""}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {gt("Enabled")}
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-on-surface disabled:opacity-50"
          >
            {schedule ? gt("Save") : gt("Create")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
