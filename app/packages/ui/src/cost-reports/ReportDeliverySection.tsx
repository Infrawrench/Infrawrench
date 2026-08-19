import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";

import {
  REPORT_NOTIFICATION_CADENCES,
  REPORT_NOTIFICATION_CADENCE_LABELS,
  REPORT_NOTIFICATION_LIMITS,
  REPORT_NOTIFICATION_WEEKDAY_LABELS,
  describeReportSchedule,
  describeReportTargets,
  type ReportDeliveryTargets,
  type ReportNotification,
  type ReportNotificationCadence,
  type ReportNotificationInput,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import type { CostReportsClient } from "./types.js";

/**
 * The Delivery section on a report's detail page: this report's scheduled
 * sends to Slack, Teams and email — list, create, edit, delete, "Send now",
 * with the last attempt's status and error beside each schedule so a broken
 * delivery is visible exactly where it was configured.
 *
 * Follows the digest's delivery model (a schedule owns its destinations), not
 * alert routing. Writes are `org:settings:write` server-side; a host that
 * omits the mutating client methods renders this read-only.
 */
export interface ReportDeliverySectionProps {
  reportId: string;
  client: CostReportsClient;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Sending…",
  succeeded: "Delivered",
  partial: "Partially delivered",
  failed: "Failed",
  no_targets: "No live destinations",
};

function statusTone(status: string | null): string {
  if (status === "succeeded") return "text-success";
  if (status === "partial" || status === "failed" || status === "no_targets") return "text-danger";
  return "text-on-surface-faint";
}

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

export function ReportDeliverySection({ reportId, client }: ReportDeliverySectionProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [notifications, setNotifications] = useState<ReportNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ notification: ReportNotification | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const canRead = Boolean(client.listReportNotifications);
  const canManage = Boolean(
    client.createReportNotification &&
    client.updateReportNotification &&
    client.deleteReportNotification &&
    client.listReportDeliveryTargets,
  );

  const refresh = useCallback(async () => {
    if (!client.listReportNotifications) return;
    try {
      setNotifications(await client.listReportNotifications(reportId));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, reportId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!canRead) return null;

  async function deleteSchedule(notification: ReportNotification) {
    if (!window.confirm(gt("Delete this delivery schedule?"))) return;
    setBusyId(notification.id);
    setSendResult(null);
    try {
      await client.deleteReportNotification?.(reportId, notification.id);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function sendNow(notification: ReportNotification) {
    setBusyId(notification.id);
    setSendResult(null);
    try {
      const result = await client.sendReportNotificationNow?.(reportId, notification.id);
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
      setSendResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">{gt("Delivery")}</h3>
          <p className="text-xs text-on-surface-faint mt-0.5">
            {gt(
              "Send this report on a schedule to Slack, Microsoft Teams or email — the numbers and a link, no chart image. An empty period still sends, saying so.",
            )}
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => {
              setSendResult(null);
              setEditing({ notification: null });
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

      {notifications === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading schedules…")}
        </p>
      )}

      {notifications?.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt("No scheduled delivery. Nothing goes anywhere until you add one.")}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {(notifications ?? []).map((n) => {
          const statusLabel = n.lastStatus
            ? gtData(STATUS_LABELS[n.lastStatus] ?? n.lastStatus)
            : gt("Not sent yet");
          const lastSentSuffix =
            n.lastStatus && formatWhen(n.lastSentAt ?? null) && n.lastStatus !== "failed"
              ? gt(" · last sent {when}", { when: formatWhen(n.lastSentAt) ?? "" })
              : "";
          const nextSuffix =
            n.enabled && formatWhen(n.nextSendAt)
              ? gt(" · next {when}", { when: formatWhen(n.nextSendAt) ?? "" })
              : "";
          return (
            <li key={n.id} className="rounded-xl border border-border bg-surface-raised px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="block text-sm font-medium text-on-surface">
                    {describeReportSchedule(n)}
                    {!n.enabled && (
                      <span className="ml-2 text-xs text-on-surface-faint">{gt("paused")}</span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-on-surface-faint mt-0.5">
                    {gt("To {targets}", { targets: describeReportTargets(n) })}
                  </span>
                  <span className={`block text-xs mt-0.5 ${statusTone(n.lastStatus)}`}>
                    {statusLabel}
                    {lastSentSuffix}
                    {nextSuffix}
                  </span>
                  {n.lastError && (
                    <span role="alert" className="block text-xs text-danger mt-0.5">
                      {n.lastError}
                    </span>
                  )}
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-2 text-xs text-on-surface-faint">
                    <button
                      type="button"
                      disabled={busyId === n.id}
                      onClick={() => void sendNow(n)}
                      className="hover:text-on-surface-secondary underline disabled:opacity-50"
                    >
                      {gt("Send now")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === n.id}
                      onClick={() => {
                        setSendResult(null);
                        setEditing({ notification: n });
                      }}
                      className="hover:text-on-surface-secondary underline disabled:opacity-50"
                    >
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === n.id}
                      onClick={() => void deleteSchedule(n)}
                      className="hover:text-danger underline disabled:opacity-50"
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
        <ScheduleEditorModal
          reportId={reportId}
          client={client}
          notification={editing.notification}
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

/** Add or drop a destination id from a checkbox-backed selection. */
function toggleSelection(list: string[], set: (v: string[]) => void, id: string) {
  set(list.includes(id) ? list.filter((v) => v !== id) : [...list, id]);
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function ScheduleEditorModal({
  reportId,
  client,
  notification,
  onClose,
  onSaved,
}: {
  reportId: string;
  client: CostReportsClient;
  notification: ReportNotification | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [targets, setTargets] = useState<ReportDeliveryTargets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [cadence, setCadence] = useState<ReportNotificationCadence>(
    notification?.cadence ?? "weekly",
  );
  const [sendDay, setSendDay] = useState<number>(notification?.sendDay ?? 1);
  const [sendDayOfMonth, setSendDayOfMonth] = useState<number>(notification?.sendDayOfMonth ?? 1);
  const [hour, setHour] = useState<number>(notification?.hour ?? 8);
  const [timezone, setTimezone] = useState<string>(notification?.timezone ?? defaultTimezone());
  const [slackIds, setSlackIds] = useState<string[]>(notification?.slackChannelIds ?? []);
  const [teamsIds, setTeamsIds] = useState<string[]>(notification?.teamsWebhookIds ?? []);
  const [emails, setEmails] = useState<string>(
    () => notification?.emailRecipients.join(", ") ?? "",
  );
  const [enabled, setEnabled] = useState<boolean>(notification?.enabled ?? true);

  useEffect(() => {
    client
      .listReportDeliveryTargets?.(reportId)
      .then((t) => setTargets(t ?? null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, reportId]);

  const emailList = useMemo(
    () =>
      emails
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter((e) => e.length > 0),
    [emails],
  );

  // One membership set per list per render, so the checkbox rows below don't
  // rescan the selection array for every destination they draw.
  const slackSelected = new Set(slackIds);
  const teamsSelected = new Set(teamsIds);

  async function save() {
    setBusy(true);
    setError(null);
    const input: ReportNotificationInput = {
      cadence,
      sendDay,
      sendDayOfMonth,
      hour,
      timezone: timezone.trim() || "UTC",
      slackChannelIds: slackIds,
      teamsWebhookIds: teamsIds,
      emailRecipients: emailList,
      enabled,
    };
    try {
      if (notification) {
        await client.updateReportNotification?.(reportId, notification.id, input);
      } else {
        await client.createReportNotification?.(reportId, input);
      }
      await onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const selectClass =
    "rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface";

  return (
    <Modal
      onClose={onClose}
      ariaLabel={notification ? gt("Edit delivery schedule") : gt("New delivery schedule")}
    >
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[440px] p-6 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {notification ? gt("Edit delivery schedule") : gt("New delivery schedule")}
        </h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {gt(
            "The report runs server-side at each send: total for its window, change vs the period before, and its top groups — converted to your display currency where one is configured.",
          )}
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <label className="text-sm text-on-surface w-24 shrink-0" htmlFor="rd-cadence">
              {gt("Cadence")}
            </label>
            <select
              id="rd-cadence"
              className={selectClass}
              value={cadence}
              onChange={(e) => setCadence(e.target.value as ReportNotificationCadence)}
            >
              {REPORT_NOTIFICATION_CADENCES.map((c) => (
                <option key={c} value={c}>
                  {gtData(REPORT_NOTIFICATION_CADENCE_LABELS[c])}
                </option>
              ))}
            </select>
            {cadence === "weekly" && (
              <select
                aria-label={gt("Day of week")}
                className={selectClass}
                value={sendDay}
                onChange={(e) => setSendDay(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <option key={d} value={d}>
                    {gtData(REPORT_NOTIFICATION_WEEKDAY_LABELS[d] ?? String(d))}
                  </option>
                ))}
              </select>
            )}
            {cadence === "monthly" && (
              <select
                aria-label={gt("Day of month")}
                className={selectClass}
                value={sendDayOfMonth}
                onChange={(e) => setSendDayOfMonth(Number(e.target.value))}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d === 31 ? gt("31 (month end)") : d}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-on-surface w-24 shrink-0" htmlFor="rd-hour">
              {gt("At")}
            </label>
            <select
              id="rd-hour"
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
              <legend className="text-sm text-on-surface mb-1">{gt("Slack channels")}</legend>
              <div className="flex flex-col gap-1">
                {targets.slackChannels.map((ch) => (
                  <label key={ch.id} className="flex items-center gap-2 text-sm text-on-surface">
                    <input
                      type="checkbox"
                      checked={slackSelected.has(ch.id)}
                      onChange={() => toggleSelection(slackIds, setSlackIds, ch.id)}
                    />
                    <span className="truncate">{ch.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {targets && targets.teamsWebhooks.length > 0 && (
            <fieldset>
              <legend className="text-sm text-on-surface mb-1">{gt("Microsoft Teams")}</legend>
              <div className="flex flex-col gap-1">
                {targets.teamsWebhooks.map((w) => (
                  <label key={w.id} className="flex items-center gap-2 text-sm text-on-surface">
                    <input
                      type="checkbox"
                      checked={teamsSelected.has(w.id)}
                      onChange={() => toggleSelection(teamsIds, setTeamsIds, w.id)}
                    />
                    <span className="truncate">{w.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <div>
            <label className="block text-sm text-on-surface mb-1" htmlFor="rd-emails">
              {gt("Email recipients")}
            </label>
            <textarea
              id="rd-emails"
              className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
              rows={2}
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              // i18n-ignore: example email addresses
              placeholder="finance@example.com, cfo@example.com"
            />
            <p className="text-xs text-on-surface-faint mt-0.5">
              {gt("Comma-separated, up to {max}.", {
                max: REPORT_NOTIFICATION_LIMITS.maxEmailRecipients,
              })}
              {targets && !targets.emailAvailable
                ? gt(
                    " This deployment has no mail provider configured — addresses will be saved but nothing will be delivered to them.",
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
            className="rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-on-surface hover:border-border-strong disabled:opacity-50"
          >
            {notification ? gt("Save") : gt("Create")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
